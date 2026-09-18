// routes/import.js
// ═══════════════════════════════════════════════════════════════════════════
//  استيراد المنتجات من Excel / CSV — بمنطق "مزامنة ذكية" (Upsert)
// ───────────────────────────────────────────────────────────────────────────
//  السلوك المطلوب والمُنفَّذ هنا:
//   • المنتج موجود في السيستم وبياناته مطابقة للملف   →  يُتجاوَز (بدون أي كتابة)
//   • المنتج موجود لكن في اختلاف (سعر/لون/تصنيف/...)  →  تحديث الحقول المختلفة فقط
//   • المنتج غير موجود                                 →  إضافة منتج جديد
//  وفي كل الحالات بنرجّع تقرير تفصيلي يوضّح إيه اللي حصل بالظبط لكل صف،
//  وأي عمود اتغيّر وقيمته القديمة والجديدة.
//
//  ضمانات السلامة (مهم جداً لأي مطوّر يعدّل هنا لاحقاً):
//   1) العمود الفاضي في الملف = "مش مذكور" ولا يمسح البيانات الموجودة أبداً.
//      (استثناء وحيد صريح: كلمة CLEAR/مسح في عمود الوصف أو اللون).
//   2) المخزون (inventory / stock_movements) ما بيتلمسش نهائياً في التحديث —
//      الاستيراد بيحدّث بيانات "الكتالوج" بس، مش الكميات.
//   3) الـ SKU لمنتج موجود ما بيتغيّرش أبداً (هو مفتاح الهوية).
//   4) كل صف بيتنفّذ داخل transaction مستقلة: فشل صف واحد ما بيأثرش على باقي
//      الصفوف ولا بيسيب نص عملية مكتوبة.
//   5) التحقق من تعارض الـ barcode مع منتج تاني قبل أي كتابة.
//   6) قراءة الأعمدة بالموضع (index) مش بالمفتاح — عشان ملف فيه عمودين بنفس
//      العنوان (غلط شائع جداً في التصدير من برامج تانية) ما يبوّظش الاستيراد.
// ═══════════════════════════════════════════════════════════════════════════

const express = require('express');
const router = express.Router();
const multer = require('multer');
const XLSX = require('xlsx');
const path = require('path');
const fs = require('fs');
const { all, get, run, insert, transaction } = require('../db/database');
const { authenticate, authorize } = require('../middleware/auth');
const { logAction } = require('../utils/auditLog');
const { generateSKU, generateBarcode } = require('../utils/codeGenerator');

router.use(authenticate);

const tempDir = path.join(__dirname, '../uploads/temp');
if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

const upload = multer({
  dest: tempDir,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    const allowed = ['.xlsx', '.xls', '.csv'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) cb(null, true);
    else cb(new Error('يُسمح فقط بملفات Excel (.xlsx, .xls) أو CSV'));
  },
});

// ═══════════════════ أدوات مساعدة عامة ═══════════════════

const VALID_UNITS = ['piece', 'meter', 'liter', 'kg', 'set', 'cm'];
const MEASURED_UNITS = ['cm', 'meter'];

// تطبيع النص العربي/الإنجليزي للمقارنة والمطابقة: إزالة التشكيل، توحيد
// الألف/الياء/التاء المربوطة، تحويل الأرقام العربية للاتينية، وضغط المسافات.
// ده اللي بيخلي "نجف كريستال" و"نجف  كريستال " و"نجف كريستال" يتطابقوا.
function normalizeText(value) {
  if (value === null || value === undefined) return '';
  let s = String(value).trim();
  if (!s) return '';
  s = s.replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
       .replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06F0));
  s = s.replace(/[\u064B-\u0652\u0640]/g, '');
  s = s.replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/ؤ/g, 'و').replace(/ئ/g, 'ي');
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

// تطبيع خاص بعناوين الأعمدة: الشرطة السفلية والعادية بتتعامل كمسافة، عشان
// "sale_price" و"Sale Price" و"sale-price" كلهم يتطابقوا.
function normalizeHeader(value) {
  return normalizeText(String(value === null || value === undefined ? '' : value).replace(/[_\-]+/g, ' '));
}

function isClearToken(raw) {
  const n = normalizeText(raw);
  return n === 'clear' || n === 'مسح' || n === 'null' || n === 'فارغ' || n === '-';
}

function toNumber(raw) {
  if (raw === '' || raw === null || raw === undefined) return null;
  let cleaned = normalizeText(raw)
    .replace(/\u066B/g, '.')
    .replace(/ج\.?م|egp|le/gi, '')
    .replace(/\s/g, '');
  if (/^[^.]*,\d{1,2}$/.test(cleaned) && (cleaned.match(/,/g) || []).length === 1) {
    cleaned = cleaned.replace(',', '.');
  }
  cleaned = cleaned.replace(/[,\u066C]/g, '');
  const n = parseFloat(cleaned);
  return isNaN(n) ? null : n;
}

function numEq(a, b) {
  const x = a === null || a === undefined ? 0 : Number(a);
  const y = b === null || b === undefined ? 0 : Number(b);
  return Math.abs(x - y) < 0.00001;
}

// ═══════════════════ الألوان ═══════════════════
const COLOR_PRESET_ALIASES = {
  white: 'white', wh: 'white', w: 'white', 'ابيض': 'white', 'ابيض لؤلؤي': 'white', 'off white': 'white',
  black: 'black', bk: 'black', b: 'black', 'اسود': 'black', 'اسود مطفي': 'black',
  gold: 'gold', gd: 'gold', fgd: 'gold', golden: 'gold', 'ذهبي': 'gold', 'دهبي': 'gold', 'ذهب': 'gold',
  none: 'none', 'بدون': 'none', 'بدون لون': 'none', 'لا يوجد': 'none', na: 'none', 'n/a': 'none',
};

const COLOR_NAMED_HEX = {
  silver: '#c0c0c0', 'فضي': '#c0c0c0', 'فضه': '#c0c0c0',
  bronze: '#cd7f32', 'برونزي': '#cd7f32', 'برونز': '#cd7f32',
  copper: '#b87333', 'نحاسي': '#b87333', 'نحاس': '#b87333',
  chrome: '#cfd4d8', 'كروم': '#cfd4d8',
  nickel: '#b5b8b1', 'نيكل': '#b5b8b1',
  beige: '#e8d9b5', 'بيج': '#e8d9b5',
  ivory: '#f7f2e3', 'عاجي': '#f7f2e3',
  cream: '#f3e9d2', 'كريمي': '#f3e9d2',
  gray: '#8a8a8a', grey: '#8a8a8a', 'رمادي': '#8a8a8a', 'سكني': '#8a8a8a',
  brown: '#8b5a2b', 'بني': '#8b5a2b', 'خشبي': '#8b5a2b', wood: '#8b5a2b',
  red: '#c0392b', 'احمر': '#c0392b',
  blue: '#2c6fbb', 'ازرق': '#2c6fbb',
  green: '#3a8f5a', 'اخضر': '#3a8f5a',
  yellow: '#e8c547', 'اصفر': '#e8c547',
  amber: '#d99a2b', 'كهرماني': '#d99a2b',
  rose: '#d18a8a', 'وردي': '#d18a8a', pink: '#d18a8a',
  champagne: '#e6d1a8', 'شامبين': '#e6d1a8', 'شمبين': '#e6d1a8',
  'antique gold': '#b8912f', 'ذهبي عتيق': '#b8912f',
  'black gold': '#2b2b2b', 'اسود وذهبي': '#2b2b2b', 'bk+gd': '#2b2b2b',
  transparent: '#dfe8ef', 'شفاف': '#dfe8ef', crystal: '#dfe8ef', 'كريستال': '#dfe8ef',
};

// تُرجِع: { preset, hex } أو { skip: true, warning? }
function parseColorCell(raw) {
  if (raw === '' || raw === null || raw === undefined) return { skip: true };
  if (isClearToken(raw)) return { preset: 'none', hex: null };

  const trimmed = String(raw).trim();

  if (/^#?[0-9a-fA-F]{6}$/.test(trimmed)) {
    const hex = (trimmed.startsWith('#') ? trimmed : `#${trimmed}`).toLowerCase();
    const basic = { '#ffffff': 'white', '#f5f2ea': 'white', '#000000': 'black', '#14110c': 'black', '#d4a030': 'gold' };
    if (basic[hex]) return { preset: basic[hex], hex: null };
    return { preset: 'custom', hex };
  }
  if (/^#[0-9a-fA-F]{3}$/.test(trimmed)) {
    const short = trimmed.replace('#', '');
    const hex = `#${short.split('').map((c) => c + c).join('')}`.toLowerCase();
    return { preset: 'custom', hex };
  }

  const key = normalizeText(trimmed);
  if (COLOR_PRESET_ALIASES[key]) return { preset: COLOR_PRESET_ALIASES[key], hex: null };
  if (COLOR_NAMED_HEX[key]) return { preset: 'custom', hex: COLOR_NAMED_HEX[key] };

  for (const [nm, hex] of Object.entries(COLOR_NAMED_HEX)) {
    if (key.includes(nm)) return { preset: 'custom', hex };
  }
  const words = key.split(/[\s/+\-]+/);
  for (const [nm, preset] of Object.entries(COLOR_PRESET_ALIASES)) {
    if (words.includes(nm)) return { preset, hex: null };
  }

  return { skip: true, warning: `قيمة اللون "${trimmed}" غير مفهومة — تم تجاهل عمود اللون لهذا الصف` };
}

const COLOR_LABEL = { white: 'أبيض', black: 'أسود', gold: 'ذهبي', none: 'بدون لون', custom: 'مخصص' };
function colorDisplay(preset, hex) {
  if (!preset || preset === 'none') return 'بدون لون';
  if (preset === 'custom') return `مخصص (${hex || '—'})`;
  return COLOR_LABEL[preset] || preset;
}

// ═══════════════════ الوحدات ═══════════════════
const UNIT_ALIASES = {
  piece: 'piece', pcs: 'piece', pc: 'piece', 'قطعة': 'piece', 'قطعه': 'piece', 'حبة': 'piece', 'عدد': 'piece',
  meter: 'meter', m: 'meter', mt: 'meter', 'متر': 'meter',
  cm: 'cm', 'سم': 'cm', 'سنتيمتر': 'cm',
  liter: 'liter', l: 'liter', 'لتر': 'liter',
  kg: 'kg', 'كجم': 'kg', 'كيلو': 'kg', 'كيلوجرام': 'kg',
  set: 'set', 'طقم': 'set', 'مجموعة': 'set',
};
const UNIT_LABEL = { piece: 'قطعة', meter: 'متر', cm: 'سم', liter: 'لتر', kg: 'كجم', set: 'طقم' };

function parseUnit(raw) {
  if (!raw) return null;
  const key = normalizeText(raw);
  return UNIT_ALIASES[key] || (VALID_UNITS.includes(key) ? key : null);
}

// ═══════════════════ خريطة الأعمدة (Header Mapping) ═══════════════════
// بنقرأ صف العناوين مرة واحدة ونبني خريطة: اسم الحقل → رقم العمود.
// الفايدة: ملف فيه عمودين بنفس العنوان (زي عمودين اسمهم name) ما بيضيّعش
// بيانات — العمود المكرّر بيتسجّل كتحذير وبيتجاهل بدل ما يطمس عمود تاني.
const COLUMN_ALIASES = {
  name: ['name', 'اسم المنتج', 'الاسم', 'المنتج', 'product name', 'product'],
  sku: ['sku', 'الكود', 'كود', 'كود المنتج', 'code', 'item code', 'كود الصنف', 'رقم الصنف'],
  barcode: ['barcode', 'الباركود', 'باركود'],
  category: ['category', 'التصنيف', 'الفئة', 'category name', 'القسم'],
  unit: ['unit', 'الوحدة', 'وحدة القياس'],
  unit_measurement: ['unit measurement', 'المقاس', 'المقياس'],
  color: ['color', 'اللون', 'colour', 'color preset'],
  cost_price: ['cost price', 'سعر التكلفة', 'التكلفة', 'cost', 'سعر الشراء'],
  sale_price: ['sale price', 'سعر البيع', 'السعر', 'price', 'selling price'],
  min_stock_threshold: ['min stock threshold', 'حد التنبيه', 'الحد الأدنى', 'min stock', 'حد الطلب'],
  description: ['description', 'الوصف', 'ملاحظات', 'notes', 'تفاصيل'],
};

const ALIAS_TO_FIELD = (() => {
  const m = new Map();
  for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
    for (const a of aliases) m.set(normalizeHeader(a), field);
  }
  return m;
})();

function buildHeaderMap(headerRow) {
  const map = {};              // field -> column index
  const duplicates = [];       // عناوين مكررة تم تجاهلها
  const unknown = [];          // عناوين مش معروفة للنظام
  headerRow.forEach((raw, idx) => {
    const text = String(raw === null || raw === undefined ? '' : raw).trim();
    if (!text) return;
    const field = ALIAS_TO_FIELD.get(normalizeHeader(text));
    if (!field) { unknown.push(text); return; }
    if (map[field] !== undefined) {
      duplicates.push({ header: text, column: idx + 1, field });
      return;
    }
    map[field] = idx;
  });
  return { map, duplicates, unknown };
}

function cellAt(row, map, field) {
  const idx = map[field];
  if (idx === undefined) return '';
  const v = row[idx];
  if (v === null || v === undefined) return '';
  return String(v).trim();
}

// ═══════════════════ الحقول القابلة للتحديث ═══════════════════
const FIELD_LABELS = {
  name: 'اسم المنتج',
  barcode: 'الباركود',
  category_id: 'التصنيف',
  unit: 'وحدة القياس',
  unit_measurement: 'المقاس',
  allow_fractional_qty: 'كميات كسرية',
  color_preset: 'اللون',
  color_hex: 'كود اللون',
  cost_price: 'سعر التكلفة',
  sale_price: 'سعر البيع',
  min_stock_threshold: 'حد التنبيه',
  description: 'الوصف',
};
const NUMERIC_FIELDS = new Set(['unit_measurement', 'cost_price', 'sale_price', 'min_stock_threshold', 'allow_fractional_qty']);

// ═══════════════════ GET /api/import/template ═══════════════════
router.get('/template', authorize('admin', 'manager', 'warehouse'), async (req, res) => {
  const headers = [
    'name', 'sku', 'barcode', 'category', 'unit', 'unit_measurement', 'color',
    'cost_price', 'sale_price', 'min_stock_threshold', 'description',
  ];
  const sampleRows = [
    ['نجف كريستال فاخر 12 ذراع', 'NJF-001', '', 'نجف كريستال', 'piece', '', 'gold', '500', '850', '5', 'نجف كريستال 12 لمبة'],
    ['سبوت لايت LED 12 وات', 'SPT-012', '', 'إضاءة LED', 'piece', '', 'أبيض', '45', '75', '20', ''],
    ['شريط LED مرن', 'LED-STR', '', 'إضاءة LED', 'meter', '1', '#C9A227', '30', '55', '10', 'يُباع بالمتر'],
  ];

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([headers, ...sampleRows]);
  ws['!cols'] = headers.map((h) => ({ wch: Math.max(14, h.length + 4) }));
  XLSX.utils.book_append_sheet(wb, ws, 'المنتجات');

  const guide = [
    ['كيف يعمل الاستيراد؟', ''],
    ['المطابقة', 'يتم التعرّف على المنتج أولاً بالكود SKU، ثم بالباركود، ثم باسم المنتج'],
    ['منتج مطابق تماماً', 'يتم تجاوزه بدون أي تعديل'],
    ['منتج موجود ببيانات مختلفة', 'يتم تحديث الأعمدة المختلفة فقط، مع تقرير بالتغييرات'],
    ['منتج جديد', 'تتم إضافته مع تهيئة المخزون بصفر في كل المواقع'],
    ['خانة فارغة', 'تُتجاهل تماماً ولا تمسح البيانات الموجودة في النظام'],
    ['لمسح قيمة صراحةً', 'اكتب كلمة CLEAR في الخانة (للوصف أو اللون)'],
    ['المخزون', 'الاستيراد لا يغيّر الكميات إطلاقاً — التعديل على الكميات من صفحة المخزون'],
    ['تحذير مهم', 'لا تكرّر عنوان عمود مرتين (مثلاً عمودين باسم name) — العمود المكرر سيتم تجاهله'],
    ['', ''],
    ['دليل الألوان (عمود color)', 'القيمة المخزّنة'],
    ['white / wh / أبيض', 'أبيض'],
    ['black / bk / أسود', 'أسود'],
    ['gold / gd / fgd / ذهبي', 'ذهبي'],
    ['none / بدون لون', 'بدون لون'],
    ['#C9A227 (كود Hex)', 'لون مخصص بنفس الكود'],
    ['silver / فضي', 'لون مخصص #C0C0C0'],
    ['bronze / برونزي', 'لون مخصص #CD7F32'],
    ['copper / نحاسي', 'لون مخصص #B87333'],
    ['chrome / كروم', 'لون مخصص #CFD4D8'],
    ['champagne / شامبين', 'لون مخصص #E6D1A8'],
    ['crystal / كريستال / شفاف', 'لون مخصص #DFE8EF'],
    ['', ''],
    ['الوحدات المدعومة', 'piece / قطعة · meter / متر · cm / سم · liter / لتر · kg / كجم · set / طقم'],
    ['ملاحظة على المقاس', 'عمود unit_measurement رقم فقط، ومطلوب فقط مع وحدة سم أو متر — اتركه فارغاً مع "قطعة"'],
  ];
  const wsGuide = XLSX.utils.aoa_to_sheet(guide);
  wsGuide['!cols'] = [{ wch: 34 }, { wch: 70 }];
  XLSX.utils.book_append_sheet(wb, wsGuide, 'دليل الاستيراد');

  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename="product_import_template.xlsx"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buffer);
});

// ═══════════════════ POST /api/import/products ═══════════════════
router.post('/products', authorize('admin', 'manager', 'warehouse'), upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'يرجى رفع ملف Excel أو CSV' });
  }

  const cleanupTemp = () => {
    try { if (req.file && fs.existsSync(req.file.path)) fs.unlink(req.file.path, () => {}); } catch (_) {}
  };

  try {
    const workbook = XLSX.readFile(req.file.path);
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) {
      cleanupTemp();
      return res.status(400).json({ error: 'الملف لا يحتوي على أي ورقة عمل' });
    }
    // القراءة كمصفوفات (header: 1) — مش ككائنات — عشان نتحكّم في الأعمدة
    // بالموضع ونتعامل مع العناوين المكررة بأمان بدل ما SheetJS يدمجها.
    const matrix = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: '', blankrows: false });
    cleanupTemp();

    if (matrix.length < 2) {
      return res.status(400).json({ error: 'الملف فارغ أو لا يحتوي على بيانات صحيحة (يجب أن يحتوي على صف عناوين + صف بيانات واحد على الأقل)' });
    }

    const { map: colMap, duplicates: dupHeaders, unknown: unknownHeaders } = buildHeaderMap(matrix[0]);

    if (colMap.name === undefined) {
      return res.status(400).json({
        error: 'لم يتم العثور على عمود اسم المنتج (name) في صف العناوين. العناوين الموجودة في الملف: '
          + matrix[0].filter((h) => String(h || '').trim()).join(' | '),
      });
    }

    const rows = matrix.slice(1);
    if (rows.length > 5000) {
      return res.status(400).json({ error: 'الملف كبير جداً (أكثر من 5000 صف). يرجى تقسيمه على دفعات' });
    }

    // ── بيانات مرجعية مرة واحدة ──
    const categories = await all(`SELECT id, name FROM categories`);
    const categoryByName = new Map();
    categories.forEach((c) => categoryByName.set(normalizeText(c.name), { id: c.id, name: c.name }));

    const locations = await all(`SELECT id FROM locations WHERE is_active = 1`);

    const existing = await all(`SELECT * FROM products`);
    const bySku = new Map();
    const byBarcode = new Map();
    const byName = new Map();
    for (const p of existing) {
      if (p.sku) bySku.set(normalizeText(p.sku), p);
      if (p.barcode) byBarcode.set(normalizeText(p.barcode), p);
      const nk = normalizeText(p.name);
      if (byName.has(nk)) byName.set(nk, 'AMBIGUOUS');
      else byName.set(nk, p);
    }

    const report = { created: [], updated: [], unchanged: [], errors: [], warnings: [], categories_created: [] };

    // تحذيرات على مستوى الملف كله (مرة واحدة، مش لكل صف)
    dupHeaders.forEach((d) => report.warnings.push({
      row: 1,
      warning: `العمود رقم ${d.column} بعنوان "${d.header}" مكرر — تم تجاهله بالكامل. لو المقصود كان عمود آخر (مثل sku) صحّح العنوان وأعد الرفع`,
    }));
    if (colMap.sku === undefined) {
      report.warnings.push({ row: 1, warning: 'لا يوجد عمود sku في الملف — ستتم المطابقة بالاسم فقط، وأي اسم مكرر سيُرفض' });
    }
    if (unknownHeaders.length) {
      report.warnings.push({ row: 1, warning: `أعمدة غير معروفة تم تجاهلها: ${unknownHeaders.join(' | ')}` });
    }

    function formatForReport(field, value, ctx) {
      if (field === 'category_id') {
        if (value === null || value === undefined) return 'غير مصنف';
        const c = categories.find((x) => x.id === Number(value));
        return c ? c.name : `#${value}`;
      }
      if (field === 'unit') return UNIT_LABEL[value] || value || '—';
      if (field === 'color_preset') return colorDisplay(value, ctx && ctx.color_hex);
      if (field === 'color_hex') return value || '—';
      if (field === 'allow_fractional_qty') return value ? 'مسموح' : 'غير مسموح';
      if (NUMERIC_FIELDS.has(field)) {
        const n = value === null || value === undefined ? 0 : Number(value);
        return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
      }
      if (value === null || value === undefined || value === '') return '—';
      return String(value);
    }

    for (let index = 0; index < rows.length; index++) {
      const row = rows[index];
      const rowNum = index + 2; // +1 للعنوان، +1 لأن العد يبدأ من 1
      const addWarning = (warning) => report.warnings.push({ row: rowNum, warning });

      try {
        const name = cellAt(row, colMap, 'name');
        const sku = cellAt(row, colMap, 'sku');
        const barcodeRaw = cellAt(row, colMap, 'barcode');
        const categoryName = cellAt(row, colMap, 'category');
        const unitRaw = cellAt(row, colMap, 'unit');
        const measurementRaw = cellAt(row, colMap, 'unit_measurement');
        const colorRaw = cellAt(row, colMap, 'color');
        const costRaw = cellAt(row, colMap, 'cost_price');
        const saleRaw = cellAt(row, colMap, 'sale_price');
        const minStockRaw = cellAt(row, colMap, 'min_stock_threshold');
        const descriptionRaw = cellAt(row, colMap, 'description');

        // صف فاضي فعلياً (أو فيه بقايا في عمود واحد بس زي وحدة قياس) — تجاهل صامت
        const identityValues = [name, sku, barcodeRaw, costRaw, saleRaw, descriptionRaw].some((v) => v !== '');
        if (!identityValues) continue;

        // صف بيكرّر صف العناوين (غلط شائع عند دمج ملفات) — نرفضه بوضوح بدل
        // ما نضيف منتج اسمه "name"
        if (ALIAS_TO_FIELD.get(normalizeHeader(name)) === 'name') {
          report.errors.push({ row: rowNum, error: `قيمة اسم المنتج هي "${name}" وهي عنوان عمود وليست اسماً حقيقياً — صحّح هذا الصف في الملف` });
          continue;
        }

        // ─── تحديد المنتج المطابق ───
        let match = null;
        let matchedBy = null;
        if (sku && bySku.has(normalizeText(sku))) {
          match = bySku.get(normalizeText(sku));
          matchedBy = 'sku';
        } else if (barcodeRaw && byBarcode.has(normalizeText(barcodeRaw))) {
          const cand = byBarcode.get(normalizeText(barcodeRaw));
          if (cand && cand !== 'AMBIGUOUS') { match = cand; matchedBy = 'barcode'; }
        } else if (!sku && name) {
          // المطابقة بالاسم بتتم فقط لو الصف مالوش SKU — لأن وجود SKU جديد
          // معناه إن المستخدم قاصد منتج مستقل بهوية جديدة.
          const candidate = byName.get(normalizeText(name));
          if (candidate === 'AMBIGUOUS') {
            report.errors.push({ row: rowNum, error: `يوجد أكثر من منتج بنفس الاسم "${name}" — أضف عمود sku لتحديد المنتج المقصود` });
            continue;
          }
          if (candidate) { match = candidate; matchedBy = 'name'; }
        }

        if (!match && !name) {
          report.errors.push({ row: rowNum, error: 'اسم المنتج مطلوب لإضافة منتج جديد' });
          continue;
        }

        // ─── التصنيف (مع إنشاء تلقائي للتصنيف غير الموجود) ───
        let categoryId; // undefined = العمود غير مذكور
        if (categoryName) {
          const cat = categoryByName.get(normalizeText(categoryName));
          if (cat) {
            categoryId = cat.id;
          } else {
            const newCatId = await insert(`INSERT INTO categories (name) VALUES (?)`, [categoryName]);
            const created = { id: newCatId, name: categoryName };
            categoryByName.set(normalizeText(categoryName), created);
            categories.push(created);
            report.categories_created.push({ id: newCatId, name: categoryName });
            categoryId = newCatId;
          }
        }

        // ─── الوحدة والمقاس ───
        let unit;
        if (unitRaw) {
          const parsed = parseUnit(unitRaw);
          if (!parsed) addWarning(`وحدة القياس "${unitRaw}" غير معروفة — تم تجاهلها`);
          else unit = parsed;
        }
        const effectiveUnit = unit !== undefined ? unit : (match ? match.unit : 'piece');
        const isMeasured = MEASURED_UNITS.includes(effectiveUnit);

        let measurement;
        if (measurementRaw !== '') {
          // خطأ شائع: كتابة اسم الوحدة ("قطعة"/"piece") داخل عمود المقاس.
          // ده مش رقم وبالتالي مش مقاس — نتجاهله بصمت بدل ما نغرق المستخدم
          // في تحذيرات لكل صف في الملف.
          const looksLikeUnitWord = parseUnit(measurementRaw) !== null;
          const m = toNumber(measurementRaw);
          if (m !== null && m > 0) {
            measurement = m;
          } else if (isMeasured) {
            report.errors.push({ row: rowNum, error: `المقاس غير صحيح لوحدة "${UNIT_LABEL[effectiveUnit]}" (عمود unit_measurement)` });
            continue;
          } else if (!looksLikeUnitWord) {
            addWarning(`قيمة المقاس "${measurementRaw}" غير صحيحة — تم تجاهلها`);
          }
        }
        if (isMeasured) {
          const effectiveMeasure = measurement !== undefined ? measurement : (match ? match.unit_measurement : null);
          if (!effectiveMeasure || effectiveMeasure <= 0) {
            report.errors.push({ row: rowNum, error: `المقاس مطلوب لوحدة "${UNIT_LABEL[effectiveUnit]}" (عمود unit_measurement)` });
            continue;
          }
        } else if (unit !== undefined) {
          measurement = null; // تحوّل صريح لوحدة غير مقاسية
        }

        // ─── اللون ───
        const colorParsed = parseColorCell(colorRaw);
        if (colorParsed.warning) addWarning(colorParsed.warning);

        // ─── الأرقام ───
        const costPrice = costRaw !== '' ? toNumber(costRaw) : undefined;
        const salePrice = saleRaw !== '' ? toNumber(saleRaw) : undefined;
        const minStock = minStockRaw !== '' ? toNumber(minStockRaw) : undefined;
        if (costRaw !== '' && costPrice === null) { report.errors.push({ row: rowNum, error: `سعر التكلفة "${costRaw}" ليس رقماً صحيحاً` }); continue; }
        if (saleRaw !== '' && salePrice === null) { report.errors.push({ row: rowNum, error: `سعر البيع "${saleRaw}" ليس رقماً صحيحاً` }); continue; }
        if (minStockRaw !== '' && minStock === null) { report.errors.push({ row: rowNum, error: `حد التنبيه "${minStockRaw}" ليس رقماً صحيحاً` }); continue; }
        if (costPrice !== undefined && costPrice < 0) { report.errors.push({ row: rowNum, error: 'سعر التكلفة لا يمكن أن يكون سالباً' }); continue; }
        if (salePrice !== undefined && salePrice < 0) { report.errors.push({ row: rowNum, error: 'سعر البيع لا يمكن أن يكون سالباً' }); continue; }

        // تنبيه تجاري (مش خطأ): البيع بأقل من التكلفة = خسارة — غالباً غلط إدخال
        const finalCost = costPrice !== undefined ? costPrice : (match ? Number(match.cost_price) : 0);
        const finalSale = salePrice !== undefined ? salePrice : (match ? Number(match.sale_price) : 0);
        if (finalSale > 0 && finalCost > 0 && finalSale < finalCost) {
          addWarning(`سعر البيع (${finalSale}) أقل من سعر التكلفة (${finalCost}) — تم الحفظ، لكن يُرجى المراجعة`);
        }

        // ─── الوصف ───
        let description;
        if (descriptionRaw !== '') description = isClearToken(descriptionRaw) ? null : descriptionRaw;

        // ─── الباركود: فحص التعارض قبل أي كتابة ───
        let barcode;
        if (barcodeRaw) {
          const owner = byBarcode.get(normalizeText(barcodeRaw));
          if (owner && owner !== 'AMBIGUOUS' && (!match || owner.id !== match.id)) {
            report.errors.push({ row: rowNum, error: `الباركود "${barcodeRaw}" مستخدم بالفعل لمنتج آخر (${owner.name})` });
            continue;
          }
          barcode = barcodeRaw;
        }

        // ══════════════ (أ) منتج موجود → مقارنة وتحديث ══════════════
        if (match) {
          const desired = {};
          if (name && matchedBy !== 'name') desired.name = name;
          if (barcode !== undefined) desired.barcode = barcode;
          if (categoryId !== undefined) desired.category_id = categoryId;
          if (unit !== undefined) desired.unit = unit;
          if (measurement !== undefined) desired.unit_measurement = measurement;
          if (unit !== undefined) desired.allow_fractional_qty = MEASURED_UNITS.includes(unit) ? 1 : (match.allow_fractional_qty ? 1 : 0);
          if (!colorParsed.skip) {
            desired.color_preset = colorParsed.preset;
            desired.color_hex = colorParsed.hex;
          }
          if (costPrice !== undefined) desired.cost_price = costPrice;
          if (salePrice !== undefined) desired.sale_price = salePrice;
          if (minStock !== undefined) desired.min_stock_threshold = minStock;
          if (description !== undefined) desired.description = description;

          const changes = [];
          for (const [field, newVal] of Object.entries(desired)) {
            const oldVal = match[field];
            const same = NUMERIC_FIELDS.has(field)
              ? numEq(oldVal, newVal)
              : String(oldVal === null || oldVal === undefined ? '' : oldVal) === String(newVal === null || newVal === undefined ? '' : newVal);
            if (same) continue;
            changes.push({
              field,
              label: FIELD_LABELS[field] || field,
              old: formatForReport(field, oldVal, match),
              new: formatForReport(field, newVal, Object.assign({}, match, desired)),
            });
          }

          if (changes.length === 0) {
            report.unchanged.push({ row: rowNum, product_id: match.id, sku: match.sku, name: match.name, matched_by: matchedBy });
            continue;
          }

          const setFields = Object.keys(desired);
          const setClause = setFields.map((f) => `${f} = ?`).join(', ');
          const params = setFields.map((f) => desired[f]);
          params.push(match.id);

          await transaction(async () => {
            await run(`UPDATE products SET ${setClause}, updated_at = datetime('now') WHERE id = ?`, params);
            // ضمان وجود صف مخزون لكل موقع نشط (بصفر) — ما بيغيّرش أي كمية قائمة
            for (const loc of locations) {
              const exists = await get(`SELECT id FROM inventory WHERE product_id = ? AND location_id = ?`, [match.id, loc.id]);
              if (!exists) await insert(`INSERT INTO inventory (product_id, location_id, quantity) VALUES (?, ?, 0)`, [match.id, loc.id]);
            }
          });

          Object.assign(match, desired);
          if (desired.barcode) byBarcode.set(normalizeText(desired.barcode), match);

          await logAction(req.user.id, 'import_update', 'product', match.id, {
            source: 'bulk_import', matched_by: matchedBy,
            changes: changes.map((c) => ({ field: c.field, old: c.old, new: c.new })),
          });

          report.updated.push({ row: rowNum, product_id: match.id, sku: match.sku, name: match.name, matched_by: matchedBy, changes });
          continue;
        }

        // ══════════════ (ب) منتج جديد → إضافة ══════════════
        const newSku = sku || await generateSKU();
        const newBarcode = barcode || await generateBarcode();
        const newUnit = unit !== undefined ? unit : 'piece';
        const newIsMeasured = MEASURED_UNITS.includes(newUnit);
        const newMeasure = newIsMeasured ? (measurement === undefined ? null : measurement) : null;

        const newProductId = await transaction(async () => {
          const id = await insert(
            `INSERT INTO products (sku, barcode, name, category_id, unit, unit_measurement, color_preset, color_hex, allow_fractional_qty, cost_price, sale_price, min_stock_threshold, description)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              newSku,
              newBarcode,
              name,
              categoryId !== undefined ? categoryId : null,
              newUnit,
              newMeasure,
              colorParsed.skip ? 'none' : colorParsed.preset,
              colorParsed.skip ? null : colorParsed.hex,
              newIsMeasured ? 1 : 0,
              costPrice === undefined ? 0 : costPrice,
              salePrice === undefined ? 0 : salePrice,
              minStock === undefined ? 0 : minStock,
              description === undefined ? null : description,
            ]
          );
          for (const loc of locations) {
            await insert(`INSERT INTO inventory (product_id, location_id, quantity) VALUES (?, ?, 0)`, [id, loc.id]);
          }
          return id;
        });

        // إضافة للفهارس عشان أي صف مكرر في نفس الملف يتحوّل لتحديث مش تكرار
        const cached = {
          id: newProductId, sku: newSku, barcode: newBarcode, name,
          category_id: categoryId !== undefined ? categoryId : null,
          unit: newUnit, unit_measurement: newMeasure,
          color_preset: colorParsed.skip ? 'none' : colorParsed.preset,
          color_hex: colorParsed.skip ? null : colorParsed.hex,
          allow_fractional_qty: newIsMeasured ? 1 : 0,
          cost_price: costPrice === undefined ? 0 : costPrice,
          sale_price: salePrice === undefined ? 0 : salePrice,
          min_stock_threshold: minStock === undefined ? 0 : minStock,
          description: description === undefined ? null : description,
        };
        bySku.set(normalizeText(newSku), cached);
        byBarcode.set(normalizeText(newBarcode), cached);
        const nk = normalizeText(name);
        byName.set(nk, byName.has(nk) ? 'AMBIGUOUS' : cached);

        await logAction(req.user.id, 'import_create', 'product', newProductId, { source: 'bulk_import', sku: newSku, name });

        report.created.push({ row: rowNum, product_id: newProductId, sku: newSku, name });
      } catch (err) {
        report.errors.push({ row: rowNum, error: err.message });
      }
    }

    await logAction(req.user.id, 'bulk_import', 'product', null, {
      total_rows: rows.length,
      created: report.created.length,
      updated: report.updated.length,
      unchanged: report.unchanged.length,
      errors: report.errors.length,
    });

    const createdCount = report.created.length;
    const updatedCount = report.updated.length;
    const unchangedCount = report.unchanged.length;

    res.json({
      message: `تمت المزامنة: ${createdCount} جديد · ${updatedCount} مُحدَّث · ${unchangedCount} مطابق`,
      total_rows: rows.length,
      // مفاتيح متوافقة مع الواجهة القديمة (imported = كل ما تم قبوله فعلياً)
      imported: createdCount + updatedCount + unchangedCount,
      failed: report.errors.length,
      created: createdCount,
      updated: updatedCount,
      unchanged: unchangedCount,
      created_details: report.created,
      updated_details: report.updated,
      unchanged_details: report.unchanged,
      categories_created: report.categories_created,
      success_details: [...report.created, ...report.updated],
      error_details: report.errors,
      warning_details: report.warnings,
    });
  } catch (err) {
    console.error('Import error:', err);
    cleanupTemp();
    res.status(500).json({ error: 'حدث خطأ أثناء قراءة الملف: ' + err.message });
  }
});

module.exports = router;
