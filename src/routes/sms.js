// Owner: Intake (A). Inbound SMS: free-text orders and the PAY keyword.
// Africa's Talking posts: from, to, text, id, linkId, date

const express = require('express');
const router = express.Router();
const cfg = require('../config');
const claude = require('../claude');
const orders = require('../orders');
const invoices = require('../invoices');
const mpesa = require('../mpesa');
const notify = require('../notify');
const db = require('../db');

router.post('/inbound', async (req, res) => {
  const from = req.body.from;
  const text = (req.body.text || '').trim();

  // Africa's Talking does not cryptographically sign its callbacks, so this
  // only checks the request was addressed to our shortcode — a plausibility
  // check, not authentication. Production hardening needs IP allowlisting at
  // the network edge on top of this.
  if (cfg.at.smsShortcode && req.body.to !== cfg.at.smsShortcode) {
    return res.status(200).json({ status: 'ignored' });
  }

  res.status(200).json({ status: 'ok' }); // acknowledge AT immediately

  try {
    await db.recordMessage({ direction: 'in', channel: 'sms', phone: from, body: text, providerId: req.body.id });

    // "PAY" -> re-send the M-Pesa prompt for the latest unpaid invoice.
    if (/^pay$/i.test(text)) {
      const inv = await invoices.latestUnpaidByPhone(from);
      if (inv) {
        const r = await mpesa.stkPush({ invoice: inv, phone: from });
        if (r.CheckoutRequestID) await invoices.setCheckoutRequestId(inv.id, r.CheckoutRequestID);
      }
      return;
    }

    const parsed = await claude.parseOrder(text);
    const { order, invoice, needsPricing } = await orders.createOrder({
      phone: from, items: parsed.items, source: 'sms', rawText: text,
    });
    const summary = parsed.items.map((i) => `${i.qty} x ${i.name}`).join(', ');
    const priced = await notify.announceOrder({ phone: from, order, invoice, needsPricing, summary });
    if (priced) {
      const r = await mpesa.stkPush({ invoice, phone: from });
      if (r.CheckoutRequestID) await invoices.setCheckoutRequestId(invoice.id, r.CheckoutRequestID);
    }
  } catch (e) {
    console.error('[sms] inbound error', e.message);
  }
});

module.exports = router;
