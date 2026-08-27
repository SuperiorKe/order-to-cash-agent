// Owner: Collections (B). Also used by Intake (A) for confirmation SMS.
// The SDK is required lazily so the server boots and runs in dry-run mode
// with no credentials. Missing keys log the message instead of crashing.

const cfg = require('./config');
const db = require('./db');

// The Africa's Talking sandbox intermittently answers a valid key with a 401.
// Measured on 27 Aug 2026: five identical sends two seconds apart, three of them
// came back 401 and two succeeded. Retrying clears it. Without this, reminders
// silently fail to arrive, which is the one thing the demo cannot afford.
const SEND_ATTEMPTS = Number(process.env.AT_SEND_ATTEMPTS || 5);
const SEND_GAP_MS = Number(process.env.AT_SEND_GAP_MS || 3000);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function withRetry(label, fn) {
  let last;
  for (let attempt = 1; attempt <= SEND_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      console.error(`[at] ${label} attempt ${attempt}/${SEND_ATTEMPTS} failed: ${e.message}`);
      if (attempt < SEND_ATTEMPTS) await wait(SEND_GAP_MS);
    }
  }
  throw last;
}

let client = null;
function at() {
  if (client) return client;
  if (!cfg.at.apiKey || !cfg.at.username) return null;
  client = require('africastalking')({ apiKey: cfg.at.apiKey, username: cfg.at.username });
  return client;
}

async function sendSMS({ to, message, orderId, invoiceId }) {
  const c = at();
  let providerId = 'dry-run';
  if (c) {
    try {
      console.log(`[at] attempting SMS to ${to} via shortcode ${cfg.at.smsShortcode}, username: ${cfg.at.username}`);
      const res = await withRetry(`sms to ${to}`, () => c.SMS.send({
        to: [to],
        from: cfg.at.smsShortcode || undefined,
        message,
      }));
      console.log(`[at] sms response:`, JSON.stringify(res, null, 2));
      providerId = res?.SMSMessageData?.Recipients?.[0]?.messageId || 'sent';
    } catch (e) {
      console.error('[at] sms send failed after retries', e.message, e);
      providerId = 'error';
    }
  } else {
    console.log(`[at:DRY] SMS -> ${to}: ${message}`);
  }
  await db.recordMessage({ direction: 'out', channel: 'sms', phone: to, body: message, providerId, orderId, invoiceId });
  return providerId;
}

async function placeCall({ to, invoiceId }) {
  const c = at();
  let providerId = 'dry-run';
  if (c && cfg.at.voiceNumber) {
    try {
      const res = await withRetry(`voice call to ${to}`, () => c.VOICE.call({
        callFrom: cfg.at.voiceNumber,
        callTo: [to],
      }));
      providerId = res?.entries?.[0]?.sessionId || 'called';
    } catch (e) {
      console.error('[at] voice call failed after retries', e.message);
      providerId = 'error';
    }
  } else {
    console.log(`[at:DRY] VOICE call -> ${to}`);
  }
  await db.recordMessage({ direction: 'out', channel: 'voice', phone: to, body: 'Automated payment reminder call', providerId, invoiceId });
  return providerId;
}

module.exports = { sendSMS, placeCall };
