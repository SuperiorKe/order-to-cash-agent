// Owner: Payments (C). Safaricom posts the STK result here.
// Acknowledge immediately, then reconcile in the background.

const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const cfg = require('../config');
const invoices = require('../invoices');
const at = require('../africastalking');
const db = require('../db');
const mpesa = require('../mpesa');

// Constant-time compare so a wrong guess at ?secret= can't be timed.
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

router.post('/callback', async (req, res) => {
  // This is the money path, so when WEBHOOK_SECRET is set, require the value
  // mpesa.js asked Daraja to echo back on the callback URL before recording
  // or reconciling anything. Empty webhookSecret is a no-op, so dry-run
  // keeps working exactly as before.
  if (cfg.webhookSecret && !safeEqual(req.query.secret || '', cfg.webhookSecret)) {
    return res.status(401).json({ error: 'invalid webhook secret' });
  }

  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });

  try {
    const cb = req.body?.Body?.stkCallback;
    if (!cb) return;
    await db.recordMessage({ direction: 'in', channel: 'mpesa', body: `callback ResultCode=${cb.ResultCode}`, providerId: cb.CheckoutRequestID });

    // Safaricom echoes our AccountReference (INV-<id>) back in the callback
    // metadata on both success and failure. Prefer reconciling against that:
    // an invoice can receive more than one STK push (auto push at order
    // creation, a customer REPLY-PAY, an owner retry through Friday), and
    // setCheckoutRequestId overwrites checkout_request_id on every push, so
    // a callback for an earlier push would otherwise match no row. Fall back
    // to checkout_request_id when AccountReference is absent.
    const meta = Object.fromEntries((cb.CallbackMetadata?.Item || []).map((i) => [i.Name, i.Value]));
    const invoiceId = mpesa.parseInvoiceIdFromAccountRef(meta.AccountReference);

    if (cb.ResultCode !== 0) {
      // Cancelled or failed. Record why instead of dropping it silently, so
      // Friday can tell Boss what actually happened on the customer's phone.
      const reason = mpesa.describeResultCode(cb.ResultCode);
      const invoice = invoiceId
        ? await invoices.markStkFailedByInvoiceId(invoiceId, reason)
        : await invoices.markStkFailed(cb.CheckoutRequestID, reason);
      if (invoice) {
        await db.recordMessage({
          direction: 'in', channel: 'mpesa', phone: invoice.phone,
          body: `STK push not completed for INV-${invoice.id}: ${reason} (ResultCode ${cb.ResultCode}, "${cb.ResultDesc}")`,
          providerId: cb.CheckoutRequestID, invoiceId: invoice.id,
        });
      }
      return;
    }

    const invoice = invoiceId
      ? await invoices.markPaidByInvoiceId(invoiceId, meta.MpesaReceiptNumber)
      : await invoices.markPaid(cb.CheckoutRequestID, meta.MpesaReceiptNumber);
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
