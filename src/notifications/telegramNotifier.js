// notifications/telegramNotifier.js
// ─── المُرسِل الموحّد الوحيد لتيليجرام في كل النظام ───
// أي رسالة تيليجرام في التطبيق كله لازم تعدّي من هنا. لو حبينا نضيف قناة
// تانية مستقبلاً (إيميل، واتساب...)، بنضيف ملف "Notifier" جديد بنفس الشكل
// (دالة async واحدة `notify(message)`) من غير ما نلمس أي موديول تجاري ولا
// حتى ملف المستمعين (listeners.js) — بنضيفه بس لمصفوفة القنوات النشطة.

const { get, insert } = require('../db/database');

function fmt(n) {
  const num = Number(n) || 0;
  return num.toLocaleString('ar-EG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtDate(d) {
  if (!d) return '—';
  try { return new Date(d).toLocaleDateString('ar-EG', { year: 'numeric', month: 'long', day: 'numeric' }); }
  catch { return d; }
}

// ── هل الإشعارات مفعّلة أصلاً؟ (إعداد عام من شاشة الإعدادات) ──
async function isNotificationsEnabled() {
  const settings = await get(`SELECT notifications_enabled FROM settings WHERE id=1`);
  return settings ? !!settings.notifications_enabled : true;
}

// ── منع تكرار نفس التنبيه (مهم جداً للتنبيهات الدورية زي المتأخر/القريب) ──
// event_key لازم يكون فريد ومحدَّد بشكل حتمي من نوع الحدث + التاريخ، مثلاً:
// "overdue_installment:123:2026-07-11" — يعني القسط 123 اتنبّه عليه فعلاً
// النهاردة، مش هيتكرر تاني النهاردة حتى لو الفحص الدوري شغّال كل شوية،
// لكن هيتنبّه عليه تاني بكرة لو لسه متأخر (يوم جديد = event_key جديد).
async function wasAlreadyNotified(eventKey) {
  const row = await get(`SELECT id FROM notification_log WHERE event_key=?`, [eventKey]);
  return !!row;
}

async function markAsNotified(eventKey, eventType) {
  try {
    await insert(`INSERT INTO notification_log (event_key, event_type) VALUES (?, ?)`, [eventKey, eventType]);
  } catch (e) {
    // لو حصل تعارض (race condition نادر: طلبين بعتوا نفس event_key في نفس
    // اللحظة) بفضل الـ UNIQUE constraint — نتجاهل بأمان، المهم إن واحد بس نجح
  }
}

// ── طابور إرسال متسلسل مع تباعد زمني ──────────────────────────────────
// تيليجرام بيسمح بحوالي 20 رسالة في الدقيقة للمجموعة الواحدة. الجدولة
// الدورية كانت بتطلق عشرات الإشعارات في نفس اللحظة بالتوازي، فتيليجرام كان
// بيرد 429 (Too Many Requests) ويرمي كل الرسائل. الحل: كل الرسائل بتعدّي من
// طابور واحد، رسالة ورا رسالة، بمسافة زمنية آمنة بينهم، مع احترام مدة
// الانتظار اللي تيليجرام نفسه بيطلبها (retry_after) وإعادة محاولة واحدة.
const SEND_GAP_MS = 1500;
let queueTail = Promise.resolve();
let lastSentAt = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function postToTelegram(botToken, chatId, message) {
  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'HTML', disable_web_page_preview: true }),
  });
  return res.json();
}

// ── الإرسال الفعلي الخام — أبداً ما يرمي استثناء، عشان فشل الإشعار محدش
//    يوقف أو يفشّل أي عملية تجارية حقيقية (فاتورة، دفعة، الخ).
//    بيرجّع true لو الرسالة وصلت فعلاً، و false غير كده. ──
async function sendText(message) {
  const task = queueTail.then(async () => {
    try {
      if (!(await isNotificationsEnabled())) return false;

      const botToken = process.env.TELEGRAM_BOT_TOKEN;
      const chatId = process.env.TELEGRAM_CHAT_ID;
      if (!botToken || !chatId) {
        console.warn('[Telegram] TELEGRAM_BOT_TOKEN أو TELEGRAM_CHAT_ID غير موجودين — تم تجاهل الإشعار');
        return false;
      }

      // تباعد إجباري عن آخر رسالة اتبعتت
      const since = Date.now() - lastSentAt;
      if (since < SEND_GAP_MS) await sleep(SEND_GAP_MS - since);

      let data = await postToTelegram(botToken, chatId, message);
      lastSentAt = Date.now();

      // 429: تيليجرام بيقولنا نستنى كام ثانية — نستناهم ونجرّب مرة واحدة بس
      if (!data.ok && data.error_code === 429) {
        const waitSec = (data.parameters && data.parameters.retry_after) || 5;
        await sleep((waitSec + 1) * 1000);
        data = await postToTelegram(botToken, chatId, message);
        lastSentAt = Date.now();
      }

      if (!data.ok) {
        console.warn('[Telegram] فشل إرسال الإشعار:', data.description);
        return false;
      }
      return true;
    } catch (err) {
      console.warn('[Telegram] خطأ في الاتصال بتيليجرام:', err.message);
      return false;
    }
  });
  // الطابور ما بيتكسرش أبداً حتى لو مهمة فشلت
  queueTail = task.then(() => {}, () => {});
  return task;
}

// ── إرسال بحماية من التكرار — يُستخدم للتنبيهات الدورية (الجدولة) فقط.
//    الأحداث الفورية (فاتورة اتعملت، دفعة اتحصّلت...) مش محتاجة dedup
//    لأنها بطبيعتها بتحصل مرة واحدة بالظبط وقت الحدث نفسه. ──
async function sendTextOnce(eventKey, eventType, message) {
  if (await wasAlreadyNotified(eventKey)) return false;
  const delivered = await sendText(message);
  // مهم: ما نسجّلش الحدث كـ"تم إشعاره" إلا لو الرسالة وصلت فعلاً — غير كده
  // كان الإشعار بيضيع للأبد لو تيليجرام رجّع خطأ مؤقت.
  if (!delivered) return false;
  await markAsNotified(eventKey, eventType);
  return true;
}

module.exports = { sendText, sendTextOnce, wasAlreadyNotified, markAsNotified, fmt, fmtDate };
