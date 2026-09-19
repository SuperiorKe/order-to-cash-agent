// Owner: Intake (A), closing the loop. An order whose item never matched the
// catalog is stored at KES 0 and the customer is told "we are confirming the
// price". This module is the step that was missing: the owner names the
// price, the invoice becomes real, and the customer gets exactly the
// confirmation + M-Pesa prompt they would have got had the item matched.
//
// Three callers, one path: the owner's SMS reply (routes/sms.js), the JSON
// API used by Friday and the dashboard (routes/api.js). All validation and
// side effects live here so they cannot drift apart.

const cfg = require('./config');
const db = require('./db');
const orders = require('./orders');
const invoices = require('./invoices');
const notify = require('./notify');
const mpesa = require('./mpesa');
const { fmtMoney } = require('./money');

class PricingError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    Object.assign(this, details);
  }
}

// HTTP status a PricingError maps to, for routes/api.js.
const HTTP_STATUS = {
  not_found: 404,
  already_paid: 409,
  nothing_to_price: 409,
  bad_amounts: 400,
  count_mismatch: 400,
};

const round2 = (n) => Math.round(n * 100) / 100;

// Amounts arrive as strings from SMS ("45,000", "45000.50") or numbers from
// JSON. Returns a clean positive number or null.
function parseAmount(v) {
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? round2(v) : null;
  const s = String(v ?? '').replace(/[,\s]/g, '').replace(/^(kes|ksh)/i, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const n = Number(s);
  return n > 0 ? n : null;
}

// Indexes of lines that still need a price, in order.
function unpricedLines(order) {
  return (order.items || [])
    .map((it, idx) => ({ it, idx }))
    .filter(({ it }) => orders.isUnpriced(it));
}

// Price the unpriced lines of the order behind an invoice.
//   amounts: one line total per unpriced line, in the order they appear.
//   by:      'sms' | 'api' — recorded in the audit trail.
// Resolves with { order, invoice, lines, total, followUp } or throws a
// PricingError. followUp is the result of the customer notification.
async function priceInvoice({ invoiceId, orderId, amounts, by, actor }) {
  const inv = invoiceId != null
    ? await invoices.getById(invoiceId)
    : await invoices.getByOrderId(orderId);
  if (!inv) {
    throw new PricingError('not_found', invoiceId != null
      ? `invoice ${invoiceId} not found` : `order ${orderId} has no invoice`);
  }
  if (inv.status === 'paid') throw new PricingError('already_paid', `INV-${inv.id} is already paid`);

  const order = await orders.getById(inv.order_id);
  if (!order) throw new PricingError('not_found', `order ${inv.order_id} not found`);

  const targets = unpricedLines(order);
  if (targets.length === 0) {
    throw new PricingError('nothing_to_price', `INV-${inv.id} is already priced at ${cfg.currency} ${fmtMoney(inv.amount)}`);
  }

  const parsed = (Array.isArray(amounts) ? amounts : [amounts]).map(parseAmount);
  if (parsed.length === 0 || parsed.some((a) => a === null)) {
    throw new PricingError('bad_amounts', 'each amount must be a positive number', { expected: targets.length });
  }
  if (parsed.length !== targets.length) {
    throw new PricingError('count_mismatch',
      `INV-${inv.id} has ${targets.length} unpriced line(s) but ${parsed.length} amount(s) were given`,
      { expected: targets.length, got: parsed.length, lines: targets.map(({ it }) => `${it.qty} x ${it.name}`) });
  }

  const prices = {};
  const lines = targets.map(({ it, idx }, i) => {
    const qty = Math.max(1, Number(it.qty) || 1);
    const line = { name: it.name, qty, line_total: parsed[i], unit_price: round2(parsed[i] / qty) };
    prices[idx] = { unit_price: line.unit_price, line_total: line.line_total };
    return line;
  });

  const updatedOrder = await orders.applyPrices(order.id, prices);
  const total = Number(updatedOrder.total_amount);
  const due = new Date(Date.now() + cfg.cadence.termsDays * 24 * 60 * 60 * 1000);
  const updatedInvoice = await invoices.reprice(inv.id, total, due);
  if (!updatedInvoice) throw new PricingError('already_paid', `INV-${inv.id} was paid while being priced`);

  await db.recordMessage({
    direction: 'in', channel: by || 'api', phone: actor || null,
    body: `Owner priced INV-${inv.id}: ${lines.map((l) => `${l.qty} x ${l.name} = ${cfg.currency} ${fmtMoney(l.line_total)}`).join(', ')}. Total ${cfg.currency} ${fmtMoney(total)}.`,
    orderId: order.id, invoiceId: inv.id,
  });

  // The customer now gets the same "order confirmed, here is your M-Pesa
  // prompt" they would have received at intake had the item matched.
  const summary = (updatedOrder.items || []).map((i) => `${i.qty} x ${i.name}`).join(', ');
  let followUp = { announced: false, stk: null };
  try {
    const priced = await notify.announceOrder({
      phone: inv.phone, order: updatedOrder, invoice: updatedInvoice, needsPricing: false, summary,
    });
    followUp.announced = priced;
    if (priced) {
      const r = await mpesa.stkPush({ invoice: updatedInvoice, phone: inv.phone });
      if (r.CheckoutRequestID) await invoices.setCheckoutRequestId(updatedInvoice.id, r.CheckoutRequestID);
      followUp.stk = r.ResponseCode ?? null;
    }
  } catch (e) {
    // The price is saved either way; a failed send must not undo it. The
    // collections tick will reach the customer on the normal schedule.
    console.error(`[pricing] customer follow-up failed for INV-${inv.id}`, e.message);
  }

  return { order: updatedOrder, invoice: { ...updatedInvoice, name: inv.name, phone: inv.phone }, lines, total, followUp };
}

module.exports = { priceInvoice, parseAmount, unpricedLines, PricingError, HTTP_STATUS };
