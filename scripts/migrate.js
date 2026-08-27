const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { poolConfig } = require('../src/pgconfig');
require('dotenv').config({ override: true });

(async () => {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL not set. Add it to .env first.');
    process.exit(1);
  }
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'migration.sql'), 'utf8');
  const pool = new Pool(poolConfig(process.env.DATABASE_URL));
  try {
    await pool.query(sql);
    console.log('migration applied');
  } catch (e) {
    console.error('migration failed:', e.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
})();
