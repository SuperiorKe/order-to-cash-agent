// Owner: Surface (D). Minimal owner dashboard: invoices + live message trail.
// This is what you put on the projector during the demo.

const express = require('express');
const router = express.Router();
const cfg = require('../config');
const db = require('../db');

const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const fmtAmount = (n) => Number(n).toLocaleString('en-KE', { minimumFractionDigits: 0, maximumFractionDigits: 0 });

async function fetchState() {
  const invoices = (await db.query(
    `select i.id, i.amount, i.status, i.due_date, i.reminders_sent, c.name, c.phone
       from invoices i
       join orders o    on o.id = i.order_id
       join customers c on c.id = o.customer_id
      order by i.created_at desc limit 25`,
  )).rows;

  const msgs = (await db.query(
    `select id, direction, channel, phone, body, provider_id, created_at
       from messages order by created_at desc limit 20`,
  )).rows;

  return { invoices, msgs };
}

// A send that failed after retries looks identical to a successful one unless
// we say so. Softened, not hidden: the demo should never silently claim a
// message went out when it did not.
const undeliveredBadge = (m) => (m.provider_id === 'error' ? ' <span class="pill undelivered">retrying&hellip;</span>' : '');

function renderInvoiceRows(invoices) {
  return invoices.map((i) => `<tr id="inv-${i.id}">
      <td>INV-${i.id}</td>
      <td>${esc(i.name || i.phone)}</td>
      <td class="num">${cfg.currency} ${fmtAmount(i.amount)}</td>
      <td><span class="pill ${esc(i.status)}">${esc(i.status)}</span></td>
      <td>${esc(new Date(i.due_date).toLocaleString())}</td>
      <td class="num">${i.reminders_sent}</td>
    </tr>`).join('');
}

function renderMessageRows(msgs) {
  return msgs.map((m) => `<tr id="msg-${m.id}">
      <td>${esc(m.direction)}</td>
      <td>${esc(m.channel)}</td>
      <td>${esc(m.phone)}</td>
      <td>${esc(m.body)}${undeliveredBadge(m)}</td>
      <td>${esc(new Date(m.created_at).toLocaleTimeString())}</td>
    </tr>`).join('');
}

router.get('/api/live', async (req, res) => {
  if (!(await db.healthy())) return res.json({ dbDown: true, invoices: [], msgs: [] });
  const { invoices, msgs } = await fetchState();
  res.json({ dbDown: false, invoices, msgs });
});

router.get('/', async (req, res) => {
  if (!(await db.healthy())) {
    return res.send(`<h1>${esc(cfg.businessName)} — Order-to-Cash Agent</h1>
      <p>Database not connected. Set DATABASE_URL and run <code>npm run migrate</code>.</p>`);
  }

  const { invoices, msgs } = await fetchState();
  const invRows = renderInvoiceRows(invoices);
  const msgRows = renderMessageRows(msgs);

  res.send(`<!doctype html><html lang="en"><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
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
    .pill.reminded,.pill.undelivered{color:#a4741f;border-color:#a4741f}
    .pill.issued{color:#0e6e7a;border-color:#0e6e7a}
    tr.flash{animation:flash 1.6s ease-out}
    @keyframes flash{0%{background:#d7f2e2}100%{background:transparent}}
  </style></head><body>
  <h1>${esc(cfg.businessName)} — Order-to-Cash Agent</h1>
  <h2>Invoices</h2>
  <table><thead><tr><th>Invoice</th><th>Customer</th><th>Amount</th><th>Status</th><th>Due</th><th>Reminders</th></tr></thead>
  <tbody id="inv-body">${invRows || '<tr><td colspan="6">No invoices yet</td></tr>'}</tbody></table>
  <h2>Recent messages</h2>
  <table><thead><tr><th>Dir</th><th>Channel</th><th>Phone</th><th>Body</th><th>Time</th></tr></thead>
  <tbody id="msg-body">${msgRows || '<tr><td colspan="5">No messages yet</td></tr>'}</tbody></table>
  <script>
  (function () {
    var CURRENCY = ${JSON.stringify(cfg.currency)};
    var prevInv = new Map();
    var knownMsgIds = new Set();
    var first = true;

    // Seed from what the server already rendered, so the very first poll
    // does not flash every row that was already on screen at page load.
    document.querySelectorAll('#inv-body tr[id]').forEach(function (tr) {
      prevInv.set(tr.id.slice(4), null);
    });
    document.querySelectorAll('#msg-body tr[id]').forEach(function (tr) {
      knownMsgIds.add(tr.id.slice(4));
    });

    function esc(s) {
      return String(s == null ? '' : s).replace(/[&<>]/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c];
      });
    }
    function fmtAmount(n) {
      return Number(n).toLocaleString('en-KE', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
    }

    function renderInvoices(rows) {
      var tbody = document.getElementById('inv-body');
      if (!rows.length) { tbody.innerHTML = '<tr><td colspan="6">No invoices yet</td></tr>'; return; }
      tbody.innerHTML = rows.map(function (i) {
        var sig = i.status + ':' + i.reminders_sent;
        var isNew = prevInv.has(String(i.id)) ? prevInv.get(String(i.id)) !== sig : true;
        prevInv.set(String(i.id), sig);
        return '<tr id="inv-' + i.id + '" class="' + (!first && isNew ? 'flash' : '') + '">' +
          '<td>INV-' + i.id + '</td>' +
          '<td>' + esc(i.name || i.phone) + '</td>' +
          '<td class="num">' + CURRENCY + ' ' + fmtAmount(i.amount) + '</td>' +
          '<td><span class="pill ' + esc(i.status) + '">' + esc(i.status) + '</span></td>' +
          '<td>' + esc(new Date(i.due_date).toLocaleString()) + '</td>' +
          '<td class="num">' + i.reminders_sent + '</td>' +
        '</tr>';
      }).join('');
    }

    function renderMessages(rows) {
      var tbody = document.getElementById('msg-body');
      if (!rows.length) { tbody.innerHTML = '<tr><td colspan="5">No messages yet</td></tr>'; return; }
      tbody.innerHTML = rows.map(function (m) {
        var isNew = !knownMsgIds.has(String(m.id));
        knownMsgIds.add(String(m.id));
        var badge = m.provider_id === 'error' ? ' <span class="pill undelivered">retrying&hellip;</span>' : '';
        return '<tr id="msg-' + m.id + '" class="' + (!first && isNew ? 'flash' : '') + '">' +
          '<td>' + esc(m.direction) + '</td>' +
          '<td>' + esc(m.channel) + '</td>' +
          '<td>' + esc(m.phone) + '</td>' +
          '<td>' + esc(m.body) + badge + '</td>' +
          '<td>' + esc(new Date(m.created_at).toLocaleTimeString()) + '</td>' +
        '</tr>';
      }).join('');
    }

    function poll() {
      fetch('/api/live').then(function (r) { return r.json(); }).then(function (data) {
        if (data.dbDown) return;
        renderInvoices(data.invoices);
        renderMessages(data.msgs);
        first = false;
      }).catch(function () { /* skip a beat, try again next tick */ });
    }

    setInterval(poll, 3000);
  })();
  </script>
  </body></html>`);
});

module.exports = router;
