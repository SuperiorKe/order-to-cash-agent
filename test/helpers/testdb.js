// Boots a throwaway embedded Postgres, applies db/migration.sql, and points
// DATABASE_URL at it — all before src/ is required, because config.js reads
// the environment and db.js opens its pool at require time.
//
// Also chdir()s into a temp directory so a developer's local .env (which
// config.js loads with override: true) can never leak credentials into a
// test run and turn dry-run sends into real ones.

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const EmbeddedPostgres = require('embedded-postgres').default || require('embedded-postgres');

const ROOT = path.resolve(__dirname, '..', '..');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function startTestDb(extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'o2c-test-'));
  const port = await freePort();
  const pg = new EmbeddedPostgres({
    databaseDir: path.join(dir, 'pgdata'),
    user: 'postgres', password: 'postgres', port, persistent: false,
    onLog: () => {}, onError: () => {},
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('o2c_test');

  const url = `postgres://postgres:postgres@localhost:${port}/o2c_test`;
  const client = pg.getPgClient('o2c_test');
  await client.connect();
  await client.query(fs.readFileSync(path.join(ROOT, 'db', 'migration.sql'), 'utf8'));
  await client.end();

  process.chdir(dir);
  // Dry-run everywhere: no AT / M-Pesa / LLM keys, so nothing real is sent.
  for (const k of ['AT_API_KEY', 'MPESA_PASSKEY', 'MPESA_CONSUMER_KEY', 'MPESA_CONSUMER_SECRET', 'OPENROUTER_API_KEY', 'VOICE_AGENT_API_KEY', 'WEBHOOK_SECRET', 'AT_SMS_SHORTCODE', 'AT_USSD_SERVICE_CODE']) {
    delete process.env[k];
  }
  Object.assign(process.env, {
    DATABASE_URL: url,
    OWNER_PHONE: '+254711000111',
    DEFAULT_PAYMENT_TERMS_DAYS: '7',
    BUSINESS_NAME: 'Test Fabricators',
    CURRENCY: 'KES',
  }, extraEnv);

  return {
    url,
    async stop() {
      try { await pg.stop(); } catch { /* already down */ }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

module.exports = { startTestDb, ROOT };
