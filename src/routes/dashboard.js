// Owner: Surface (D). Minimal owner dashboard: invoices + live message trail,
// plus a "needs pricing" panel where the owner can price an order whose item
// never matched the catalog (see pricing.js).
// This is what you put on the projector during the demo.

const express = require('express');
const router = express.Router();
const cfg = require('../config');
const db = require('../db');
const orders = require('../orders');

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
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

  const pending = await orders.needsPricingList();

  return { invoices, msgs, pending };
}

// A send that failed after retries looks identical to a successful one unless
// we say so. Softened, not hidden: the demo should never silently claim a
// message went out when it did not.
const undeliveredBadge = (m) => (m.provider_id === 'error' ? ' <span class="pill undelivered">retrying&hellip;</span>' : '');

// An invoice at KES 0 is not "free", it is waiting on the owner. Say so
// instead of printing a zero.
const amountCell = (i) => (Number(i.amount) > 0
  ? `${cfg.currency} ${fmtAmount(i.amount)}`
  : '<span class="pill unpriced">needs pricing</span>');

function renderInvoiceRows(invoices) {
  return invoices.map((i) => `<tr id="inv-${i.id}">
      <td>INV-${i.id}</td>
      <td>${esc(i.name || i.phone)}</td>
      <td class="num">${amountCell(i)}</td>
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

// One row per order waiting on a price: what the customer asked for, and one
// amount box per unpriced line. Mirrored client-side in pendingRowHtml().
function renderPendingRows(pending) {
  return pending.map((o) => {
    const inputs = (o.items || []).map((it, idx) => (orders.isUnpriced(it)
      ? `<label class="line"><span>${esc(it.qty)} &times; ${esc(it.name)}</span>
           <input name="amt" data-idx="${idx}" inputmode="decimal" placeholder="${esc(cfg.currency)} line total" autocomplete="off"></label>`
      : `<span class="line priced">${esc(it.qty)} &times; ${esc(it.name)} &mdash; ${esc(cfg.currency)} ${fmtAmount(Number(it.qty) * Number(it.unit_price))}</span>`
    )).join('');
    return `<tr id="pend-${o.id}" data-inv="${o.invoice_id ?? ''}">
      <td>INV-${o.invoice_id ?? '?'}</td>
      <td>${esc(o.name || o.phone)}<div class="muted">${esc(o.source)}, ${esc(new Date(o.created_at).toLocaleString())}</div></td>
      <td><div class="asked">${esc(o.raw_text || '')}</div></td>
      <td class="lines">${inputs}</td>
      <td><button type="button" class="price-btn">Price &amp; invoice</button><div class="price-status"></div></td>
    </tr>`;
  }).join('');
}

router.get('/api/live', async (req, res) => {
  if (!(await db.healthy())) return res.json({ dbDown: true, invoices: [], msgs: [], pending: [] });
  const { invoices, msgs, pending } = await fetchState();
  res.json({ dbDown: false, invoices, msgs, pending });
});

router.get('/', async (req, res) => {
  if (!(await db.healthy())) {
    return res.send(`<h1>${esc(cfg.businessName)} — Order-to-Cash Agent</h1>
      <p>Database not connected. Set DATABASE_URL and run <code>npm run migrate</code>.</p>`);
  }

  const { invoices, msgs, pending } = await fetchState();
  const invRows = renderInvoiceRows(invoices);
  const msgRows = renderMessageRows(msgs);
  const pendRows = renderPendingRows(pending);

  res.send(`<!doctype html><html lang="en"><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="icon" href="data:,">
  <title>${esc(cfg.businessName)} — Order-to-Cash</title>
  <style>
    body{font-family:system-ui,-apple-system,sans-serif;margin:2rem;color:#17201f;background:#f1f2f0}
    h1{font-size:1.3rem} h2{font-size:.95rem;margin-top:2rem;color:#0e6e7a;text-transform:uppercase;letter-spacing:.05em}
    table{border-collapse:collapse;width:100%;background:#fff;font-size:.85rem;box-shadow:0 1px 0 #e2e4e1}
    th,td{text-align:left;padding:.45rem .6rem;border-bottom:1px solid #e6e8e5;vertical-align:top}
    th{font-size:.68rem;text-transform:uppercase;letter-spacing:.05em;color:#586360}
    .num{text-align:right;font-variant-numeric:tabular-nums}
    .pill{font-size:.7rem;padding:.1rem .45rem;border-radius:3px;border:1px solid #bbb}
    .pill.paid{color:#2e7d4f;border-color:#2e7d4f}
    .pill.voice_escalated,.pill.owner_escalated{color:#bd3b2b;border-color:#bd3b2b}
    .pill.reminded,.pill.undelivered,.pill.unpriced{color:#a4741f;border-color:#a4741f}
    .pill.issued{color:#0e6e7a;border-color:#0e6e7a}
    tr.flash{animation:flash 1.6s ease-out}
    @keyframes flash{0%{background:#d7f2e2}100%{background:transparent}}
    #pending-panel h2{color:#a4741f}
    #pending-panel table{border-left:3px solid #a4741f}
    #pending-panel .hint{font-size:.8rem;color:#586360;margin:-.4rem 0 .6rem}
    #pending-panel code{background:#e9eae6;padding:0 .3rem;border-radius:3px}
    .muted{font-size:.72rem;color:#586360;margin-top:.15rem}
    .asked{max-width:22rem;white-space:pre-wrap;color:#3a4441}
    .lines .line{display:flex;align-items:center;justify-content:space-between;gap:.6rem;margin:.15rem 0}
    .lines .line.priced{color:#586360}
    .lines input{width:9rem;padding:.3rem .45rem;border:1px solid #bbb;border-radius:3px;font:inherit;font-size:.85rem;text-align:right}
    .lines input:focus{outline:2px solid #0e6e7a;border-color:#0e6e7a}
    .price-btn{background:#0e6e7a;color:#fff;border:0;border-radius:3px;padding:.4rem .7rem;font:inherit;font-size:.8rem;cursor:pointer}
    .price-btn:disabled{opacity:.55;cursor:default}
    .price-status{font-size:.75rem;margin-top:.35rem;max-width:16rem}
    .price-status.ok{color:#2e7d4f} .price-status.err{color:#bd3b2b}
    tr.done td{background:#f4faf6}
  </style></head><body>
  <h1>${esc(cfg.businessName)} — Order-to-Cash Agent</h1>
  <section id="pending-panel"${pending.length ? '' : ' hidden'}>
    <h2>Needs pricing</h2>
    <p class="hint">These arrived with an item the catalog could not match. Enter what each line costs and the customer gets their invoice and an M-Pesa prompt. Or reply by SMS: <code>PRICE &lt;invoice&gt; &lt;amount&gt;</code>.</p>
    <table><thead><tr><th>Invoice</th><th>Customer</th><th>What they asked for</th><th>Lines</th><th></th></tr></thead>
    <tbody id="pend-body">${pendRows}</tbody></table>
  </section>
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
      return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
      });
    }
    function fmtAmount(n) {
      return Number(n).toLocaleString('en-KE', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
    }
    function isUnpriced(it) { return !(Number(it && it.unit_price) > 0); }
    function amountCell(i) {
      return Number(i.amount) > 0 ? CURRENCY + ' ' + fmtAmount(i.amount) : '<span class="pill unpriced">needs pricing</span>';
    }

    function renderInvoices(rows) {
      var tbody = document.getElementById('inv-body');
      if (!rows.length) { tbody.innerHTML = '<tr><td colspan="6">No invoices yet</td></tr>'; return; }
      tbody.innerHTML = rows.map(function (i) {
        var sig = i.status + ':' + i.reminders_sent + ':' + i.amount;
        var isNew = prevInv.has(String(i.id)) ? prevInv.get(String(i.id)) !== sig : true;
        prevInv.set(String(i.id), sig);
        return '<tr id="inv-' + i.id + '" class="' + (!first && isNew ? 'flash' : '') + '">' +
          '<td>INV-' + i.id + '</td>' +
          '<td>' + esc(i.name || i.phone) + '</td>' +
          '<td class="num">' + amountCell(i) + '</td>' +
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

    // Mirrors renderPendingRows() on the server.
    function pendingRowHtml(o) {
      var inputs = (o.items || []).map(function (it, idx) {
        return isUnpriced(it)
          ? '<label class="line"><span>' + esc(it.qty) + ' &times; ' + esc(it.name) + '</span>' +
            '<input name="amt" data-idx="' + idx + '" inputmode="decimal" placeholder="' + esc(CURRENCY) + ' line total" autocomplete="off"></label>'
          : '<span class="line priced">' + esc(it.qty) + ' &times; ' + esc(it.name) + ' &mdash; ' + esc(CURRENCY) + ' ' + fmtAmount(Number(it.qty) * Number(it.unit_price)) + '</span>';
      }).join('');
      return '<tr id="pend-' + o.id + '" data-inv="' + (o.invoice_id == null ? '' : o.invoice_id) + '">' +
        '<td>INV-' + (o.invoice_id == null ? '?' : o.invoice_id) + '</td>' +
        '<td>' + esc(o.name || o.phone) + '<div class="muted">' + esc(o.source) + ', ' + esc(new Date(o.created_at).toLocaleString()) + '</div></td>' +
        '<td><div class="asked">' + esc(o.raw_text || '') + '</div></td>' +
        '<td class="lines">' + inputs + '</td>' +
        '<td><button type="button" class="price-btn">Price &amp; invoice</button><div class="price-status"></div></td>' +
      '</tr>';
    }

    // Never re-render a row that is already on screen: the owner may be
    // typing in it. Only add rows for new orders and drop rows that have
    // been priced (they stop coming back from the server).
    function syncPending(rows) {
      var panel = document.getElementById('pending-panel');
      var tbody = document.getElementById('pend-body');
      var keep = new Set(rows.map(function (o) { return 'pend-' + o.id; }));
      Array.prototype.slice.call(tbody.querySelectorAll('tr[id]')).forEach(function (tr) {
        if (!keep.has(tr.id)) tr.remove();
      });
      rows.forEach(function (o) {
        if (!document.getElementById('pend-' + o.id)) {
          tbody.insertAdjacentHTML('beforeend', pendingRowHtml(o));
          if (!first) document.getElementById('pend-' + o.id).classList.add('flash');
        }
      });
      panel.hidden = tbody.querySelectorAll('tr[id]').length === 0;
    }

    function setStatus(tr, text, cls) {
      var el = tr.querySelector('.price-status');
      el.textContent = text;
      el.className = 'price-status ' + (cls || '');
    }

    document.getElementById('pend-body').addEventListener('click', function (ev) {
      var btn = ev.target.closest('.price-btn');
      if (!btn) return;
      var tr = btn.closest('tr');
      var inv = tr.getAttribute('data-inv');
      var inputs = Array.prototype.slice.call(tr.querySelectorAll('input[name=amt]'));
      var amounts = inputs.map(function (i) { return i.value.trim(); });
      if (amounts.some(function (a) { return !a; })) {
        setStatus(tr, 'Enter an amount for every line.', 'err');
        return;
      }
      btn.disabled = true;
      setStatus(tr, 'Pricing…', '');
      fetch('/api/invoices/' + inv + '/price', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amounts: amounts }),
      }).then(function (r) {
        return r.json().then(function (data) { return { status: r.status, data: data }; });
      }).then(function (res) {
        if (res.status === 401) {
          setStatus(tr, 'Dashboard pricing is off while VOICE_AGENT_API_KEY is set. Reply PRICE ' + inv + ' <amount> by SMS, or ask Friday.', 'err');
          btn.disabled = false;
          return;
        }
        if (res.status !== 200) {
          setStatus(tr, res.data.error || ('Failed (' + res.status + ')'), 'err');
          btn.disabled = false;
          return;
        }
        tr.classList.add('done');
        inputs.forEach(function (i) { i.disabled = true; });
        setStatus(tr, 'Priced at ' + CURRENCY + ' ' + fmtAmount(res.data.total) + '. ' +
          (res.data.customerNotified ? 'Customer sent invoice + M-Pesa prompt.' : 'Customer notification failed; reminders will follow.'), 'ok');
        // Leave the confirmation readable for a moment; the next poll after
        // that removes the row since it is no longer unpriced.
        tr.setAttribute('data-keep-until', String(Date.now() + 6000));
      }).catch(function () {
        setStatus(tr, 'Network error, try again.', 'err');
        btn.disabled = false;
      });
    });

    function poll() {
      fetch('/api/live').then(function (r) { return r.json(); }).then(function (data) {
        if (data.dbDown) return;
        renderInvoices(data.invoices);
        renderMessages(data.msgs);
        // Rows still showing a fresh confirmation are kept a little longer.
        var pending = data.pending.slice();
        Array.prototype.slice.call(document.querySelectorAll('#pend-body tr[data-keep-until]')).forEach(function (tr) {
          if (Number(tr.getAttribute('data-keep-until')) > Date.now()) {
            pending.push({ id: tr.id.slice(5) });
          }
        });
        syncPending(pending);
        first = false;
      }).catch(function () { /* skip a beat, try again next tick */ });
    }

    setInterval(poll, 3000);
  })();
  </script>
  </body></html>`);
});

module.exports = router;
