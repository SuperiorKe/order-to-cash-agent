// Local Postgres without Docker or root: starts an embedded Postgres server
// in ./.pgdata (gitignored), applies db/migration.sql, and prints the
// DATABASE_URL to put in .env. Ctrl-C stops it; data persists between runs.
//
//   npm run db:local              -> listens on 5432
//   DEV_DB_PORT=5433 npm run db:local

const fs = require('fs');
const path = require('path');
const EmbeddedPostgres = require('embedded-postgres').default || require('embedded-postgres');

const port = Number(process.env.DEV_DB_PORT || 5432);
const dir = path.join(__dirname, '..', '.pgdata');
const dbName = 'order_to_cash';

(async () => {
  const pg = new EmbeddedPostgres({
    databaseDir: dir, user: 'postgres', password: 'postgres', port, persistent: true,
    onLog: () => {}, onError: (e) => { if (/FATAL|ERROR/.test(String(e))) console.error(String(e).trim()); },
  });
  if (!fs.existsSync(path.join(dir, 'PG_VERSION'))) await pg.initialise();
  await pg.start();
  try { await pg.createDatabase(dbName); } catch { /* exists */ }

  const client = pg.getPgClient(dbName);
  await client.connect();
  await client.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'migration.sql'), 'utf8'));
  await client.end();

  console.log(`[dev-db] Postgres running on :${port}, migration applied.`);
  console.log(`[dev-db] DATABASE_URL=postgres://postgres:postgres@localhost:${port}/${dbName}`);
  console.log('[dev-db] Ctrl-C to stop.');

  const shutdown = async () => { await pg.stop().catch(() => {}); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
})().catch((e) => { console.error('[dev-db] failed:', e.message); process.exit(1); });
