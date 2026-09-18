// routes/inventory.js
const express = require('express');
const router = express.Router();
const { all, get, transaction } = require('../db/database');
const { authenticate, authorize } = require('../middleware/auth');
const { logAction } = require('../utils/auditLog');
const { getAllowedLocationIds, buildLocationFilter } = require('../utils/locationPermissions');
const { getProductStockRows, evaluateLowStock, getAllLowStockProducts } = require('../utils/stockAlerts');
const { applyStockAdjustment } = require('../utils/stockAdjustment');
const eventBus = require('../utils/eventBus');

router.use(authenticate);

// GET /api/inventory/overview
router.get('/overview', async (req, res) => {
  const allowedIds = await getAllowedLocationIds(req.user);
  const { location_id } = req.query;

  // لو المستخدم حدّد موقع معين بالفلتر، تأكد إنه مسموح له
  if (location_id && allowedIds && !allowedIds.includes(Number(location_id)))
    return res.status(403).json({ error: 'ليس لديك صلاحية لهذا الموقع' });

  let locFilter = buildLocationFilter(allowedIds, 'l');
  const params = [];
  if (location_id) {
    locFilter += ` AND l.id = ?`;
    params.push(location_id);
  }

  const rows = await all(`
    SELECT p.id as product_id, p.sku, p.barcode, p.name, p.unit, p.min_stock_threshold, p.image_path,
           l.id as location_id, l.name as location_name, l.type as location_type,
           COALESCE(i.quantity, 0) as quantity
    FROM products p
    CROSS JOIN locations l
    LEFT JOIN inventory i ON i.product_id = p.id AND i.location_id = l.id
    WHERE p.is_active = 1 AND l.is_active = 1 ${locFilter}
    ORDER BY p.name ASC, l.id ASC
  `, params);

  res.json({ inventory: rows });
});

// GET /api/inventory/low-stock
router.get('/low-stock', async (req, res) => {
  const allowedIds = await getAllowedLocationIds(req.user);
  const locFilter = buildLocationFilter(allowedIds, 'l');
  const lowStockItems = await getAllLowStockProducts(locFilter, []);
  res.json({ low_stock_products: lowStockItems, count: lowStockItems.length });
});

// POST /api/inventory/adjust
// يدعم 3 أنواع حركة (متوافقة مع واجهة المستخدم):
//   in         → إضافة الكمية المُدخلة إلى الرصيد الحالي (وارد)
//   out        → خصم الكمية المُدخلة من الرصيد الحالي (صادر) — لا يجوز أن ينتج رصيد سالب
//   adjustment → استبدال الرصيد الحالي بالكامل بالرقم المُدخل (تسوية مخزون)
router.post('/adjust', authorize('admin', 'manager', 'warehouse'), async (req, res) => {
  const { product_id, location_id, notes } = req.body;
  const movement_type = req.body.movement_type || 'adjustment';
  // توافق مع أي استدعاء قديم كان بيبعت new_quantity مباشرة كتسوية مطلقة
  const rawQty = req.body.quantity !== undefined ? req.body.quantity : req.body.new_quantity;

  if (!product_id || !location_id || rawQty === undefined || rawQty === null || rawQty === '')
    return res.status(400).json({ error: 'يرجى تحديد المنتج والموقع والكمية' });

  if (!['in', 'out', 'adjustment'].includes(movement_type))
    return res.status(400).json({ error: 'نوع الحركة غير صحيح' });

  // التحقق من صلاحية الموقع
  const allowedIds = await getAllowedLocationIds(req.user);
  if (allowedIds && !allowedIds.includes(Number(location_id)))
    return res.status(403).json({ error: 'ليس لديك صلاحية للتعديل في هذا الموقع' });

  const inputQty = parseFloat(rawQty);
  if (isNaN(inputQty) || inputQty < 0)
    return res.status(400).json({ error: 'الكمية يجب أن تكون رقماً أكبر من أو يساوي صفر' });

  const product = await get(`SELECT * FROM products WHERE id = ?`, [product_id]);
  if (!product) return res.status(404).json({ error: 'المنتج غير موجود' });
  if (!product.allow_fractional_qty && inputQty % 1 !== 0)
    return res.status(400).json({ error: 'هذا المنتج لا يسمح بكميات كسرية' });

  const result = await transaction(async () => {
    return applyStockAdjustment({
      product, location_id, movement_type, inputQty,
      notes, user_id: req.user.id, reference_type: 'manual_adjustment',
    });
  });

  await logAction(req.user.id, 'adjust_stock', 'product', product_id, { location_id, movement_type, before: result.qtyBefore, after: result.newQty });
  const location = await get(`SELECT name FROM locations WHERE id=?`, [location_id]);
  eventBus.emit('inventory.adjusted', {
    product, location_name: location?.name, movement_type,
    quantity_before: result.qtyBefore, quantity_after: result.newQty, notes, actorName: req.user.full_name,
  });
  res.json({ message: 'تم تعديل الكمية بنجاح', quantity_before: result.qtyBefore, quantity_after: result.newQty });
});

// GET /api/inventory/movements
router.get('/movements', async (req, res) => {
  const allowedIds = await getAllowedLocationIds(req.user);
  const { product_id, location_id, movement_type, from_date, to_date } = req.query;

  if (location_id && allowedIds && !allowedIds.includes(Number(location_id)))
    return res.status(403).json({ error: 'ليس لديك صلاحية لهذا الموقع' });

  const locFilter = buildLocationFilter(allowedIds, 'l');
  let sql = `
    SELECT sm.*, p.name as product_name, p.sku, l.name as location_name, u.full_name as user_name
    FROM stock_movements sm
    JOIN products p ON sm.product_id = p.id
    JOIN locations l ON sm.location_id = l.id
    LEFT JOIN users u ON sm.user_id = u.id
    WHERE 1=1 ${locFilter}
  `;
  const params = [];
  if (product_id)     { sql += ` AND sm.product_id = ?`;    params.push(product_id); }
  if (location_id)    { sql += ` AND sm.location_id = ?`;   params.push(location_id); }
  if (movement_type)  { sql += ` AND sm.movement_type = ?`; params.push(movement_type); }
  if (from_date)      { sql += ` AND sm.created_at >= ?`;   params.push(from_date); }
  if (to_date)        { sql += ` AND sm.created_at <= ?`;   params.push(to_date); }
  sql += ` ORDER BY sm.created_at DESC LIMIT 500`;

  res.json({ movements: await all(sql, params) });
});

module.exports = router;