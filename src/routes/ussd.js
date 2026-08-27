// Owner: Intake (A). USSD order-taking. Primary intake for the live demo.
// Africa's Talking posts: sessionId, serviceCode, phoneNumber, text
// text is the accumulated inputs joined by '*'. Reply text/plain with CON | END.

const express = require('express');
const router = express.Router();
const cfg = require('../config');
const orders = require('../orders');
const mpesa = require('../mpesa');
const invoices = require('../invoices');
const notify = require('../notify');
const db = require('../db');

router.post('/', async (req, res) => {
  const { text = '', phoneNumber, sessionId, serviceCode } = req.body;
  console.log(`[ussd] incoming request - phone: ${phoneNumber}, sessionId: ${sessionId}, serviceCode: ${serviceCode}, text: "${text}"`);
  const steps = text.split('*').filter((s) => s !== '');
  res.set('Content-Type', 'text/plain');

  try {
    if (steps.length === 0) {
      return res.send(`CON Welcome to ${cfg.businessName}.\n1. Place order\n2. Check my orders`);
    }

    if (steps[0] === '2') {
      if (!(await db.healthy())) return res.send('END Orders unavailable right now.');
      const { rows } = await db.query(
        `select i.id, i.amount, i.status from invoices i
           join orders o    on o.id = i.order_id
           join customers c on c.id = o.customer_id
          where c.phone = $1 order by i.created_at desc limit 5`,
        [phoneNumber],
      );
      if (!rows.length) return res.send('END You have no orders yet.');
      const list = rows.map((r) => `INV-${r.id} ${cfg.currency}${r.amount} ${r.status}`).join('\n');
      return res.send(`END Your recent orders:\n${list}`);
    }

    if (steps[0] === '1') {
      if (steps.length === 1) return res.send('CON Enter product name or code:');
      if (steps.length === 2) return res.send('CON Enter quantity:');
      if (steps.length === 3) {
        const qty = parseInt(steps[2], 10) || 1;
        const { order, invoice, needsPricing } = await orders.createOrder({
          phone: phoneNumber,
          items: [{ name: steps[1], qty }],
          source: 'ussd',
          rawText: `USSD ${steps[1]} x${qty}`,
        });

        // Confirm by SMS, then ask for payment only if we actually priced it.
        // Neither blocks the USSD reply, which must return inside the session timeout.
        notify.announceOrder({
          phone: phoneNumber, order, invoice, needsPricing, summary: `${qty} x ${steps[1]}`,
        }).then((priced) => {
          if (!priced) return;
          return mpesa.stkPush({ invoice, phone: phoneNumber })
            .then((r) => { if (r.CheckoutRequestID) return invoices.setCheckoutRequestId(invoice.id, r.CheckoutRequestID); });
        }).catch((e) => console.error('[ussd] follow-up error', e.message));

        if (needsPricing) {
          return res.send(`END Order INV-${invoice.id} received. We are confirming the price and will SMS your invoice shortly.`);
        }
        return res.send(`END Order INV-${invoice.id} received, ${cfg.currency} ${invoice.amount}. Check your phone for an M-Pesa prompt.`);
      }
    }

    return res.send('END Invalid choice.');
  } catch (e) {
    console.error('[ussd] error', e.message);
    return res.send('END Sorry, something went wrong. Please try again.');
  }
});

module.exports = router;
