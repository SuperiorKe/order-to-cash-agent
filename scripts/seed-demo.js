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
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'seed-demo.sql'), 'utf8');
  const pool = new Pool(poolConfig(process.env.DATABASE_URL));
  try {
    await pool.query(sql);
    console.log('demo invoice seeded (due 1 minute ago). Next agent tick will start the loop.');
  } catch (e) {
    console.error('seed failed:', e.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
})();
