// Owner: Voice assistant. JSON surface for Friday, the owner-facing LiveKit
// agent in voice-agent/. Same data the dashboard (routes/dashboard.js) shows,
// shaped for a tool call instead of an HTML table, so there is one path into
// Postgres and the dashboard and the voice assistant never disagree.
//
// Unlike the webhooks, nothing here is called by Africa's Talking or
// Safaricom, so normal REST status codes (404, 409, 503) are fine.
//
// Two routes here reach a real customer (POST /remind sends a real SMS,
// POST /stkpush puts a real M-Pesa prompt on their phone), and this server
// is usually reachable on a public tunnel URL during the hackathon. If
// VOICE_AGENT_API_KEY is set, every /api route requires it; if it is unset,
// the API stays open, same dry-run-friendly default as the rest of this
// project.

const express = require('express');
const router = express.Router();
const cfg = require('../config');
const db = require('../db');
const invoices = require('../invoices');
const orders = require('../orders');
const at = require('../africastalking');
const mpesa = require('../mpesa');

router.use('/api', (req, res, next) => {
  const required = process.env.VOICE_AGENT_API_KEY;
  if (!required || req.get('x-api-key') === required) return next();
  res.status(401).json({ error: 'missing or invalid x-api-key' });
});

router.get('/api/invoices/overdue', async (req, res) => {
  if (!(await db.healthy())) return res.status(503).json({ error: 'database not connected' });
  try {
    const rows = await invoices.overdueList();
    res.json({ currency: cfg.currency, invoices: rows });
  } catch (e) {
    console.error('[api] overdue list failed', e.message);
    res.status(500).json({ error: 'could not load overdue invoices' });
  }
});

// Broader than /overdue: every invoice not yet paid, due or not.
router.get('/api/invoices/unpaid', async (req, res) => {
  if (!(await db.healthy())) return res.status(503).json({ error: 'database not connected' });
  try {
    const rows = await invoices.unpaidList();
    res.json({ currency: cfg.currency, invoices: rows });
  } catch (e) {
    console.error('[api] unpaid list failed', e.message);
    res.status(500).json({ error: 'could not load unpaid invoices' });
  }
});

router.get('/api/invoices/:id', async (req, res) => {
  if (!(await db.healthy())) return res.status(503).json({ error: 'database not connected' });
  try {
    const inv = await invoices.getById(req.params.id);
    if (!inv) return res.status(404).json({ error: `invoice ${req.params.id} not found` });
    res.json({ currency: cfg.currency, invoice: inv });
  } catch (e) {
    console.error('[api] get invoice failed', e.message);
    res.status(500).json({ error: 'could not load invoice' });
  }
});

// Sends now, outside the tick's own gap timing. reminders_sent still goes up
// by one, so the next cron tick sees an up-to-date count and does not
// duplicate this send.
router.post('/api/invoices/:id/remind', async (req, res) => {
  if (!(await db.healthy())) return res.status(503).json({ error: 'database not connected' });
  try {
    const inv = await invoices.getById(req.params.id);
    if (!inv) return res.status(404).json({ error: `invoice ${req.params.id} not found` });
    if (inv.status === 'paid') return res.status(409).json({ error: 'invoice already paid' });

    await at.sendSMS({
      to: inv.phone,
      invoiceId: inv.id,
      message: `Hello${inv.name ? ' ' + inv.name : ''}. Reminder: INV-${inv.id} of ${cfg.currency} ${inv.amount} is due. Reply PAY for an M-Pesa prompt. — ${cfg.businessName}`,
    });
    await invoices.markReminded(inv.id, inv.reminders_sent + 1, inv.status === 'issued' ? 'reminded' : inv.status);

    res.json({ ok: true, invoiceId: inv.id, sentTo: inv.phone });
  } catch (e) {
    console.error('[api] manual remind failed', e.message);
    res.status(500).json({ error: 'reminder failed to send' });
  }
});

// Puts a real M-Pesa payment prompt on the customer's phone for this
// invoice's exact amount. Same mpesa.stkPush() the "Reply PAY" SMS flow
// uses, just triggered by the owner instead of the customer.
router.post('/api/invoices/:id/stkpush', async (req, res) => {
  if (!(await db.healthy())) return res.status(503).json({ error: 'database not connected' });
  try {
    const inv = await invoices.getById(req.params.id);
    if (!inv) return res.status(404).json({ error: `invoice ${req.params.id} not found` });
    if (inv.status === 'paid') return res.status(409).json({ error: 'invoice already paid' });
    if (Number(inv.amount) <= 0) return res.status(409).json({ error: 'invoice has no priced amount yet' });

    const r = await mpesa.stkPush({ invoice: inv, phone: inv.phone });
    if (r.CheckoutRequestID) await invoices.setCheckoutRequestId(inv.id, r.CheckoutRequestID);

    res.json({
      ok: r.ResponseCode === '0' || r.ResponseCode === 'dry-run',
      invoiceId: inv.id, sentTo: inv.phone, responseCode: r.ResponseCode,
    });
  } catch (e) {
    console.error('[api] manual stk push failed', e.message);
    res.status(500).json({ error: 'STK push failed to send' });
  }
});

// Orders nobody has priced yet — the closest thing this schema has to
// "unattended." See orders.needsPricingList() for what that means exactly.
router.get('/api/orders/unattended', async (req, res) => {
  if (!(await db.healthy())) return res.status(503).json({ error: 'database not connected' });
  try {
    const rows = await orders.needsPricingList();
    res.json({ currency: cfg.currency, orders: rows });
  } catch (e) {
    console.error('[api] unattended orders failed', e.message);
    res.status(500).json({ error: 'could not load unattended orders' });
  }
});

// ?status=fulfilled|unfulfilled filters; anything else (or omitted) lists all.
router.get('/api/orders', async (req, res) => {
  if (!(await db.healthy())) return res.status(503).json({ error: 'database not connected' });
  try {
    const rows = await orders.listAll({ status: req.query.status });
    res.json({ currency: cfg.currency, orders: rows });
  } catch (e) {
    console.error('[api] list orders failed', e.message);
    res.status(500).json({ error: 'could not load orders' });
  }
});

// Counts for "what kinds of orders do I have": fulfilled vs unfulfilled, and
// how many unfulfilled ones are also stuck waiting on pricing.
router.get('/api/orders/summary', async (req, res) => {
  if (!(await db.healthy())) return res.status(503).json({ error: 'database not connected' });
  try {
    const s = await orders.summary();
    res.json({ orders: s });
  } catch (e) {
    console.error('[api] order summary failed', e.message);
    res.status(500).json({ error: 'could not load order summary' });
  }
});

// Marks the physical order done. Independent of payment — an order can be
// fulfilled and still unpaid, or paid and not yet fulfilled.
router.post('/api/orders/:id/fulfill', async (req, res) => {
  if (!(await db.healthy())) return res.status(503).json({ error: 'database not connected' });
  try {
    const order = await orders.getById(req.params.id);
    if (!order) return res.status(404).json({ error: `order ${req.params.id} not found` });
    if (order.status === 'fulfilled') return res.status(409).json({ error: 'order already fulfilled' });

    const updated = await orders.markFulfilled(order.id);
    res.json({ ok: true, orderId: updated.id, status: updated.status });
  } catch (e) {
    console.error('[api] mark order fulfilled failed', e.message);
    res.status(500).json({ error: 'could not mark order fulfilled' });
  }
});

// Order-scoped version of /api/invoices/:id/stkpush, for when Boss names an
// order instead of an invoice number. Same guards, plus: refuse a fulfilled
// order outright.
router.post('/api/orders/:id/stkpush', async (req, res) => {
  if (!(await db.healthy())) return res.status(503).json({ error: 'database not connected' });
  try {
    const order = await orders.getById(req.params.id);
    if (!order) return res.status(404).json({ error: `order ${req.params.id} not found` });
    if (order.status === 'fulfilled') return res.status(409).json({ error: 'order already fulfilled' });

    const inv = await invoices.getByOrderId(order.id);
    if (!inv) return res.status(404).json({ error: `order ${req.params.id} has no invoice` });
    if (inv.status === 'paid') return res.status(409).json({ error: 'invoice already paid' });
    if (Number(inv.amount) <= 0) return res.status(409).json({ error: 'invoice has no priced amount yet' });

    const r = await mpesa.stkPush({ invoice: inv, phone: inv.phone });
    if (r.CheckoutRequestID) await invoices.setCheckoutRequestId(inv.id, r.CheckoutRequestID);

    res.json({
      ok: r.ResponseCode === '0' || r.ResponseCode === 'dry-run',
      orderId: order.id, invoiceId: inv.id, sentTo: inv.phone, responseCode: r.ResponseCode,
    });
  } catch (e) {
    console.error('[api] manual order stk push failed', e.message);
    res.status(500).json({ error: 'STK push failed to send' });
  }
});

router.get('/api/orders/:id', async (req, res) => {
  if (!(await db.healthy())) return res.status(503).json({ error: 'database not connected' });
  try {
    const order = await orders.getById(req.params.id);
    if (!order) return res.status(404).json({ error: `order ${req.params.id} not found` });
    res.json({ currency: cfg.currency, order });
  } catch (e) {
    console.error('[api] get order failed', e.message);
    res.status(500).json({ error: 'could not load order' });
  }
});

router.get('/api/summary', async (req, res) => {
  if (!(await db.healthy())) return res.status(503).json({ error: 'database not connected' });
  try {
    const { rows } = await db.query(
      `select
         count(*) filter (where status <> 'paid')                                                       as open_invoices,
         count(*) filter (where status in ('issued','reminded','voice_escalated') and due_date < now())  as overdue_invoices,
         coalesce(sum(amount) filter (where status <> 'paid'), 0)                                        as outstanding_amount,
         coalesce(sum(amount) filter (where status = 'paid' and paid_at > now() - interval '7 days'), 0) as paid_last_7_days
       from invoices`,
    );
    res.json({ currency: cfg.currency, ...rows[0] });
  } catch (e) {
    console.error('[api] summary failed', e.message);
    res.status(500).json({ error: 'could not load summary' });
  }
});

module.exports = router;
