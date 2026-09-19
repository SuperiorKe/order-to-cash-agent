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
const at = require('../africastalking');
const pricing = require('../pricing');
const { fmtMoney: fmt } = require('../money');

// PRICE <invoice> <amount> [amount ...] — the owner's reply to the
// "INV-n needs pricing" alert. Accepts "PRICE 12 45000", "price INV-12 45,000",
// "PRICE 12 15000 30000" (one line total per unpriced line, in order).
// Amounts are separated by spaces; a comma inside a number is a thousands
// separator.
const PRICE_CMD = /^price\s+(?:inv-?)?#?(\d+)\s+(.+)$/i;

function isOwner(phone) {
  return Boolean(cfg.cadence.ownerPhone)
    && mpesa.normalizeMsisdn(phone) === mpesa.normalizeMsisdn(cfg.cadence.ownerPhone);
}

async function handleOwnerPrice(from, match) {
  const invoiceId = Number(match[1]);
  const amounts = match[2].trim().split(/\s+/);
  let reply;
  try {
    const r = await pricing.priceInvoice({ invoiceId, amounts, by: 'sms', actor: from });
    const lines = r.lines.map((l) => `${l.qty} x ${l.name} = ${cfg.currency} ${fmt(l.line_total)}`).join(', ');
    const due = new Date(r.invoice.due_date).toDateString();
    reply = `INV-${r.invoice.id} priced: ${lines}. Total ${cfg.currency} ${fmt(r.total)}, due ${due}. `
      + (r.followUp.announced ? 'Customer sent the invoice and an M-Pesa prompt.' : 'Customer notification failed; the reminder cycle will reach them.');
  } catch (e) {
    if (!(e instanceof pricing.PricingError)) throw e;
    reply = e.message + '.';
    if (e.code === 'count_mismatch') {
      reply += ` Reply PRICE ${invoiceId} ${e.lines.map(() => '<amount>').join(' ')} — one amount per line: ${e.lines.join(', ')}.`;
    } else if (e.code === 'bad_amounts') {
      reply = `Could not read the amount. Reply PRICE ${invoiceId} <amount>, e.g. PRICE ${invoiceId} 45000.`;
    }
  }
  await at.sendSMS({ to: from, invoiceId, message: reply });
}

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

    // Owner pricing an order that arrived with an unmatched item. Checked
    // before order parsing so "PRICE 12 45000" is never mistaken for an
    // order for twelve of something.
    const priceMatch = PRICE_CMD.exec(text);
    if (priceMatch || /^price\b/i.test(text)) {
      if (!isOwner(from)) {
        await at.sendSMS({
          to: from,
          message: `PRICE is a keyword for the business owner. To order, text what you need, e.g. "2 standard steel doors". — ${cfg.businessName}`,
        });
        return;
      }
      if (!priceMatch) {
        await at.sendSMS({ to: from, message: 'Reply PRICE <invoice number> <amount>, e.g. PRICE 12 45000. For several unpriced lines, one amount per line in order.' });
        return;
      }
      await handleOwnerPrice(from, priceMatch);
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
