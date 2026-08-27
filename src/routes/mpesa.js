// Owner: Payments (C). Safaricom posts the STK result here.
// Acknowledge immediately, then reconcile in the background.

const express = require('express');
const router = express.Router();
const cfg = require('../config');
const invoices = require('../invoices');
const at = require('../africastalking');
const db = require('../db');

router.post('/callback', async (req, res) => {
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });

  try {
    const cb = req.body?.Body?.stkCallback;
    if (!cb) return;
    await db.recordMessage({ direction: 'in', channel: 'mpesa', body: `callback ResultCode=${cb.ResultCode}`, providerId: cb.CheckoutRequestID });

    if (cb.ResultCode !== 0) return; // cancelled or failed

    const meta = Object.fromEntries((cb.CallbackMetadata?.Item || []).map((i) => [i.Name, i.Value]));
    const invoice = await invoices.markPaid(cb.CheckoutRequestID, meta.MpesaReceiptNumber);
    if (invoice && meta.PhoneNumber) {
      await at.sendSMS({
        to: `+${meta.PhoneNumber}`, invoiceId: invoice.id,
        message: `Payment received for INV-${invoice.id}. Receipt ${meta.MpesaReceiptNumber}. Thank you. — ${cfg.businessName}`,
      });
    }
  } catch (e) {
    console.error('[mpesa] callback error', e.message);
  }
});

module.exports = router;
