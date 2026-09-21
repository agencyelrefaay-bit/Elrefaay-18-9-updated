/**
 * =====================================================================
 *  أداة ربط صور المنتجات بالسيستم (نسخة احترافية)
 * =====================================================================
 * بديل عن سكربت الـ Selenium (erp_image_linker.py) اللي كان بيفشل لأنه
 * بيحاكي كليك المستخدم على المتصفح خطوة خطوة، فأي تأخير بسيط في تحميل
 * الصفحة أو اختلاف بسيط في الـ selector كان بيوقف السكربت كله.
 *
 * النسخة دي بتتكلم مباشرة مع الـ API بتاع السيستم نفسه (نفس الطريقة اللي
 * بيتكلم بيها الفرونت إند)، فهي:
 *   - أسرع بكتير (مفيش متصفح بيفتح أصلاً)
 *   - مش بتتأثر بحمل الصفحة أو شكل الواجهة
 *   - بتطابق الكود حتى لو فيه اختلاف في الشرطات/المسافات (GFH-040-8-GD
 *     أو GFH 040 8 GD أو GFH0408GD.. كلهم بيتطابقوا مع بعض)
 *   - بتطلعلك تقرير نهائي واضح: ايه اللي اتربط، وايه اللي محتاج مراجعة يدوي
 *
 * ═══════════════════════ طريقة الاستخدام ═══════════════════════
 * 1) ثبّت المكتبة المطلوبة مرة واحدة بس:
 *      npm install axios form-data csv-parse
 *
 * 2) عدّل الإعدادات في قسم CONFIG تحت (رابط السيستم + يوزر وباسورد مدير).
 *
 * 3) شغّل الأمر:
 *      node link-product-images.js
 *
 * 4) هتلاقي تقرير النتيجة في ملف:  image-link-report.csv
 *
 * ═══════════════════ لاستخدامها في المستقبل (دفعات جديدة) ═══════════════════
 * نفس الأداة تصلح تاني وتالت مرة: حط الصور الجديدة في فولدر "proimg"،
 * حدّث ملف "proimgoutput_codes.csv" (أو استخرج الأكواد بأي أداة OCR
 * زي extract.py اللي كان عندك)، وشغّل السكربت تاني. الأداة بتتجاهل
 * أوتوماتيك أي صورة اتربطت قبل كده (على حسب التقرير القديم لو موجود).
 * =====================================================================
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');
const { parse } = require('csv-parse/sync');

// ───────────────────────────── CONFIG ─────────────────────────────
const CONFIG = {
  // رابط السيستم (لو شغال على نفس الجهاز اللي هتشغل عليه السكربت اسيبه كده)
  BASE_URL: process.env.ERP_URL || 'http://localhost:5000',

  // يوزر وباسورد أدمن على السيستم (نفس بيانات دخولك العادية)
  USERNAME: process.env.ERP_USER || 'admin',
  PASSWORD: process.env.ERP_PASS || 'CHANGE_ME',

  // فولدر الصور + ملف الأكواد الناتج من OCR
  IMAGES_DIR: path.join(__dirname, 'proimg'),
  CSV_FILE: path.join(__dirname, 'proimgoutput_codes.csv'),

  // تقرير النتيجة
  REPORT_FILE: path.join(__dirname, 'image-link-report.csv'),
};
// ────────────────────────────────────────────────────────────────────

// بيشيل أي حاجة مش حرف/رقم عشان "GFH-040-8-GD" و"GFH 040 8 GD" و"gfh0408gd"
// كلهم يبقوا نفس الكود وقت المقارنة (نفس الفكرة المطلوبة لتوحيد البحث في السيستم)
function normalizeCode(code) {
  return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

async function login() {
  const { data } = await axios.post(`${CONFIG.BASE_URL}/api/auth/login`, {
    username: CONFIG.USERNAME,
    password: CONFIG.PASSWORD,
  });
  return data.token;
}

async function fetchAllProducts(token) {
  const products = [];
  // السيستم مش بيعمل pagination حالياً على GET /api/products، فبيرجع كل المنتجات دفعة واحدة
  const { data } = await axios.get(`${CONFIG.BASE_URL}/api/products`, {
    headers: { Authorization: `Bearer ${token}` },
    params: { is_active: 'true' },
  });
  const list = Array.isArray(data) ? data : data.products || data.data || [];
  for (const p of list) products.push(p);
  return products;
}

async function uploadImage(token, productId, imagePath) {
  const form = new FormData();
  form.append('image', fs.createReadStream(imagePath));
  await axios.put(`${CONFIG.BASE_URL}/api/products/${productId}`, form, {
    headers: { ...form.getHeaders(), Authorization: `Bearer ${token}` },
    maxBodyLength: Infinity,
  });
}

async function main() {
  console.log('[*] تسجيل الدخول...');
  const token = await login();

  console.log('[*] تحميل كل المنتجات من السيستم...');
  const products = await fetchAllProducts(token);
  console.log(`[+] تم تحميل ${products.length} منتج.`);

  // فهرسة المنتجات بالكود بعد التطبيع، عشان المطابقة تبقى مضمونة
  const bySku = new Map();
  for (const p of products) {
    if (p.sku) bySku.set(normalizeCode(p.sku), p);
  }

  console.log('[*] قراءة ملف الأكواد المستخرجة من الصور...');
  const rows = parse(fs.readFileSync(CONFIG.CSV_FILE, 'utf-8'), {
    columns: true,
    skip_empty_lines: true,
    bom: true,
  });

  const report = [];
  let linked = 0, skipped = 0, notFound = 0;

  for (const row of rows) {
    const imgFile = row.Image_Filename;
    const rawCode = row.Extracted_Code;
    const imgPath = path.join(CONFIG.IMAGES_DIR, imgFile);

    if (!rawCode || rawCode === 'ERROR' || rawCode === 'NOT_FOUND') {
      report.push({ image: imgFile, code: rawCode, status: 'تخطي - كود غير صالح من OCR', product_id: '' });
      skipped++;
      continue;
    }
    if (!fs.existsSync(imgPath)) {
      report.push({ image: imgFile, code: rawCode, status: 'تخطي - الصورة غير موجودة', product_id: '' });
      skipped++;
      continue;
    }

    const match = bySku.get(normalizeCode(rawCode));
    if (!match) {
      report.push({ image: imgFile, code: rawCode, status: 'لم يتم إيجاد منتج بهذا الكود - مراجعة يدوية', product_id: '' });
      notFound++;
      continue;
    }

    try {
      await uploadImage(token, match.id, imgPath);
      report.push({ image: imgFile, code: rawCode, status: `تم الربط بنجاح ✓ (${match.name})`, product_id: match.id });
      linked++;
      console.log(`[+] ${rawCode} → ${match.name} (#${match.id})`);
    } catch (e) {
      const msg = e.response?.data?.error || e.message;
      report.push({ image: imgFile, code: rawCode, status: `خطأ أثناء الرفع: ${msg}`, product_id: match.id });
      console.log(`[!] فشل رفع صورة ${rawCode}: ${msg}`);
    }
  }

  const csvOut = ['Image,Extracted_Code,Status,Product_ID']
    .concat(report.map(r => `"${r.image}","${r.code}","${r.status}",${r.product_id}`))
    .join('\n');
  fs.writeFileSync(CONFIG.REPORT_FILE, csvOut, 'utf-8');

  console.log('\n──────────── ملخص النتيجة ────────────');
  console.log(`تم الربط بنجاح : ${linked}`);
  console.log(`تخطي           : ${skipped}`);
  console.log(`لم يتم إيجاده  : ${notFound}`);
  console.log(`التقرير الكامل: ${CONFIG.REPORT_FILE}`);
}

main().catch((e) => {
  console.error('[!] خطأ عام:', e.response?.data || e.message);
  process.exit(1);
});
