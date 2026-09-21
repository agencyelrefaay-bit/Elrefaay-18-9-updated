// routes/customers.js
const express = require('express');
const router  = express.Router();
const multer  = require('multer');
const XLSX    = require('xlsx');
const path    = require('path');
const fs      = require('fs');
const { all, get, run, insert } = require('../db/database');
const { authenticate, authorize } = require('../middleware/auth');
const { logAction }               = require('../utils/auditLog');
const { getCustomerBalance }      = require('../utils/customerLedger');
const { buildStatement }          = require('../utils/statementEngine');

router.use(authenticate);

const { nextDocumentNumber } = require('../utils/sequenceGenerator');
// تم استبدال مولّد COUNT(*) غير الآمن تحت التزامن بـ SEQUENCE ذرّي (راجع src/utils/sequenceGenerator.js)
async function genCustomerCode() {
  return nextDocumentNumber('customer_code_seq', 'CUS', 4, async () => {
    const r = await get(`SELECT COUNT(*) as c FROM customers`);
    return (r?.c || 0) + 1;
  });
}

// GET /api/customers
router.get('/', async (req, res) => {
  const { search, type, is_active, governorate, area } = req.query;
  let sql = `SELECT * FROM customers WHERE 1=1`;
  const params = [];
  if (search) {
    sql += ` AND (name LIKE ? OR code LIKE ? OR phone LIKE ?)`;
    const t = `%${search}%`; params.push(t,t,t);
  }
  if (type)        { sql += ` AND type=?`;        params.push(type); }
  if (governorate) { sql += ` AND governorate=?`; params.push(governorate); }
  if (area)        { sql += ` AND area=?`;        params.push(area); }
  if (is_active !== undefined)
    sql += ` AND is_active=${is_active==='true'||is_active==='1'?1:0}`;
  sql += ` ORDER BY name ASC`;

  const customerRows = await all(sql, params);
  const customers = await Promise.all(customerRows.map(async c => ({
    ...c, is_active: !!c.is_active,
    balance: await getCustomerBalance(c.id),
  })));
  res.json({ customers, count: customers.length });
});

// GET /api/customers/geo/list — قوائم المحافظات/المناطق المستخدمة فعلياً حالياً
// (تفيد في تعبئة فلاتر تقرير التحصيل بدون سرد كل القيم يدوياً)
// ملحوظة: لازم يتسجل *قبل* GET /:id عشان "geo" ماتتفسرش كـ :id
router.get('/geo/list', async (req, res) => {
  const governorates = await all(`SELECT DISTINCT governorate FROM customers WHERE governorate IS NOT NULL AND governorate != '' ORDER BY governorate`);
  const areas = await all(`SELECT DISTINCT area, governorate FROM customers WHERE area IS NOT NULL AND area != '' ORDER BY area`);
  res.json({
    governorates: governorates.map(r => r.governorate),
    areas: areas.map(r => ({ area: r.area, governorate: r.governorate })),
  });
});

// GET /api/customers/:id
router.get('/:id', async (req, res) => {
  const c = await get(`SELECT * FROM customers WHERE id=?`,[req.params.id]);
  if (!c) return res.status(404).json({ error: 'العميل غير موجود' });

  const recentInvoices = await all(`
    SELECT id,invoice_number,invoice_date,total,paid_amount,status
    FROM invoices WHERE customer_id=?
    ORDER BY created_at DESC LIMIT 10
  `,[c.id]);

  res.json({
    customer: { ...c, is_active: !!c.is_active },
    balance: await getCustomerBalance(c.id),
    recent_invoices: recentInvoices,
  });
});

// GET /api/customers/:id/statement?from=&to= — كشف حساب احترافي (رصيد افتتاحي + حركات مرتبة زمنياً + رصيد جاري)
router.get('/:id/statement', async (req, res) => {
  const { from, to } = req.query;
  const statement = await buildStatement({ accountType: 'customer', accountId: req.params.id, dateFrom: from || null, dateTo: to || null });
  if (!statement) return res.status(404).json({ error: 'العميل غير موجود' });
  res.json({ statement });
});

// POST /api/customers
router.post('/', authorize('admin','manager','sales'), async (req, res) => {
  const { name, name_en, type, phone, phone2, email, address, city, governorate, area, country,
          tax_number, contact_person, discount_pct, credit_limit,
          payment_terms, opening_balance, notes, code } = req.body;

  if (!name) return res.status(400).json({ error: 'اسم العميل مطلوب' });
  const custCode = code?.trim() || await genCustomerCode();
  if (await get(`SELECT id FROM customers WHERE code=?`,[custCode]))
    return res.status(409).json({ error: 'الكود مستخدم بالفعل' });

  const newId = await insert(`
    INSERT INTO customers
    (code,name,name_en,type,phone,phone2,email,address,city,governorate,area,country,
     tax_number,contact_person,discount_pct,credit_limit,payment_terms,opening_balance,notes)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [custCode,name,name_en||null,type||'retail',phone||null,phone2||null,
     email||null,address||null,city||null,governorate||null,area||null,country||'مصر',
     tax_number||null,contact_person||null,
     parseFloat(discount_pct)||0, parseFloat(credit_limit)||0,
     parseInt(payment_terms)||0, parseFloat(opening_balance)||0, notes||null]
  );

  await logAction(req.user.id,'create','customer',newId,{ name, code: custCode });
  res.status(201).json({ customer: await get(`SELECT * FROM customers WHERE id=?`,[newId]) });
});

// PUT /api/customers/:id
router.put('/:id', authorize('admin','manager','sales'), async (req, res) => {
  const { id } = req.params;
  const c = await get(`SELECT * FROM customers WHERE id=?`,[id]);
  if (!c) return res.status(404).json({ error: 'العميل غير موجود' });

  const f = req.body;
  await run(`UPDATE customers SET
    name=COALESCE(?,name), name_en=COALESCE(?,name_en), type=COALESCE(?,type),
    phone=COALESCE(?,phone), phone2=COALESCE(?,phone2), email=COALESCE(?,email),
    address=COALESCE(?,address), city=COALESCE(?,city),
    governorate=COALESCE(?,governorate), area=COALESCE(?,area),
    tax_number=COALESCE(?,tax_number), contact_person=COALESCE(?,contact_person),
    discount_pct=COALESCE(?,discount_pct), credit_limit=COALESCE(?,credit_limit),
    payment_terms=COALESCE(?,payment_terms), opening_balance=COALESCE(?,opening_balance),
    notes=COALESCE(?,notes),
    is_active=COALESCE(?,is_active), updated_at=datetime('now')
    WHERE id=?`,
    [f.name??null, f.name_en??null, f.type??null,
     f.phone??null, f.phone2??null, f.email??null,
     f.address??null, f.city??null,
     f.governorate??null, f.area??null,
     f.tax_number??null, f.contact_person??null,
     f.discount_pct!=null?parseFloat(f.discount_pct):null,
     f.credit_limit!=null?parseFloat(f.credit_limit):null,
     f.payment_terms!=null?parseInt(f.payment_terms):null,
     f.opening_balance!=null?parseFloat(f.opening_balance):null,
     f.notes??null,
     f.is_active!=null?(f.is_active?1:0):null, id]
  );

  await logAction(req.user.id,'update','customer',id,req.body);
  res.json({ customer: await get(`SELECT * FROM customers WHERE id=?`,[id]) });
});

// ملحوظة: استيراد Excel (POST /import و GET /import/template) موجود تحت،
// في نسخة "المزامنة الذكية" الاحترافية (upsert + تقرير تفصيلي) — شوف آخر
// الملف. النسخة القديمة البسيطة (كانت بتضيف صف جديد دايماً حتى لو العميل
// موجود بالفعل، وده كان بيكرر نفس العميل في كل رفعة ملف) اتشالت من هنا.

// ── DELETE /api/customers/:id ──
// ── نفس المبدأ المطبّق على الموردين (راجع الشرح في suppliers.js): لا يوجد
//    hard delete لعميل مرتبط بفواتير حقيقية أبداً، فقط تعطيل (soft delete)
//    ومشروط برصيد صفري ومفيش فواتير لسه مفتوحة (غير مدفوعة بالكامل). ──
router.delete('/:id', authorize('admin'), async (req, res) => {
  const { id } = req.params;
  const c = await get(`SELECT * FROM customers WHERE id=?`,[id]);
  if (!c) return res.status(404).json({ error: 'العميل غير موجود' });
  if (!c.is_active) return res.status(400).json({ error: 'العميل معطّل بالفعل' });

  const balance = await getCustomerBalance(id);
  if (balance && Math.abs(balance.balance) > 0.01)
    return res.status(400).json({
      error: `لا يمكن تعطيل العميل — يوجد رصيد قائم (${balance.balance.toFixed(2)} ج.م) — يجب تسوية الحساب أولاً`,
    });

  const openInvoices = await get(
    `SELECT COUNT(*) as c FROM invoices WHERE customer_id=? AND status IN ('confirmed','partial')`,[id]
  );
  if (openInvoices?.c > 0)
    return res.status(400).json({ error: 'لا يمكن تعطيل العميل — يوجد فواتير لسه غير مسددة بالكامل مرتبطة به' });

  await run(`UPDATE customers SET is_active=0, updated_at=datetime('now') WHERE id=?`,[id]);
  await logAction(req.user.id, 'deactivate', 'customer', id, null);
  res.json({ message: 'تم تعطيل العميل بنجاح' });
});

// ═══════════════════════════════════════════════════════════════════════════
//  استيراد العملاء من Excel/CSV — نفس فلسفة "المزامنة الذكية" المستخدمة في
//  استيراد المنتجات (routes/import.js): مطابقة → تحديث الفروق فقط → أو إضافة
//  جديد، مع تقرير تفصيلي متوافق تماماً مع الشكل اللي الواجهة (renderImportReport)
//  بتتوقعه أصلاً (created_details / updated_details / unchanged_details).
//
//  قرار سلامة مهم: الرصيد الافتتاحي (opening_balance) بيتطبّق فقط لما العميل
//  بيتضاف لأول مرة. لو العميل موجود بالفعل وجالك ملف فيه رقم مختلف لرصيده،
//  إحنا بنتجاهله ونحط تنبيه بدل ما نستبدل رصيد حقيقي (متراكم من فواتير
//  ودفعات فعلية) برقم من شيت إكسل ممكن يكون قديم أو غلط.
// ═══════════════════════════════════════════════════════════════════════════
const custImportTmpDir = path.join(__dirname, '../uploads/temp');
if (!fs.existsSync(custImportTmpDir)) fs.mkdirSync(custImportTmpDir, { recursive: true });
const custImportUpload = multer({ dest: custImportTmpDir, limits: { fileSize: 10 * 1024 * 1024 } });

function custNormText(v) {
  if (v === null || v === undefined) return '';
  let s = String(v).trim();
  if (!s) return '';
  s = s.replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
       .replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06F0));
  s = s.replace(/[\u064B-\u0652\u0640]/g, '');
  s = s.replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/ؤ/g, 'و').replace(/ئ/g, 'ي');
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}
function custNormPhone(v) {
  return String(v || '').replace(/[^0-9]/g, '');
}
const CUST_ALIAS = {
  name: ['name', 'اسم', 'اسم العميل', 'customer'],
  code: ['code', 'كود', 'كود العميل'],
  type: ['type', 'نوع', 'نوع العميل'],
  phone: ['phone', 'هاتف', 'الهاتف', 'موبايل'],
  phone2: ['phone2', 'هاتف اضافي', 'هاتف إضافي', 'هاتف 2'],
  email: ['email', 'ايميل', 'بريد', 'البريد الالكتروني', 'البريد الإلكتروني'],
  governorate: ['governorate', 'محافظة', 'المحافظة'],
  area: ['area', 'منطقة', 'المنطقة', 'حي', 'المنطقة/الحي'],
  city: ['city', 'مدينة', 'المدينة'],
  address: ['address', 'عنوان', 'العنوان'],
  contact_person: ['contact_person', 'شخص التواصل', 'مسؤول'],
  tax_number: ['tax_number', 'رقم ضريبي', 'الرقم الضريبي'],
  credit_limit: ['credit_limit', 'حد الائتمان'],
  payment_terms: ['payment_terms', 'ايام السداد', 'أيام السداد'],
  discount_pct: ['discount_pct', 'خصم', 'نسبة الخصم'],
  opening_balance: ['opening_balance', 'رصيد افتتاحي', 'الرصيد الافتتاحي'],
  notes: ['notes', 'ملاحظات'],
};
const CUST_ALIAS_TO_FIELD = new Map();
Object.entries(CUST_ALIAS).forEach(([field, aliases]) => aliases.forEach((a) => CUST_ALIAS_TO_FIELD.set(custNormText(a), field)));

function custBuildHeaderMap(headerRow) {
  const map = {}, duplicates = [], unknown = [];
  headerRow.forEach((raw, idx) => {
    const text = String(raw || '').trim();
    if (!text) return;
    const field = CUST_ALIAS_TO_FIELD.get(custNormText(text.replace(/[_\-]+/g, ' ')));
    if (!field) { unknown.push(text); return; }
    if (map[field] !== undefined) { duplicates.push({ header: text, column: idx + 1 }); return; }
    map[field] = idx;
  });
  return { map, duplicates, unknown };
}
function custCell(row, map, field) {
  const idx = map[field];
  if (idx === undefined) return '';
  const v = row[idx];
  return v === null || v === undefined ? '' : String(v).trim();
}
const CUST_TYPE_MAP = {
  wholesale: 'wholesale', جملة: 'wholesale',
  retail: 'retail', قطاعي: 'retail', تجزئة: 'retail',
  vip: 'vip', مقاول: 'contractor', contractor: 'contractor',
};
const CUST_FIELD_LABELS = {
  type: 'النوع', phone: 'الهاتف', phone2: 'هاتف إضافي', email: 'البريد الإلكتروني',
  governorate: 'المحافظة', area: 'المنطقة/الحي', city: 'المدينة', address: 'العنوان',
  contact_person: 'شخص التواصل', tax_number: 'الرقم الضريبي', credit_limit: 'حد الائتمان',
  payment_terms: 'أيام السداد', discount_pct: 'نسبة الخصم', notes: 'ملاحظات',
};

router.get('/import/template', authorize('admin', 'manager', 'sales'), async (req, res) => {
  const headers = ['name', 'type', 'phone', 'governorate', 'area', 'address', 'discount_pct', 'opening_balance', 'notes'];
  const sample = [
    ['محمد أحمد للمقاولات', 'جملة', '01012345678', 'القاهرة', 'مدينة نصر', 'شارع مكرم عبيد، عقار 12', '10', '0', ''],
    ['أحمد علي', 'قطاعي', '01098765432', 'الجيزة', 'الدقي', '', '0', '5000', 'عميل قديم — رصيد منقول من الدفتر'],
  ];
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([headers, ...sample]);
  ws['!cols'] = headers.map((h) => ({ wch: Math.max(14, h.length + 4) }));
  XLSX.utils.book_append_sheet(wb, ws, 'العملاء');
  const guide = [
    ['كيف يعمل الاستيراد؟', ''],
    ['المطابقة', 'يتم التعرّف على العميل بالكود إن وُجد، ثم بالهاتف، ثم بالاسم'],
    ['عميل مطابق تماماً', 'يتم تجاوزه بدون أي تعديل'],
    ['عميل موجود ببيانات مختلفة', 'يتم تحديث الأعمدة المختلفة فقط'],
    ['عميل جديد', 'تتم إضافته، والرصيد الافتتاحي (لو موجود) يُسجَّل له'],
    ['الرصيد الافتتاحي لعميل موجود بالفعل', 'لا يتم تعديله أبداً من الاستيراد — الرصيد الحقيقي يُدار من الفواتير والدفعات فقط'],
    ['النوع (type)', 'جملة / قطاعي (أو wholesale / retail)'],
    ['خانة فارغة', 'تُتجاهل ولا تمسح بيانات موجودة'],
  ];
  const wsG = XLSX.utils.aoa_to_sheet(guide);
  wsG['!cols'] = [{ wch: 30 }, { wch: 60 }];
  XLSX.utils.book_append_sheet(wb, wsG, 'دليل الاستيراد');
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename="customers_import_template.xlsx"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buffer);
});

router.post('/import', authorize('admin', 'manager', 'sales'), custImportUpload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'يرجى رفع ملف Excel أو CSV' });
  const cleanup = () => { try { if (fs.existsSync(req.file.path)) fs.unlink(req.file.path, () => {}); } catch (_) {} };
  try {
    const wb = XLSX.readFile(req.file.path);
    const sheetName = wb.SheetNames[0];
    if (!sheetName) { cleanup(); return res.status(400).json({ error: 'الملف لا يحتوي على أي ورقة عمل' }); }
    const matrix = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: '', blankrows: false });
    cleanup();
    if (matrix.length < 2) return res.status(400).json({ error: 'الملف فارغ أو لا يحتوي على بيانات كافية' });

    const { map: colMap, duplicates, unknown } = custBuildHeaderMap(matrix[0]);
    if (colMap.name === undefined) {
      return res.status(400).json({ error: 'لم يتم العثور على عمود اسم العميل (name) في صف العناوين' });
    }
    const rows = matrix.slice(1);
    if (rows.length > 5000) return res.status(400).json({ error: 'الملف كبير جداً (أكثر من 5000 صف)' });

    const existing = await all(`SELECT * FROM customers`);
    const byCode = new Map(), byPhone = new Map(), byName = new Map();
    existing.forEach((c) => {
      if (c.code) byCode.set(custNormText(c.code), c);
      if (c.phone) byPhone.set(custNormPhone(c.phone), c);
      const nk = custNormText(c.name);
      byName.set(nk, byName.has(nk) ? 'AMBIGUOUS' : c);
    });

    const report = { created: [], updated: [], unchanged: [], errors: [], warnings: [] };
    duplicates.forEach((d) => report.warnings.push({ row: 1, warning: `العمود رقم ${d.column} مكرر — تم تجاهله` }));
    if (unknown.length) report.warnings.push({ row: 1, warning: `أعمدة غير معروفة تم تجاهلها: ${unknown.join(' | ')}` });

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rowNum = i + 2;
      try {
        const name = custCell(row, colMap, 'name');
        if (!name) { report.errors.push({ row: rowNum, error: 'اسم العميل مطلوب' }); continue; }
        const code = custCell(row, colMap, 'code');
        const phoneRaw = custCell(row, colMap, 'phone');

        let match = null, matchedBy = null;
        if (code) { const m = byCode.get(custNormText(code)); if (m && m !== 'AMBIGUOUS') { match = m; matchedBy = 'code'; } }
        if (!match && phoneRaw) { const m = byPhone.get(custNormPhone(phoneRaw)); if (m) { match = m; matchedBy = 'phone'; } }
        if (!match) {
          const m = byName.get(custNormText(name));
          if (m === 'AMBIGUOUS') { report.errors.push({ row: rowNum, error: `أكثر من عميل بنفس الاسم "${name}" — أضف كود أو هاتف للتفرقة` }); continue; }
          if (m) { match = m; matchedBy = 'name'; }
        }

        const typeRaw = custCell(row, colMap, 'type');
        const type = typeRaw ? (CUST_TYPE_MAP[custNormText(typeRaw)] || null) : null;
        const fields = {
          type, phone: phoneRaw || null, phone2: custCell(row, colMap, 'phone2') || null,
          email: custCell(row, colMap, 'email') || null,
          governorate: custCell(row, colMap, 'governorate') || null,
          area: custCell(row, colMap, 'area') || null,
          city: custCell(row, colMap, 'city') || null,
          address: custCell(row, colMap, 'address') || null,
          contact_person: custCell(row, colMap, 'contact_person') || null,
          tax_number: custCell(row, colMap, 'tax_number') || null,
          credit_limit: custCell(row, colMap, 'credit_limit') !== '' ? parseFloat(custCell(row, colMap, 'credit_limit')) : null,
          payment_terms: custCell(row, colMap, 'payment_terms') !== '' ? parseInt(custCell(row, colMap, 'payment_terms')) : null,
          discount_pct: custCell(row, colMap, 'discount_pct') !== '' ? parseFloat(custCell(row, colMap, 'discount_pct')) : null,
          notes: custCell(row, colMap, 'notes') || null,
        };
        const openingRaw = custCell(row, colMap, 'opening_balance');

        if (!match) {
          const custCode = code || await genCustomerCode();
          const newId = await insert(`
            INSERT INTO customers (code,name,type,phone,phone2,email,address,city,governorate,area,country,
              tax_number,contact_person,discount_pct,credit_limit,payment_terms,opening_balance,notes)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [custCode, name, fields.type || 'retail', fields.phone, fields.phone2, fields.email, fields.address,
             fields.city, fields.governorate, fields.area, 'مصر', fields.tax_number, fields.contact_person,
             fields.discount_pct || 0, fields.credit_limit || 0, fields.payment_terms || 0,
             openingRaw !== '' ? (parseFloat(openingRaw) || 0) : 0, fields.notes]
          );
          await logAction(req.user.id, 'import_create', 'customer', newId, { source: 'bulk_import', name });
          report.created.push({ row: rowNum, code: custCode, name });
        } else {
          const changes = [];
          const diffs = {};
          Object.entries(fields).forEach(([f, val]) => {
            if (val === null || val === '') return; // خانة فاضية = متجاهلة
            const oldVal = match[f];
            const same = f === 'credit_limit' || f === 'discount_pct'
              ? Math.abs((Number(oldVal) || 0) - Number(val)) < 0.001
              : f === 'payment_terms'
              ? Number(oldVal || 0) === Number(val)
              : custNormText(oldVal) === custNormText(val);
            if (!same) {
              diffs[f] = val;
              changes.push({ field: f, label: CUST_FIELD_LABELS[f] || f, old: oldVal ?? '—', new: val });
            }
          });
          if (openingRaw !== '' && Math.abs((Number(match.opening_balance) || 0) - (parseFloat(openingRaw) || 0)) > 0.001) {
            report.warnings.push({ row: rowNum, warning: `تم تجاهل الرصيد الافتتاحي لعميل موجود بالفعل ("${name}") — الرصيد يُدار من الفواتير والدفعات، مش من الاستيراد` });
          }
          if (!changes.length) {
            report.unchanged.push({ row: rowNum, code: match.code, name: match.name, matched_by: matchedBy });
          } else {
            await run(`UPDATE customers SET
              type=COALESCE(?,type), phone=COALESCE(?,phone), phone2=COALESCE(?,phone2), email=COALESCE(?,email),
              address=COALESCE(?,address), city=COALESCE(?,city), governorate=COALESCE(?,governorate), area=COALESCE(?,area),
              contact_person=COALESCE(?,contact_person), tax_number=COALESCE(?,tax_number),
              discount_pct=COALESCE(?,discount_pct), credit_limit=COALESCE(?,credit_limit), payment_terms=COALESCE(?,payment_terms),
              notes=COALESCE(?,notes), updated_at=datetime('now')
              WHERE id=?`,
              [diffs.type ?? null, diffs.phone ?? null, diffs.phone2 ?? null, diffs.email ?? null,
               diffs.address ?? null, diffs.city ?? null, diffs.governorate ?? null, diffs.area ?? null,
               diffs.contact_person ?? null, diffs.tax_number ?? null,
               diffs.discount_pct ?? null, diffs.credit_limit ?? null, diffs.payment_terms ?? null,
               diffs.notes ?? null, match.id]
            );
            await logAction(req.user.id, 'import_update', 'customer', match.id, { changes: changes.map(c=>c.field) });
            report.updated.push({ row: rowNum, code: match.code, name, matched_by: matchedBy, changes });
          }
        }
      } catch (err) {
        report.errors.push({ row: rowNum, error: err.message });
      }
    }

    await logAction(req.user.id, 'bulk_import', 'customer', null, {
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
    console.error('Customer import error:', err);
    cleanup();
    res.status(500).json({ error: 'حدث خطأ أثناء قراءة الملف: ' + err.message });
  }
});

module.exports = router;