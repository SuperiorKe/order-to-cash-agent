// Owner: Payments (C). M-Pesa Daraja STK push + token handling.
// Uses native fetch (Node 20+). Dry-runs when no passkey is configured.

const cfg = require('./config');
const db = require('./db');

let token = { value: null, expiresAt: 0 };

const b64 = (s) => Buffer.from(s).toString('base64');

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// 07XXXXXXXX / +2547XXXXXXXX / 2547XXXXXXXX -> 2547XXXXXXXX
function normalizeMsisdn(phone) {
  let p = String(phone).replace(/\D/g, '');
  if (p.startsWith('0')) p = '254' + p.slice(1);
  if (p.startsWith('7') || p.startsWith('1')) p = '254' + p;
  return p;
}

async function getToken() {
  if (token.value && Date.now() < token.expiresAt) return token.value;
  if (!cfg.mpesa.consumerKey || !cfg.mpesa.consumerSecret) {
    throw new Error('MPESA consumer key/secret not configured');
  }
  const auth = b64(`${cfg.mpesa.consumerKey}:${cfg.mpesa.consumerSecret}`);
  const res = await fetch(`${cfg.mpesa.base}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${auth}` },
  });
  if (!res.ok) throw new Error(`oauth failed: ${res.status}`);
  const data = await res.json();
  token = { value: data.access_token, expiresAt: Date.now() + (Number(data.expires_in) - 60) * 1000 };
  return token.value;
}

async function stkPush({ invoice, phone }) {
  const msisdn = normalizeMsisdn(phone);

  if (!cfg.mpesa.passkey || !cfg.mpesa.consumerKey) {
    console.log(`[mpesa:DRY] STK push skipped (no credentials) for INV-${invoice.id}`);
    await db.recordMessage({ direction: 'out', channel: 'mpesa', phone: msisdn, body: `STK push (dry-run) ${cfg.currency} ${invoice.amount}`, providerId: `DRY-${invoice.id}`, invoiceId: invoice.id });
    return { CheckoutRequestID: `DRY-${invoice.id}`, ResponseCode: 'dry-run' };
  }

  const t = timestamp();
  const password = b64(`${cfg.mpesa.shortcode}${cfg.mpesa.passkey}${t}`);
  // When WEBHOOK_SECRET is set, ask Daraja to echo it straight back on the
  // callback query string, so routes/mpesa.js can verify it before trusting
  // anything in the body.
  const callbackUrl = cfg.webhookSecret
    ? `${cfg.publicBaseUrl}/webhooks/mpesa/callback?secret=${encodeURIComponent(cfg.webhookSecret)}`
    : `${cfg.publicBaseUrl}/webhooks/mpesa/callback`;
  const body = {
    BusinessShortCode: Number(cfg.mpesa.shortcode),
    Password: password,
    Timestamp: t,
    TransactionType: 'CustomerPayBillOnline',
    Amount: Math.max(1, Math.round(Number(invoice.amount))),
    PartyA: Number(msisdn),
    PartyB: Number(cfg.mpesa.shortcode),
    PhoneNumber: Number(msisdn),
    CallBackURL: callbackUrl,
    AccountReference: `INV-${invoice.id}`,
    TransactionDesc: `Invoice INV-${invoice.id}`,
  };

  const accessToken = await getToken();
  const res = await fetch(`${cfg.mpesa.base}/mpesa/stkpush/v1/processrequest`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  await db.recordMessage({
    direction: 'out', channel: 'mpesa', phone: msisdn,
    body: `STK push ${cfg.currency} ${body.Amount} (${data.ResponseCode ?? data.errorCode ?? res.status})`,
    providerId: data.CheckoutRequestID || 'error', invoiceId: invoice.id,
  });
  return data;
}

// Safaricom's documented STK ResultCodes for the common non-success cases.
// Anything not listed here (rare/undocumented codes) falls back to 'failed';
// the raw ResultCode and ResultDesc are still recorded in the messages log
// by the callback handler, so nothing is actually lost.
const STK_RESULT_REASONS = {
  1: 'insufficient_balance',
  1032: 'cancelled',
  1037: 'timeout',
  2001: 'wrong_pin',
};
function describeResultCode(code) {
  return STK_RESULT_REASONS[code] || 'failed';
}

// Recovers the invoice id from the AccountReference we sent above
// ("INV-<id>"), which Safaricom echoes back in the callback's
// CallbackMetadata on both success and failure. Lets routes/mpesa.js
// reconcile against the invoice itself instead of checkout_request_id, which
// setCheckoutRequestId overwrites on every repeat push.
function parseInvoiceIdFromAccountRef(accountRef) {
  const m = /^INV-(\d+)$/.exec(String(accountRef || '').trim());
  return m ? Number(m[1]) : null;
}

module.exports = { getToken, stkPush, normalizeMsisdn, describeResultCode, parseInvoiceIdFromAccountRef };
