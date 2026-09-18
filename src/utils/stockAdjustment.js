// utils/stockAdjustment.js
//
// نواة تعديل المخزون — مستخرجة حرفياً من POST /api/inventory/adjust
// (src/routes/inventory.js) من غير أي تغيير في السلوك، عشان نضمن إن
// أي مسار تاني في التطبيق يحتاج يغيّر رصيد مخزون حقيقي (زي اعتماد جرد
// فعلي) يمر بنفس المنطق المُدقَّق بالظبط — مش نسخة تانية منه.
//
// لازم يتنفذ الاستدعاء ده جوه transaction() (من db/database.js) عشان
// الـ FOR UPDATE يحمي من race conditions بين تعديلين متزامنين.
const { get, run, insert } = require('../db/database');

// أنواع الحركة المدعومة (نفس القائمة المستخدمة في /adjust بالظبط):
//   in         → إضافة الكمية المُدخلة إلى الرصيد الحالي (وارد)
//   out        → خصم الكمية المُدخلة من الرصيد الحالي (صادر) — ما ينتجش رصيد سالب
//   adjustment → استبدال الرصيد الحالي بالكامل بالرقم المُدخل (تسوية مخزون)
async function applyStockAdjustment({ product, location_id, movement_type, inputQty, notes, user_id, reference_type }) {
  // FOR UPDATE عشان تعديلين متزامنين على نفس المنتج/المخزن ماياخدوش نفس
  // الكمية القديمة كنقطة بداية (نفس فئة مشكلة overselling بالظبط)
  const inv = await get(`SELECT * FROM inventory WHERE product_id = ? AND location_id = ? FOR UPDATE`, [product.id, location_id]);
  const qtyBefore = inv ? inv.quantity : 0;

  let newQty;
  if (movement_type === 'in') newQty = qtyBefore + inputQty;
  else if (movement_type === 'out') newQty = qtyBefore - inputQty;
  else newQty = inputQty; // adjustment: استبدال مطلق

  if (newQty < 0) {
    const err = new Error(`الكمية المطلوب خصمها (${inputQty}) أكبر من الرصيد الحالي (${qtyBefore})`);
    err.status = 400;
    throw err;
  }
  if (!product.allow_fractional_qty && newQty % 1 !== 0) {
    const err = new Error('هذا المنتج لا يسمح بكميات كسرية');
    err.status = 400;
    throw err;
  }

  if (inv) {
    await run(`UPDATE inventory SET quantity = ?, updated_at = datetime('now') WHERE product_id = ? AND location_id = ?`,
      [newQty, product.id, location_id]);
  } else {
    await insert(`INSERT INTO inventory (product_id, location_id, quantity) VALUES (?, ?, ?)`,
      [product.id, location_id, newQty]);
  }

  await insert(`INSERT INTO stock_movements
    (product_id, location_id, movement_type, quantity, quantity_before, quantity_after, reference_type, notes, user_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [product.id, location_id, movement_type, newQty - qtyBefore, qtyBefore, newQty, reference_type || 'manual_adjustment', notes || 'تعديل يدوي', user_id]);

  return { qtyBefore, newQty };
}

module.exports = { applyStockAdjustment };
