// utils/statementEngine.js
//
// محرّك كشف الحساب — مصدر واحد للحقيقة يُستخدم من شاشة العرض، الطباعة،
// PDF (المرحلة القادمة)، Excel (المرحلة القادمة)، ومشاركة واتساب (المرحلة
// القادمة). لا يُنشئ أي جدول مالي جديد — بيبني الكشف من نفس الجداول
// المستخدمة بالفعل في customerLedger.js / supplierLedger.js، وبيستخدم
// نفس معادلة الرصيد الموجودة فعلاً (لا يوجد حساب رصيد مُنافس).
//
// اتجاه الرصيد (نفس الاتفاق الموجود في customerLedger.js/supplierLedger.js):
//   عميل:  موجب = العميل مدين لنا (Amount Due from Customer)
//          سالب = رصيد دائن للعميل (Amount Payable to Customer)
//   مورد:  موجب = نحن مدينون للمورد (Amount Payable to Supplier)
//          سالب = رصيد لنا عند المورد (Amount Receivable from Supplier)
//
// ملحوظة معمارية مهمة: قسط العميل/المورد (customer_installments /
// payment_installments) مش حركة مالية مستقلة — هو مجرد "جدول سداد".
// الحركة المالية الحقيقية هي صف customer_payments/supplier_payments
// المرتبط بيه عبر installment.payment_id. فبنعرض كل صف دفعة مرة واحدة
// بس، ونسمّيه "دفعة قسط" لو مرتبط بقسط، وإلا "دفعة" عادية — عشان منعّدش
// نفس المبلغ مرتين.
const { get, all } = require('../db/database');
const { getCustomerBalance } = require('./customerLedger');
const { getSupplierBalance } = require('./supplierLedger');

const RECONCILE_EPSILON = 0.01; // فرق أقل من قرش واحد يُعتبر تقريب عائم، مش تضارب حقيقي

// نقطة توسّع مستقبلية: لإضافة نوع حركة جديد (زي PURCHASE_RETURN لما تتضاف
// مردودات المشتريات للنظام)، يكفي إضافة عنصر جديد هنا بنفس الشكل — منطق
// الدمج والترتيب والرصيد الجاري (buildLedger) عام ومش محتاج أي تعديل.

async function buildCustomerStatement({ accountId, dateFrom, dateTo }) {
  const customer = await get(`SELECT * FROM customers WHERE id = ?`, [accountId]);
  if (!customer) return null;

  // ── الرصيد الافتتاحي: كل حركة قبل بداية الفترة، بنفس معادلة customerLedger.js بالظبط ──
  let openingBalance = customer.opening_balance || 0;
  if (dateFrom) {
    const priorInvoices = await get(
      `SELECT COALESCE(SUM(total),0) as v FROM invoices WHERE customer_id = ? AND status NOT IN ('draft','cancelled') AND invoice_date < ?`,
      [accountId, dateFrom]
    );
    const priorPayments = await get(
      `SELECT COALESCE(SUM(amount),0) as v FROM customer_payments WHERE customer_id = ? AND payment_date < ?`,
      [accountId, dateFrom]
    );
    const priorReturns = await get(
      `SELECT COALESCE(SUM(total_refund),0) as v FROM sales_returns WHERE customer_id = ? AND status = 'completed' AND return_date < ?`,
      [accountId, dateFrom]
    );
    openingBalance += (priorInvoices.v || 0) - (priorPayments.v || 0) - (priorReturns.v || 0);
  }

  const dateParams = [accountId];
  let dateClause = '';
  if (dateFrom) { dateClause += ` AND {{DATE_COL}} >= ?`; dateParams.push(dateFrom); }
  if (dateTo)   { dateClause += ` AND {{DATE_COL}} <= ?`; dateParams.push(dateTo); }

  const invoiceRows = await all(
    `SELECT id, invoice_number as doc_number, invoice_date as txn_date, total as amount, status, payment_type
     FROM invoices WHERE customer_id = ? AND status NOT IN ('draft','cancelled') ${dateClause.replace(/{{DATE_COL}}/g, 'invoice_date')}
     ORDER BY invoice_date ASC, id ASC`,
    dateFrom || dateTo ? dateParams : [accountId]
  );

  const paymentRows = await all(
    `SELECT p.id, p.payment_number as doc_number, p.payment_date as txn_date, p.amount, p.payment_method,
            p.invoice_id, ci.id as installment_id
     FROM customer_payments p
     LEFT JOIN customer_installments ci ON ci.payment_id = p.id
     WHERE p.customer_id = ? ${dateClause.replace(/{{DATE_COL}}/g, 'p.payment_date')}
     ORDER BY p.payment_date ASC, p.id ASC`,
    dateFrom || dateTo ? dateParams : [accountId]
  );

  const returnRows = await all(
    `SELECT id, return_number as doc_number, return_date as txn_date, total_refund as amount
     FROM sales_returns WHERE customer_id = ? AND status = 'completed' ${dateClause.replace(/{{DATE_COL}}/g, 'return_date')}
     ORDER BY return_date ASC, id ASC`,
    dateFrom || dateTo ? dateParams : [accountId]
  );

  const transactions = [
    ...invoiceRows.map(r => ({
      date: r.txn_date, type: 'sale_invoice', type_label: 'فاتورة مبيعات',
      doc_number: r.doc_number, description: `فاتورة مبيعات رقم ${r.doc_number}`,
      debit: r.amount, credit: 0,
      reference: { type: 'invoice', id: r.id },
      sort_key: 2, // الفواتير قبل الدفعات في نفس اليوم (منطقي: البيع يسبق التحصيل)
    })),
    ...paymentRows.map(r => ({
      date: r.txn_date,
      type: r.installment_id ? 'installment_payment' : 'customer_payment',
      type_label: r.installment_id ? 'دفعة قسط' : 'دفعة عميل',
      doc_number: r.doc_number, description: r.installment_id ? `دفعة قسط — إيصال ${r.doc_number}` : `دفعة عميل — إيصال ${r.doc_number}`,
      debit: 0, credit: r.amount,
      reference: { type: 'customer_payment', id: r.id, invoice_id: r.invoice_id || null },
      sort_key: 3,
    })),
    ...returnRows.map(r => ({
      date: r.txn_date, type: 'sales_return', type_label: 'مردود مبيعات',
      doc_number: r.doc_number, description: `مردود مبيعات رقم ${r.doc_number}`,
      debit: 0, credit: r.amount,
      reference: { type: 'sales_return', id: r.id },
      sort_key: 1, // المردود يُسجَّل أول اليوم منطقياً (تصحيح على فاتورة سابقة)
    })),
  ];

  return finalizeStatement({
    account: customer, accountType: 'customer',
    openingBalance, transactions, dateFrom, dateTo,
    liveBalanceFn: () => getCustomerBalance(accountId),
    positiveMeaning: 'المبلغ المستحق من العميل', negativeMeaning: 'رصيد دائن للعميل (مبلغ مستحق للعميل)',
  });
}

async function buildSupplierStatement({ accountId, dateFrom, dateTo }) {
  const supplier = await get(`SELECT * FROM suppliers WHERE id = ?`, [accountId]);
  if (!supplier) return null;

  let openingBalance = supplier.opening_balance || 0;
  if (dateFrom) {
    const priorOrders = await get(
      `SELECT COALESCE(SUM(total),0) as v FROM purchase_orders WHERE supplier_id = ? AND status NOT IN ('draft','cancelled') AND order_date < ?`,
      [accountId, dateFrom]
    );
    const priorPayments = await get(
      `SELECT COALESCE(SUM(amount),0) as v FROM supplier_payments WHERE supplier_id = ? AND payment_date < ?`,
      [accountId, dateFrom]
    );
    openingBalance += (priorOrders.v || 0) - (priorPayments.v || 0);
  }

  const dateParams = [accountId];
  let dateClause = '';
  if (dateFrom) { dateClause += ` AND {{DATE_COL}} >= ?`; dateParams.push(dateFrom); }
  if (dateTo)   { dateClause += ` AND {{DATE_COL}} <= ?`; dateParams.push(dateTo); }

  const orderRows = await all(
    `SELECT id, po_number as doc_number, order_date as txn_date, total as amount, status
     FROM purchase_orders WHERE supplier_id = ? AND status NOT IN ('draft','cancelled') ${dateClause.replace(/{{DATE_COL}}/g, 'order_date')}
     ORDER BY order_date ASC, id ASC`,
    dateFrom || dateTo ? dateParams : [accountId]
  );

  const paymentRows = await all(
    `SELECT p.id, p.payment_number as doc_number, p.payment_date as txn_date, p.amount, p.payment_method,
            p.po_id, pi.id as installment_id
     FROM supplier_payments p
     LEFT JOIN payment_installments pi ON pi.payment_id = p.id
     WHERE p.supplier_id = ? ${dateClause.replace(/{{DATE_COL}}/g, 'p.payment_date')}
     ORDER BY p.payment_date ASC, p.id ASC`,
    dateFrom || dateTo ? dateParams : [accountId]
  );

  // ملحوظة: لا يوجد مردودات مشتريات في النظام الحالي (لا جدول ولا مسار API).
  // نقطة التوسّع: لإضافة PURCHASE_RETURN لاحقاً، يضاف مصدر بيانات هنا بنفس
  // شكل orderRows/paymentRows فوق — منطق finalizeStatement عام ومش هيتغيّر.

  const transactions = [
    ...orderRows.map(r => ({
      date: r.txn_date, type: 'purchase_order', type_label: 'أمر شراء',
      doc_number: r.doc_number, description: `أمر شراء رقم ${r.doc_number}`,
      debit: r.amount, credit: 0,
      reference: { type: 'purchase_order', id: r.id },
      sort_key: 2,
    })),
    ...paymentRows.map(r => ({
      date: r.txn_date,
      type: r.installment_id ? 'installment_payment' : 'supplier_payment',
      type_label: r.installment_id ? 'دفعة قسط' : 'دفعة مورد',
      doc_number: r.doc_number, description: r.installment_id ? `دفعة قسط — إيصال ${r.doc_number}` : `دفعة مورد — إيصال ${r.doc_number}`,
      debit: 0, credit: r.amount,
      reference: { type: 'supplier_payment', id: r.id, po_id: r.po_id || null },
      sort_key: 3,
    })),
  ];

  return finalizeStatement({
    account: supplier, accountType: 'supplier',
    openingBalance, transactions, dateFrom, dateTo,
    liveBalanceFn: () => getSupplierBalance(accountId),
    positiveMeaning: 'المبلغ المستحق للمورد', negativeMeaning: 'رصيد لنا عند المورد (مبلغ مستحق من المورد)',
  });
}

// ── دمج الحركات، ترتيبها زمنياً، حساب الرصيد الجاري، والتحقق من التطابق ──
function finalizeStatement({ account, accountType, openingBalance, transactions, dateFrom, dateTo, liveBalanceFn, positiveMeaning, negativeMeaning }) {
  transactions.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.sort_key - b.sort_key));

  let running = openingBalance;
  let totalDebit = 0, totalCredit = 0;
  const ledger = transactions.map(t => {
    running += t.debit - t.credit;
    totalDebit += t.debit;
    totalCredit += t.credit;
    const { sort_key, ...rest } = t;
    return { ...rest, running_balance: round2(running) };
  });

  const closingBalance = round2(running);

  return {
    account_type: accountType,
    account,
    period: { from: dateFrom || null, to: dateTo || null },
    opening_balance: round2(openingBalance),
    transactions: ledger,
    totals: { total_debit: round2(totalDebit), total_credit: round2(totalCredit) },
    closing_balance: closingBalance,
    status_label: closingBalance > 0.005 ? positiveMeaning : closingBalance < -0.005 ? negativeMeaning : 'الحساب مسوّى (لا يوجد رصيد مستحق)',
    reconciliation: null, // بيتحدد في buildStatement لو الفترة توصل لتاريخ اليوم
  };
}

function round2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }

// ── نقطة الدخول الوحيدة المستخدمة من كل الأماكن (شاشة/طباعة/PDF لاحقاً) ──
async function buildStatement({ accountType, accountId, dateFrom, dateTo }) {
  let statement;
  if (accountType === 'customer') statement = await buildCustomerStatement({ accountId, dateFrom, dateTo });
  else if (accountType === 'supplier') statement = await buildSupplierStatement({ accountId, dateFrom, dateTo });
  else throw Object.assign(new Error('نوع حساب غير معروف'), { status: 400 });

  if (!statement) return null;

  // ── التحقق من التطابق (Reconciliation) — لو الفترة وصلت لتاريخ اليوم أو
  // مفيش تاريخ نهاية أصلاً، لازم الرصيد الختامي يطابق الرصيد الحيّ الفعلي
  // من نفس ملف الـ ledger المستخدم في باقي النظام. أي فرق بيتسجّل صراحة
  // ومايتم إخفاؤه أبداً. ──
  const today = new Date().toISOString().slice(0, 10);
  const coversToToday = !dateFrom && !dateTo ? true : (!dateTo || dateTo >= today);
  if (coversToToday) {
    const live = await liveBalanceFnFor(statement);
    if (live) {
      const diff = round2(statement.closing_balance - live.balance);
      statement.reconciliation = {
        checked: true,
        live_balance: round2(live.balance),
        statement_closing_balance: statement.closing_balance,
        difference: diff,
        ok: Math.abs(diff) <= RECONCILE_EPSILON,
      };
      if (!statement.reconciliation.ok) {
        console.error(`⚠ عدم تطابق كشف حساب: ${statement.account_type} #${statement.account.id} — الفرق = ${diff}`);
      }
    }
  }

  return statement;

  async function liveBalanceFnFor(s) {
    return s.account_type === 'customer' ? getCustomerBalance(s.account.id) : getSupplierBalance(s.account.id);
  }
}

module.exports = { buildStatement };
