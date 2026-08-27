// Owner: Surface (D). Minimal owner dashboard: invoices + live message trail.
// This is what you put on the projector during the demo.

const express = require('express');
const router = express.Router();
const cfg = require('../config');
const db = require('../db');

const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

router.get('/', async (req, res) => {
  if (!(await db.healthy())) {
    return res.send(`<h1>${esc(cfg.businessName)} — Order-to-Cash Agent</h1>
      <p>Database not connected. Set DATABASE_URL and run <code>npm run migrate</code>.</p>`);
  }

  const invoices = (await db.query(
    `select i.id, i.amount, i.status, i.due_date, i.reminders_sent, c.name, c.phone
       from invoices i
       join orders o    on o.id = i.order_id
       join customers c on c.id = o.customer_id
      order by i.created_at desc limit 25`,
  )).rows;

  const msgs = (await db.query(
    'select direction, channel, phone, body, created_at from messages order by created_at desc limit 20',
  )).rows;

  const invRows = invoices.map((i) => `<tr>
      <td>INV-${i.id}</td>
      <td>${esc(i.name || i.phone)}</td>
      <td class="num">${cfg.currency} ${esc(i.amount)}</td>
      <td><span class="pill ${esc(i.status)}">${esc(i.status)}</span></td>
      <td>${esc(new Date(i.due_date).toLocaleString())}</td>
      <td class="num">${i.reminders_sent}</td>
    </tr>`).join('');

  const msgRows = msgs.map((m) => `<tr>
      <td>${esc(m.direction)}</td>
      <td>${esc(m.channel)}</td>
      <td>${esc(m.phone)}</td>
      <td>${esc(m.body)}</td>
      <td>${esc(new Date(m.created_at).toLocaleTimeString())}</td>
    </tr>`).join('');

  res.send(`<!doctype html><html lang="en"><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="refresh" content="5">
  <title>${esc(cfg.businessName)} — Order-to-Cash</title>
  <style>
    body{font-family:system-ui,-apple-system,sans-serif;margin:2rem;color:#17201f;background:#f1f2f0}
    h1{font-size:1.3rem} h2{font-size:.95rem;margin-top:2rem;color:#0e6e7a;text-transform:uppercase;letter-spacing:.05em}
    table{border-collapse:collapse;width:100%;background:#fff;font-size:.85rem;box-shadow:0 1px 0 #e2e4e1}
    th,td{text-align:left;padding:.45rem .6rem;border-bottom:1px solid #e6e8e5}
    th{font-size:.68rem;text-transform:uppercase;letter-spacing:.05em;color:#586360}
    .num{text-align:right;font-variant-numeric:tabular-nums}
    .pill{font-size:.7rem;padding:.1rem .45rem;border-radius:3px;border:1px solid #bbb}
    .pill.paid{color:#2e7d4f;border-color:#2e7d4f}
    .pill.voice_escalated,.pill.owner_escalated{color:#bd3b2b;border-color:#bd3b2b}
    .pill.reminded{color:#a4741f;border-color:#a4741f}
    .pill.issued{color:#0e6e7a;border-color:#0e6e7a}
  </style></head><body>
  <h1>${esc(cfg.businessName)} — Order-to-Cash Agent</h1>
  <h2>Invoices</h2>
  <table><thead><tr><th>Invoice</th><th>Customer</th><th>Amount</th><th>Status</th><th>Due</th><th>Reminders</th></tr></thead>
  <tbody>${invRows || '<tr><td colspan="6">No invoices yet</td></tr>'}</tbody></table>
  <h2>Recent messages</h2>
  <table><thead><tr><th>Dir</th><th>Channel</th><th>Phone</th><th>Body</th><th>Time</th></tr></thead>
  <tbody>${msgRows || '<tr><td colspan="5">No messages yet</td></tr>'}</tbody></table>
  </body></html>`);
});

module.exports = router;
