// routes/inventoryCounts.js
//
// جرد المخزون الفعلي — مسودّات جرد منعزلة تماماً عن جداول المخزون الحقيقية
// (inventory / stock_movements). لا يتغيّر رصيد فعلي إلا عند "اعتماد" الجرد
// (finalize)، وبس وقتها بيتم استدعاء نفس آلية تعديل المخزون المستخدمة في
// POST /api/inventory/adjust (عبر utils/stockAdjustment.js) — نفس المنطق
// المُدقَّق بالظبط، مش نسخة موازية منه.
//
// الصلاحيات: نفس مجموعة الأدوار المستخدمة بالفعل في /api/inventory/adjust
// (admin, manager, warehouse) — العدّ والاعتماد هما نفس درجة الثقة اللي
// النظام بيمنحها بالفعل لتعديل المخزون مباشرة، فمفيش داعي لقاعدة صلاحيات
// جديدة أشد.
const express = require('express');
const router = express.Router();
const { all, get, run, insert, transaction } = require('../db/database');
const { authenticate, authorize } = require('../middleware/auth');
const { logAction } = require('../utils/auditLog');
const { getAllowedLocationIds } = require('../utils/locationPermissions');
const { applyStockAdjustment } = require('../utils/stockAdjustment');
const eventBus = require('../utils/eventBus');

router.use(authenticate);
router.use(authorize('admin', 'manager', 'warehouse'));

async function assertLocationAllowed(user, location_id) {
  const allowedIds = await getAllowedLocationIds(user);
  if (allowedIds && !allowedIds.includes(Number(location_id))) {
    const err = new Error('ليس لديك صلاحية لهذا الموقع');
    err.status = 403;
    throw err;
  }
}

// GET /api/inventory-counts/sessions — قائمة الجلسات (لوحة المتابعة/الأدمن)
router.get('/sessions', async (req, res) => {
  const allowedIds = await getAllowedLocationIds(req.user);
  const { status } = req.query;
  let sql = `
    SELECT s.*, l.name as location_name, l.type as location_type,
           u1.full_name as started_by_name, u2.full_name as completed_by_name,
           (SELECT COUNT(*) FROM inventory_count_entries e WHERE e.session_id = s.id) as counted_count,
           (SELECT COUNT(*) FROM products p WHERE p.is_active = 1) as total_products
    FROM inventory_count_sessions s
    JOIN locations l ON l.id = s.location_id
    LEFT JOIN users u1 ON u1.id = s.started_by
    LEFT JOIN users u2 ON u2.id = s.completed_by
    WHERE 1=1
  `;
  const params = [];
  if (allowedIds) { sql += ` AND s.location_id IN (${allowedIds.join(',') || '-1'})`; }
  if (status) { sql += ` AND s.status = ?`; params.push(status); }
  sql += ` ORDER BY s.created_at DESC LIMIT 100`;
  res.json({ sessions: await all(sql, params) });
});

// GET /api/inventory-counts/sessions/active — الجلسة الشغّالة حالياً لكل موقع (لو فيه)
router.get('/sessions/active', async (req, res) => {
  const allowedIds = await getAllowedLocationIds(req.user);
  let sql = `
    SELECT s.*, l.name as location_name
    FROM inventory_count_sessions s
    JOIN locations l ON l.id = s.location_id
    WHERE s.status = 'in_progress'
  `;
  if (allowedIds) sql += ` AND s.location_id IN (${allowedIds.join(',') || '-1'})`;
  res.json({ sessions: await all(sql, []) });
});

// POST /api/inventory-counts/sessions — بدء جلسة جرد جديدة لمخزن
router.post('/sessions', async (req, res) => {
  const { location_id, notes } = req.body;
  if (!location_id) return res.status(400).json({ error: 'يرجى تحديد المخزن' });

  await assertLocationAllowed(req.user, location_id);

  const location = await get(`SELECT * FROM locations WHERE id = ? AND is_active = 1`, [location_id]);
  if (!location) return res.status(404).json({ error: 'المخزن غير موجود' });

  // الفهرس الفريد الجزئي في قاعدة البيانات (idx_one_active_session_per_location)
  // هو الضمان الحقيقي ضد أي تسابق (race condition)؛ الفحص هنا فقط لإعطاء
  // رسالة خطأ عربية واضحة بدل رسالة قاعدة بيانات تقنية لو كان فيه جلسة شغالة أصلاً.
  const existing = await get(`SELECT id FROM inventory_count_sessions WHERE location_id = ? AND status = 'in_progress'`, [location_id]);
  if (existing) return res.status(409).json({ error: 'يوجد جرد شغّال بالفعل لهذا المخزن', session_id: existing.id });

  let sessionId;
  try {
    sessionId = await insert(
      `INSERT INTO inventory_count_sessions (location_id, started_by, notes) VALUES (?, ?, ?)`,
      [location_id, req.user.id, notes || null]
    );
  } catch (e) {
    // لو حصل تسابق فعلي ووصل طلبين في نفس اللحظة، الفهرس الفريد في قاعدة
    // البيانات هيرفض التاني — نرجّع نفس رسالة "جلسة شغالة بالفعل" بدل خطأ تقني
    return res.status(409).json({ error: 'يوجد جرد شغّال بالفعل لهذا المخزن' });
  }

  await logAction(req.user.id, 'start_inventory_count', 'inventory_count_session', sessionId, { location_id });
  res.status(201).json({ message: 'تم بدء جلسة الجرد', session_id: sessionId });
});

// GET /api/inventory-counts/sessions/:id — تفاصيل الجلسة + ملخص التقدّم
router.get('/sessions/:id', async (req, res) => {
  const session = await get(`
    SELECT s.*, l.name as location_name, l.type as location_type,
           u1.full_name as started_by_name, u2.full_name as completed_by_name
    FROM inventory_count_sessions s
    JOIN locations l ON l.id = s.location_id
    LEFT JOIN users u1 ON u1.id = s.started_by
    LEFT JOIN users u2 ON u2.id = s.completed_by
    WHERE s.id = ?
  `, [req.params.id]);
  if (!session) return res.status(404).json({ error: 'الجلسة غير موجودة' });
  await assertLocationAllowed(req.user, session.location_id);

  const totalRow = await get(`SELECT COUNT(*) as c FROM products WHERE is_active = 1`, []);
  const countedRow = await get(`SELECT COUNT(*) as c FROM inventory_count_entries WHERE session_id = ?`, [req.params.id]);

  res.json({
    session,
    progress: {
      total_products: totalRow.c,
      counted_products: countedRow.c,
      remaining_products: totalRow.c - countedRow.c,
    },
  });
});

// POST /api/inventory-counts/sessions/:id/entries — حفظ/تحديث عدّ منتج
// (upsert — لو المنتج اتعدّ قبل كده في نفس الجلسة، بيتحدّث نفس الصف؛
// مفيش صف مكرر أبداً بفضل UNIQUE(session_id, product_id))
router.post('/sessions/:id/entries', async (req, res) => {
  const { product_id, counted_qty } = req.body;
  if (!product_id || counted_qty === undefined || counted_qty === null || counted_qty === '')
    return res.status(400).json({ error: 'يرجى تحديد المنتج والكمية المعدودة' });

  const qty = parseFloat(counted_qty);
  if (isNaN(qty) || qty < 0)
    return res.status(400).json({ error: 'الكمية يجب أن تكون رقماً أكبر من أو يساوي صفر' });

  const session = await get(`SELECT * FROM inventory_count_sessions WHERE id = ?`, [req.params.id]);
  if (!session) return res.status(404).json({ error: 'الجلسة غير موجودة' });
  if (session.status !== 'in_progress')
    return res.status(400).json({ error: 'الجلسة دي مش شغّالة حالياً — مينفعش تضاف لها عدّات جديدة' });
  await assertLocationAllowed(req.user, session.location_id);

  const product = await get(`SELECT * FROM products WHERE id = ? AND is_active = 1`, [product_id]);
  if (!product) return res.status(404).json({ error: 'المنتج غير موجود' });
  if (!product.allow_fractional_qty && qty % 1 !== 0)
    return res.status(400).json({ error: 'هذا المنتج لا يسمح بكميات كسرية' });

  const existingEntry = await get(
    `SELECT * FROM inventory_count_entries WHERE session_id = ? AND product_id = ?`,
    [req.params.id, product_id]
  );

  if (existingEntry) {
    await run(
      `UPDATE inventory_count_entries SET counted_qty = ?, counted_by = ?, updated_at = datetime('now')
       WHERE session_id = ? AND product_id = ?`,
      [qty, req.user.id, req.params.id, product_id]
    );
  } else {
    // system_qty_snapshot بيتسجّل مرة واحدة بس — أول عدّة للمنتج ده في الجلسة
    // دي — عشان تفضل ثابتة كمرجع "الرصيد وقت بداية الجرد"، حتى لو اتعاد عدّ
    // نفس المنتج تاني بعدين في نفس الجلسة.
    const inv = await get(`SELECT quantity FROM inventory WHERE product_id = ? AND location_id = ?`, [product_id, session.location_id]);
    const systemQty = inv ? inv.quantity : 0;
    await insert(
      `INSERT INTO inventory_count_entries (session_id, product_id, system_qty_snapshot, counted_qty, counted_by)
       VALUES (?, ?, ?, ?, ?)`,
      [req.params.id, product_id, systemQty, qty, req.user.id]
    );
  }

  await run(`UPDATE inventory_count_sessions SET updated_at = datetime('now') WHERE id = ?`, [req.params.id]);

  res.json({
    message: existingEntry ? 'تم تحديث العدّ' : 'تم حفظ العدّ',
    is_recount: !!existingEntry,
  });
});

// GET /api/inventory-counts/sessions/:id/review — مراجعة الجرد بفلاتر
// filter: all | uncounted | counted | needs_review
router.get('/sessions/:id/review', async (req, res) => {
  const session = await get(`SELECT * FROM inventory_count_sessions WHERE id = ?`, [req.params.id]);
  if (!session) return res.status(404).json({ error: 'الجلسة غير موجودة' });
  await assertLocationAllowed(req.user, session.location_id);

  const filter = req.query.filter || 'all';

  // منتجات معدودة بالفعل في الجلسة دي — مع الرصيد الحيّ الحالي (لمقارنته
  // بالـ snapshot وقت العدّ، ولتحديد "هل النظام اتغيّر من وقت العدّ؟")
  const counted = await all(`
    SELECT e.*, p.name as product_name, p.sku, p.barcode, p.unit, p.image_path,
           i.quantity as current_system_qty
    FROM inventory_count_entries e
    JOIN products p ON p.id = e.product_id
    LEFT JOIN inventory i ON i.product_id = e.product_id AND i.location_id = ?
    WHERE e.session_id = ?
    ORDER BY e.updated_at DESC
  `, [session.location_id, req.params.id]);

  const enriched = counted.map(row => {
    const currentQty = row.current_system_qty ?? 0;
    return {
      ...row,
      deviation: row.counted_qty - row.system_qty_snapshot,
      needs_review: Math.abs(row.counted_qty - row.system_qty_snapshot) >= 1 &&
                    (row.system_qty_snapshot === 0 ? true : Math.abs(row.counted_qty - row.system_qty_snapshot) / row.system_qty_snapshot >= 0.2),
      system_qty_changed_since_count: currentQty !== row.system_qty_snapshot,
    };
  });

  if (filter === 'needs_review') {
    return res.json({ entries: enriched.filter(r => r.needs_review), filter });
  }
  if (filter === 'counted') {
    return res.json({ entries: enriched, filter });
  }
  if (filter === 'uncounted') {
    const uncounted = await all(`
      SELECT p.id as product_id, p.name as product_name, p.sku, p.barcode, p.unit, p.image_path
      FROM products p
      WHERE p.is_active = 1
        AND p.id NOT IN (SELECT product_id FROM inventory_count_entries WHERE session_id = ?)
      ORDER BY p.name ASC
    `, [req.params.id]);
    return res.json({ entries: uncounted, filter });
  }

  // all: نرجّع الاتنين مع بعض
  const uncounted = await all(`
    SELECT p.id as product_id, p.name as product_name, p.sku, p.barcode, p.unit, p.image_path
    FROM products p
    WHERE p.is_active = 1
      AND p.id NOT IN (SELECT product_id FROM inventory_count_entries WHERE session_id = ?)
    ORDER BY p.name ASC
  `, [req.params.id]);
  res.json({ counted: enriched, uncounted, filter });
});

// POST /api/inventory-counts/sessions/:id/finalize — اعتماد الجرد نهائياً
// هنا بس بيتغيّر رصيد المخزون الحقيقي — بشكل معاملة واحدة ذرّية (atomic):
// لكل منتج معدود، نقرا الرصيد *الحيّ الحالي* (مش الـ snapshot القديم) جوه
// قفل صف (FOR UPDATE)، ونقارنه بالكمية المعدودة، ونعدّل بس لو فيه فرق فعلي.
// لو أي تعديل فشل، الترانزاكشن كله بيتراجع (rollback) ومفيش جزء يتنفذ لوحده.
router.post('/sessions/:id/finalize', async (req, res) => {
  const session = await get(`SELECT * FROM inventory_count_sessions WHERE id = ?`, [req.params.id]);
  if (!session) return res.status(404).json({ error: 'الجلسة غير موجودة' });
  if (session.status !== 'in_progress')
    return res.status(400).json({ error: 'الجلسة دي مُعتمدة أو ملغية بالفعل' });
  await assertLocationAllowed(req.user, session.location_id);

  const entries = await all(`
    SELECT e.session_id, e.product_id, e.system_qty_snapshot, e.counted_qty,
           p.allow_fractional_qty
    FROM inventory_count_entries e
    JOIN products p ON p.id = e.product_id
    WHERE e.session_id = ?
  `, [req.params.id]);

  if (entries.length === 0)
    return res.status(400).json({ error: 'لا يوجد أي منتج معدود في هذه الجلسة بعد' });

  const adjustments = await transaction(async () => {
    const applied = [];
    for (const entry of entries) {
      const product = { id: entry.product_id, allow_fractional_qty: entry.allow_fractional_qty };
      // بنمرّر movement_type: 'adjustment' فبيتم استبدال الرصيد بالكامل
      // بالكمية المعدودة — applyStockAdjustment بيقرا الرصيد الحيّ الحالي
      // بنفسه جوه FOR UPDATE، فمفيش اعتماد على الـ snapshot القديم هنا.
      const current = await get(`SELECT quantity FROM inventory WHERE product_id = ? AND location_id = ? FOR UPDATE`,
        [entry.product_id, session.location_id]);
      const currentQty = current ? current.quantity : 0;

      if (currentQty === entry.counted_qty) continue; // لا فرق — لا داعي لأي حركة مخزون (تدقيق نظيف بدون ضوضاء)

      const result = await applyStockAdjustment({
        product,
        location_id: session.location_id,
        movement_type: 'adjustment',
        inputQty: entry.counted_qty,
        notes: `جرد فعلي — جلسة #${session.id}`,
        user_id: req.user.id,
        reference_type: 'inventory_count',
      });
      applied.push({ product_id: entry.product_id, ...result });
    }

    await run(
      `UPDATE inventory_count_sessions SET status = 'completed', completed_by = ?, completed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
      [req.user.id, req.params.id]
    );

    return applied;
  });

  await logAction(req.user.id, 'finalize_inventory_count', 'inventory_count_session', session.id, {
    location_id: session.location_id, entries_counted: entries.length, adjustments_made: adjustments.length,
  });
  eventBus.emit('inventory.count_finalized', {
    session_id: session.id, location_id: session.location_id,
    entries_counted: entries.length, adjustments_made: adjustments.length, actorName: req.user.full_name,
  });

  res.json({
    message: 'تم اعتماد الجرد بنجاح',
    entries_counted: entries.length,
    adjustments_made: adjustments.length,
  });
});

// POST /api/inventory-counts/sessions/:id/cancel — إلغاء جلسة (بدون أي تأثير على المخزون)
router.post('/sessions/:id/cancel', async (req, res) => {
  const session = await get(`SELECT * FROM inventory_count_sessions WHERE id = ?`, [req.params.id]);
  if (!session) return res.status(404).json({ error: 'الجلسة غير موجودة' });
  if (session.status !== 'in_progress')
    return res.status(400).json({ error: 'الجلسة دي مش شغّالة أصلاً' });
  await assertLocationAllowed(req.user, session.location_id);

  await run(`UPDATE inventory_count_sessions SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?`, [req.params.id]);
  await logAction(req.user.id, 'cancel_inventory_count', 'inventory_count_session', session.id, { location_id: session.location_id });
  res.json({ message: 'تم إلغاء جلسة الجرد' });
});

module.exports = router;
