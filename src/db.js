const { Pool } = require('pg');
const cfg = require('./config');
const { poolConfig } = require('./pgconfig');

let pool = null;
if (cfg.databaseUrl) {
  pool = new Pool(poolConfig(cfg.databaseUrl));
  pool.on('error', (e) => console.error('[db] pool error', e.message));
} else {
  console.warn('[db] DATABASE_URL not set — DB features disabled until you set it and run `npm run migrate`');
}

async function query(text, params) {
  if (!pool) throw new Error('DATABASE_URL not configured');
  return pool.query(text, params);
}

async function healthy() {
  if (!pool) return false;
  try {
    await pool.query('select 1');
    return true;
  } catch {
    return false;
  }
}

// Shared audit helper. Every outbound and inbound event lands here so the
// dashboard can show the whole trail live during the demo. Never throws.
async function recordMessage({ direction, channel, phone, body, providerId, orderId, invoiceId }) {
  try {
    await query(
      `insert into messages (direction, channel, phone, body, provider_id, order_id, invoice_id)
       values ($1,$2,$3,$4,$5,$6,$7)`,
      [direction, channel, phone || null, body || null, providerId || null, orderId || null, invoiceId || null],
    );
  } catch (e) {
    console.error('[db] recordMessage failed', e.message);
  }
}

module.exports = { pool, query, healthy, recordMessage };
