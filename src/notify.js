// Owner: Intake (A). What the customer and the owner hear the moment an order
// lands. Kept out of the routes so USSD and SMS say the same thing.

const cfg = require('./config');
const at = require('./africastalking');

// Returns true when the order is priced and it is fair to ask for payment.
async function announceOrder({ phone, order, invoice, needsPricing, summary }) {
  if (needsPricing) {
    await at.sendSMS({
      to: phone, orderId: order.id, invoiceId: invoice.id,
      message: `We have your order INV-${invoice.id}. We are confirming the price and will send your invoice shortly. \u2014 ${cfg.businessName}`,
    });
    if (cfg.cadence.ownerPhone) {
      await at.sendSMS({
        to: cfg.cadence.ownerPhone, orderId: order.id, invoiceId: invoice.id,
        message: `INV-${invoice.id} from ${phone} needs pricing: ${order.raw_text || summary || 'see dashboard'}`,
      });
    }
    return false;
  }

  const due = new Date(invoice.due_date).toDateString();
  await at.sendSMS({
    to: phone, orderId: order.id, invoiceId: invoice.id,
    message: `Order INV-${invoice.id} confirmed${summary ? ': ' + summary : ''}. Total ${cfg.currency} ${invoice.amount}, due ${due}. Reply PAY for an M-Pesa prompt. \u2014 ${cfg.businessName}`,
  });
  return true;
}

module.exports = { announceOrder };
