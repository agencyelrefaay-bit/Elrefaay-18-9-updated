// routes/suppliers.js
const express = require('express');
const router  = express.Router();
const multer  = require('multer');
const XLSX    = require('xlsx');
const path    = require('path');
const fs      = require('fs');
const { all, get, run, insert, transaction } = require('../db/database');
const { authenticate, authorize }            = require('../middleware/auth');
const { logAction }                          = require('../utils/auditLog');
const { getSupplierBalance }                 = require('../utils/supplierLedger');
const { buildStatement }                     = require('../utils/statementEngine');

router.use(authenticate);

// ── توليد كود مورد تلقائي ──
const { nextDocumentNumber } = require('../utils/sequenceGenerator');
// تم استبدال مولّد COUNT(*) غير الآمن تحت التزامن بـ SEQUENCE ذرّي (راجع src/utils/sequenceGenerator.js)
async function genSupplierCode() {
  return nextDocumentNumber('supplier_code_seq', 'SUP', 4, async () => {
    const r = await get(`SELECT COUNT(*) as c FROM suppliers`);
    return (r?.c || 0) + 1;
  });
}

// ── GET /api/suppliers ──
router.get('/', async (req, res) => {
  const { search, is_active } = req.query;
  let sql = `SELECT * FROM suppliers WHERE 1=1`;
  const params = [];
  if (search) {
    sql += ` AND (name LIKE ? OR code LIKE ? OR phone LIKE ? OR contact_person LIKE ?)`;
    const t = `%${search}%`;
    params.push(t,t,t,t);
  }
  if (is_active !== undefined)
    sql += ` AND is_active = ${is_active === 'true' || is_active === '1' ? 1 : 0}`;
  sql += ` ORDER BY name ASC`;

  const supplierRows = await all(sql, params);
  const suppliers = await Promise.all(supplierRows.map(async s => ({
    ...s,
    is_active: !!s.is_active,
    balance: await getSupplierBalance(s.id),
  })));
  res.json({ suppliers, count: suppliers.length });
});

// ── GET /api/suppliers/:id ──
router.get('/:id', async (req, res) => {
  const s = await get(`SELECT * FROM suppliers WHERE id = ?`, [req.params.id]);
  if (!s) return res.status(404).json({ error: 'المورد غير موجود' });

  const relations = await all(`
    SELECT sr.*, sup.name as related_name, sup.code as related_code, sup.phone as related_phone
    FROM supplier_relations sr
    JOIN suppliers sup ON sr.related_supplier_id = sup.id
    WHERE sr.supplier_id = ?
  `, [s.id]);

  const recentPOs = await all(`
    SELECT id, po_number, status, total, paid_amount, order_date
    FROM purchase_orders WHERE supplier_id = ?
    ORDER BY created_at DESC LIMIT 10
  `, [s.id]);

  res.json({
    supplier: { ...s, is_active: !!s.is_active },
    balance: await getSupplierBalance(s.id),
    relations,
    recent_orders: recentPOs,
  });
});

// ── POST /api/suppliers ──
router.post('/', authorize('admin','manager'), async (req, res) => {
  const {
    name, name_en, type, phone, phone2, email, address, city, country,
    tax_number, commercial_register, contact_person, contact_phone,
    payment_terms, credit_limit, opening_balance, notes, code,
  } = req.body;

  if (!name) return res.status(400).json({ error: 'اسم المورد مطلوب' });
  const supplierCode = code?.trim() || await genSupplierCode();
  if (await get(`SELECT id FROM suppliers WHERE code = ?`, [supplierCode]))
    return res.status(409).json({ error: 'الكود مستخدم بالفعل' });

  const newId = await insert(`
    INSERT INTO suppliers
    (code,name,name_en,type,phone,phone2,email,address,city,country,
     tax_number,commercial_register,contact_person,contact_phone,
     payment_terms,credit_limit,opening_balance,notes)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [supplierCode, name, name_en||null, type||'company',
     phone||null, phone2||null, email||null, address||null, city||null, country||'مصر',
     tax_number||null, commercial_register||null,
     contact_person||null, contact_phone||null,
     payment_terms||30, credit_limit||0, opening_balance||0, notes||null]
  );

  await logAction(req.user.id, 'create', 'supplier', newId, { name, code: supplierCode });
  res.status(201).json({ message: 'تم إنشاء المورد بنجاح', supplier: await get(`SELECT * FROM suppliers WHERE id=?`,[newId]) });
});

// ── PUT /api/suppliers/:id ──
router.put('/:id', authorize('admin','manager'), async (req, res) => {
  const { id } = req.params;
  const s = await get(`SELECT * FROM suppliers WHERE id=?`,[id]);
  if (!s) return res.status(404).json({ error: 'المورد غير موجود' });

  const f = req.body;
  await run(`UPDATE suppliers SET
    name=COALESCE(?,name), name_en=COALESCE(?,name_en), type=COALESCE(?,type),
    phone=COALESCE(?,phone), phone2=COALESCE(?,phone2), email=COALESCE(?,email),
    address=COALESCE(?,address), city=COALESCE(?,city), country=COALESCE(?,country),
    tax_number=COALESCE(?,tax_number), commercial_register=COALESCE(?,commercial_register),
    contact_person=COALESCE(?,contact_person), contact_phone=COALESCE(?,contact_phone),
    payment_terms=COALESCE(?,payment_terms), credit_limit=COALESCE(?,credit_limit),
    opening_balance=COALESCE(?,opening_balance), notes=COALESCE(?,notes),
    is_active=COALESCE(?,is_active), updated_at=datetime('now')
    WHERE id=?`,
    [f.name??null, f.name_en??null, f.type??null,
     f.phone??null, f.phone2??null, f.email??null,
     f.address??null, f.city??null, f.country??null,
     f.tax_number??null, f.commercial_register??null,
     f.contact_person??null, f.contact_phone??null,
     f.payment_terms??null, f.credit_limit??null,
     f.opening_balance??null, f.notes??null,
     f.is_active !== undefined ? (f.is_active ? 1 : 0) : null,
     id]
  );

  await logAction(req.user.id, 'update', 'supplier', id, req.body);
  res.json({ supplier: await get(`SELECT * FROM suppliers WHERE id=?`,[id]) });
});

// ── PUT /api/suppliers/:id/relations ──
router.put('/:id/relations', authorize('admin','manager'), async (req, res) => {
  const { id } = req.params;
  const { related_ids } = req.body; // مصفوفة IDs الموردين المرتبطين
  if (!await get(`SELECT id FROM suppliers WHERE id=?`,[id]))
    return res.status(404).json({ error: 'المورد غير موجود' });

  await run(`DELETE FROM supplier_relations WHERE supplier_id=?`, [id]);
  if (Array.isArray(related_ids)) {
    for (const rid of related_ids) {
      if (Number(rid) !== Number(id)) {
        await insert(`INSERT OR IGNORE INTO supplier_relations (supplier_id, related_supplier_id) VALUES (?,?)`, [id, rid]);
      }
    }
  }
  res.json({ message: 'تم تحديث العلاقات بنجاح' });
});

// ── GET /api/suppliers/:id/statement?from=&to= — كشف حساب احترافي ──
router.get('/:id/statement', async (req, res) => {
  const { from, to } = req.query;
  const statement = await buildStatement({ accountType: 'supplier', accountId: req.params.id, dateFrom: from || null, dateTo: to || null });
  if (!statement) return res.status(404).json({ error: 'المورد غير موجود' });
  res.json({ statement });
});

// ── POST /api/suppliers/import — استيراد من Excel ──
const tmpDir = path.join(__dirname,'../uploads/temp');
if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir,{recursive:true});
const upload = multer({ dest: tmpDir, limits: { fileSize: 10*1024*1024 } });

// ═══════════════════════════════════════════════════════════════════════════
//  استيراد الموردين — تم ترقيته لنفس منطق "المزامنة الذكية" المستخدم في
//  استيراد المنتجات والعملاء (كان قبل كده بيضيف صف جديد دايماً حتى لو
//  المورد موجود بالفعل، وده كان بيسبب تكرار المورد نفسه في كل رفعة ملف).
//  نفس قرار السلامة الخاص بالرصيد الافتتاحي: بيتطبّق للمورد الجديد بس، ومش
//  بيتلمس لمورد موجود بالفعل (الرصيد الحقيقي بييجي من أوامر الشراء والدفعات).
// ═══════════════════════════════════════════════════════════════════════════
function supNormText(v) {
  if (v === null || v === undefined) return '';
  let s = String(v).trim();
  if (!s) return '';
  s = s.replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
       .replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06F0));
  s = s.replace(/[\u064B-\u0652\u0640]/g, '');
  s = s.replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/ؤ/g, 'و').replace(/ئ/g, 'ي');
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}
function supNormPhone(v) { return String(v || '').replace(/[^0-9]/g, ''); }
const SUP_ALIAS = {
  name: ['name', 'اسم', 'اسم المورد', 'supplier'],
  code: ['code', 'كود', 'كود المورد'],
  type: ['type', 'نوع', 'النوع'],
  phone: ['phone', 'هاتف', 'الهاتف'],
  phone2: ['phone2', 'هاتف 2', 'هاتف اضافي'],
  email: ['email', 'ايميل', 'البريد الالكتروني', 'البريد الإلكتروني'],
  city: ['city', 'مدينة', 'المدينة'],
  address: ['address', 'عنوان', 'العنوان', 'العنوان التفصيلي'],
  contact_person: ['contact_person', 'اسم المسؤول', 'المسؤول'],
  contact_phone: ['contact_phone', 'هاتف المسؤول'],
  payment_terms: ['payment_terms', 'ايام السداد', 'أيام السداد'],
  credit_limit: ['credit_limit', 'حد الائتمان'],
  opening_balance: ['opening_balance', 'رصيد افتتاحي', 'الرصيد الافتتاحي'],
  notes: ['notes', 'ملاحظات'],
};
const SUP_ALIAS_TO_FIELD = new Map();
Object.entries(SUP_ALIAS).forEach(([field, aliases]) => aliases.forEach((a) => SUP_ALIAS_TO_FIELD.set(supNormText(a), field)));
function supBuildHeaderMap(headerRow) {
  const map = {}, duplicates = [], unknown = [];
  headerRow.forEach((raw, idx) => {
    const text = String(raw || '').trim();
    if (!text) return;
    const field = SUP_ALIAS_TO_FIELD.get(supNormText(text.replace(/[_\-]+/g, ' ')));
    if (!field) { unknown.push(text); return; }
    if (map[field] !== undefined) { duplicates.push({ header: text, column: idx + 1 }); return; }
    map[field] = idx;
  });
  return { map, duplicates, unknown };
}
function supCell(row, map, field) {
  const idx = map[field];
  if (idx === undefined) return '';
  const v = row[idx];
  return v === null || v === undefined ? '' : String(v).trim();
}
const SUP_TYPE_MAP = { company: 'company', شركة: 'company', individual: 'individual', فرد: 'individual' };
const SUP_FIELD_LABELS = {
  type: 'النوع', phone: 'الهاتف', phone2: 'هاتف 2', email: 'البريد الإلكتروني',
  city: 'المدينة', address: 'العنوان', contact_person: 'اسم المسؤول', contact_phone: 'هاتف المسؤول',
  payment_terms: 'أيام السداد', credit_limit: 'حد الائتمان', notes: 'ملاحظات',
};

router.get('/import/template', async (req, res) => {
  const headers = ['name', 'type', 'phone', 'city', 'address', 'contact_person', 'contact_phone', 'payment_terms', 'credit_limit', 'opening_balance'];
  const sample = [
    ['شركة النور للإضاءة', 'شركة', '01012345678', 'القاهرة', 'مصر الجديدة، شارع الثورة', 'محمد أحمد', '01098765432', '30', '0', '5000'],
  ];
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([headers, ...sample]);
  ws['!cols'] = headers.map((h) => ({ wch: Math.max(14, h.length + 4) }));
  XLSX.utils.book_append_sheet(wb, ws, 'الموردون');
  const guide = [
    ['كيف يعمل الاستيراد؟', ''],
    ['المطابقة', 'يتم التعرّف على المورد بالكود إن وُجد، ثم بالهاتف، ثم بالاسم'],
    ['مورد مطابق تماماً', 'يتم تجاوزه بدون أي تعديل'],
    ['مورد موجود ببيانات مختلفة', 'يتم تحديث الأعمدة المختلفة فقط'],
    ['مورد جديد', 'تتم إضافته، والرصيد الافتتاحي (لو موجود) يُسجَّل له'],
    ['الرصيد الافتتاحي لمورد موجود بالفعل', 'لا يتم تعديله أبداً من الاستيراد — الرصيد الحقيقي يُدار من أوامر الشراء والدفعات فقط'],
  ];
  const wsG = XLSX.utils.aoa_to_sheet(guide);
  wsG['!cols'] = [{ wch: 30 }, { wch: 60 }];
  XLSX.utils.book_append_sheet(wb, wsG, 'دليل الاستيراد');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename="suppliers_import_template.xlsx"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

router.post('/import', authorize('admin','manager'), upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'يرجى رفع ملف Excel أو CSV' });
  const cleanup = () => { try { if (fs.existsSync(req.file.path)) fs.unlink(req.file.path, () => {}); } catch (_) {} };
  try {
    const wb = XLSX.readFile(req.file.path);
    const sheetName = wb.SheetNames[0];
    if (!sheetName) { cleanup(); return res.status(400).json({ error: 'الملف لا يحتوي على أي ورقة عمل' }); }
    const matrix = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: '', blankrows: false });
    cleanup();
    if (matrix.length < 2) return res.status(400).json({ error: 'الملف فارغ أو لا يحتوي على بيانات كافية' });

    const { map: colMap, duplicates, unknown } = supBuildHeaderMap(matrix[0]);
    if (colMap.name === undefined) {
      return res.status(400).json({ error: 'لم يتم العثور على عمود اسم المورد (name) في صف العناوين' });
    }
    const rows = matrix.slice(1);
    if (rows.length > 5000) return res.status(400).json({ error: 'الملف كبير جداً (أكثر من 5000 صف)' });

    const existing = await all(`SELECT * FROM suppliers`);
    const byCode = new Map(), byPhone = new Map(), byName = new Map();
    existing.forEach((s) => {
      if (s.code) byCode.set(supNormText(s.code), s);
      if (s.phone) byPhone.set(supNormPhone(s.phone), s);
      const nk = supNormText(s.name);
      byName.set(nk, byName.has(nk) ? 'AMBIGUOUS' : s);
    });

    const report = { created: [], updated: [], unchanged: [], errors: [], warnings: [] };
    duplicates.forEach((d) => report.warnings.push({ row: 1, warning: `العمود رقم ${d.column} مكرر — تم تجاهله` }));
    if (unknown.length) report.warnings.push({ row: 1, warning: `أعمدة غير معروفة تم تجاهلها: ${unknown.join(' | ')}` });

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rowNum = i + 2;
      try {
        const name = supCell(row, colMap, 'name');
        if (!name) { report.errors.push({ row: rowNum, error: 'اسم المورد مطلوب' }); continue; }
        const code = supCell(row, colMap, 'code');
        const phoneRaw = supCell(row, colMap, 'phone');

        let match = null, matchedBy = null;
        if (code) { const m = byCode.get(supNormText(code)); if (m && m !== 'AMBIGUOUS') { match = m; matchedBy = 'code'; } }
        if (!match && phoneRaw) { const m = byPhone.get(supNormPhone(phoneRaw)); if (m) { match = m; matchedBy = 'phone'; } }
        if (!match) {
          const m = byName.get(supNormText(name));
          if (m === 'AMBIGUOUS') { report.errors.push({ row: rowNum, error: `أكثر من مورد بنفس الاسم "${name}" — أضف كود أو هاتف للتفرقة` }); continue; }
          if (m) { match = m; matchedBy = 'name'; }
        }

        const typeRaw = supCell(row, colMap, 'type');
        const type = typeRaw ? (SUP_TYPE_MAP[supNormText(typeRaw)] || null) : null;
        const fields = {
          type, phone: phoneRaw || null, phone2: supCell(row, colMap, 'phone2') || null,
          email: supCell(row, colMap, 'email') || null,
          city: supCell(row, colMap, 'city') || null,
          address: supCell(row, colMap, 'address') || null,
          contact_person: supCell(row, colMap, 'contact_person') || null,
          contact_phone: supCell(row, colMap, 'contact_phone') || null,
          payment_terms: supCell(row, colMap, 'payment_terms') !== '' ? parseInt(supCell(row, colMap, 'payment_terms')) : null,
          credit_limit: supCell(row, colMap, 'credit_limit') !== '' ? parseFloat(supCell(row, colMap, 'credit_limit')) : null,
          notes: supCell(row, colMap, 'notes') || null,
        };
        const openingRaw = supCell(row, colMap, 'opening_balance');

        if (!match) {
          const supCode = code || await genSupplierCode();
          const newId = await insert(`
            INSERT INTO suppliers (code,name,type,phone,phone2,email,address,city,country,
              contact_person,contact_phone,payment_terms,credit_limit,opening_balance,notes)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [supCode, name, fields.type || 'company', fields.phone, fields.phone2, fields.email, fields.address,
             fields.city, 'مصر', fields.contact_person, fields.contact_phone,
             fields.payment_terms || 30, fields.credit_limit || 0,
             openingRaw !== '' ? (parseFloat(openingRaw) || 0) : 0, fields.notes]
          );
          await logAction(req.user.id, 'import_create', 'supplier', newId, { source: 'bulk_import', name });
          report.created.push({ row: rowNum, code: supCode, name });
        } else {
          const changes = [];
          const diffs = {};
          Object.entries(fields).forEach(([f, val]) => {
            if (val === null || val === '') return;
            const oldVal = match[f];
            const same = f === 'credit_limit'
              ? Math.abs((Number(oldVal) || 0) - Number(val)) < 0.001
              : f === 'payment_terms'
              ? Number(oldVal || 0) === Number(val)
              : supNormText(oldVal) === supNormText(val);
            if (!same) {
              diffs[f] = val;
              changes.push({ field: f, label: SUP_FIELD_LABELS[f] || f, old: oldVal ?? '—', new: val });
            }
          });
          if (openingRaw !== '' && Math.abs((Number(match.opening_balance) || 0) - (parseFloat(openingRaw) || 0)) > 0.001) {
            report.warnings.push({ row: rowNum, warning: `تم تجاهل الرصيد الافتتاحي لمورد موجود بالفعل ("${name}") — الرصيد يُدار من أوامر الشراء والدفعات، مش من الاستيراد` });
          }
          if (!changes.length) {
            report.unchanged.push({ row: rowNum, code: match.code, name: match.name, matched_by: matchedBy });
          } else {
            await run(`UPDATE suppliers SET
              type=COALESCE(?,type), phone=COALESCE(?,phone), phone2=COALESCE(?,phone2), email=COALESCE(?,email),
              address=COALESCE(?,address), city=COALESCE(?,city),
              contact_person=COALESCE(?,contact_person), contact_phone=COALESCE(?,contact_phone),
              payment_terms=COALESCE(?,payment_terms), credit_limit=COALESCE(?,credit_limit),
              notes=COALESCE(?,notes), updated_at=datetime('now')
              WHERE id=?`,
              [diffs.type ?? null, diffs.phone ?? null, diffs.phone2 ?? null, diffs.email ?? null,
               diffs.address ?? null, diffs.city ?? null,
               diffs.contact_person ?? null, diffs.contact_phone ?? null,
               diffs.payment_terms ?? null, diffs.credit_limit ?? null,
               diffs.notes ?? null, match.id]
            );
            await logAction(req.user.id, 'import_update', 'supplier', match.id, { changes: changes.map(c=>c.field) });
            report.updated.push({ row: rowNum, code: match.code, name, matched_by: matchedBy, changes });
          }
        }
      } catch (err) {
        report.errors.push({ row: rowNum, error: err.message });
      }
    }

    await logAction(req.user.id, 'bulk_import', 'supplier', null, {
      total_rows: rows.length, created: report.created.length, updated: report.updated.length, errors: report.errors.length,
    });
    res.json({
      message: `تمت المزامنة: ${report.created.length} جديد · ${report.updated.length} مُحدَّث · ${report.unchanged.length} مطابق`,
      total_rows: rows.length,
      imported: report.created.length + report.updated.length + report.unchanged.length,
      failed: report.errors.length,
      created_details: report.created, updated_details: report.updated, unchanged_details: report.unchanged,
      success_details: [...report.created, ...report.updated],
      error_details: report.errors, warning_details: report.warnings,
    });
  } catch (err) {
    console.error('Supplier import error:', err);
    cleanup();
    res.status(500).json({ error: 'حدث خطأ أثناء قراءة الملف: ' + err.message });
  }
});

// ── DELETE /api/suppliers/:id ──
// ── لم يكن يوجد أي endpoint حذف للموردين أصلاً (كان بيتغير is_active بس عبر
//    PUT العام، متاح للـ manager كمان). الممارسة الاحترافية في أي ERP: مورد
//    مرتبط بمعاملات مالية فعلية (أوامر شراء / دفعات) لا يجوز حذفه نهائياً
//    (hard delete) أبداً — ده هيكسر كل الـ FK المرجعية في سجلات تاريخية ويمحو
//    الأرشيف. الحل الصحيح: تعطيل (soft delete عبر is_active=0)، ومسموح فقط
//    لو رصيد المورد صفر (لا توجد مبالغ مستحقة في أي الاتجاهين) ولا توجد أي
//    أوامر شراء لسه مفتوحة (draft/sent/partial) — وإلا هنفقد تتبع الالتزام
//    المالي القائم مع المورد ده. ──
router.delete('/:id', authorize('admin'), async (req, res) => {
  const { id } = req.params;
  const s = await get(`SELECT * FROM suppliers WHERE id=?`,[id]);
  if (!s) return res.status(404).json({ error: 'المورد غير موجود' });
  if (!s.is_active) return res.status(400).json({ error: 'المورد معطّل بالفعل' });

  const balance = await getSupplierBalance(id);
  if (balance && Math.abs(balance.balance) > 0.01)
    return res.status(400).json({
      error: `لا يمكن تعطيل المورد — يوجد رصيد قائم (${balance.balance.toFixed(2)} ج.م) — يجب تسوية الحساب أولاً`,
    });

  const openOrders = await get(
    `SELECT COUNT(*) as c FROM purchase_orders WHERE supplier_id=? AND status IN ('draft','sent','partial')`,[id]
  );
  if (openOrders?.c > 0)
    return res.status(400).json({ error: 'لا يمكن تعطيل المورد — يوجد أوامر شراء لسه مفتوحة (لم تكتمل أو تُلغَ) مرتبطة به' });

  await run(`UPDATE suppliers SET is_active=0, updated_at=datetime('now') WHERE id=?`,[id]);
  await logAction(req.user.id, 'deactivate', 'supplier', id, null);
  res.json({ message: 'تم تعطيل المورد بنجاح' });
});

module.exports = router;