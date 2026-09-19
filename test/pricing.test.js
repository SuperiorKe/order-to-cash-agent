// End-to-end tests for the owner pricing workflow against a real embedded
// Postgres, driving the Express app over HTTP in dry-run mode. Every "send"
// (SMS, STK push) lands in the messages table, which is what we assert on.

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { startTestDb } = require('./helpers/testdb');

let db, app, server, base, agent, pool;
const OWNER = '+254711000111';
const CUSTOMER = '+254722000222';
const STRANGER = '+254733000333';

const form = (obj) => new URLSearchParams(obj).toString();
const post = (path, body, headers = {}) => fetch(base + path, {
  method: 'POST',
  headers: typeof body === 'string'
    ? { 'Content-Type': 'application/x-www-form-urlencoded', ...headers }
    : { 'Content-Type': 'application/json', ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});
const get = (path, headers = {}) => fetch(base + path, { headers });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Webhooks ack before doing their work; wait for the async tail to settle.
async function settle(predicate, tries = 40) {
  for (let i = 0; i < tries; i++) {
    if (await predicate()) return;
    await sleep(50);
  }
  throw new Error('condition not met in time');
}
const messages = async (where = 'true', params = []) =>
  (await pool.query(`select * from messages where ${where} order by id`, params)).rows;
const bodies = async (where, params) => (await messages(where, params)).map((m) => m.body);

async function ussdOrder(phone, product, qty) {
  const r = await post('/ussd', form({ sessionId: 's' + Math.random(), phoneNumber: phone, serviceCode: '*384#', text: `1*${product}*${qty}` }));
  const text = await r.text();
  const m = /INV-(\d+)/.exec(text);
  return { text, invoiceId: Number(m[1]) };
}

async function smsIn(from, text) {
  const r = await post('/webhooks/sms/inbound', form({ from, to: '12345', text, id: 'm' + Math.random() }));
  assert.equal(r.status, 200);
}

before(async () => {
  db = await startTestDb();
  app = require('../src/server');
  agent = require('../src/agent');
  pool = require('../src/db').pool;
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server?.close();
  await pool?.end();
  await db?.stop();
});

describe('intake of an item the catalog cannot match', () => {
  let invoiceId;

  test('USSD order lands at KES 0 and is flagged, customer + owner told', async () => {
    const r = await ussdOrder(CUSTOMER, 'custom garden gate', 3);
    assert.match(r.text, /^END Order INV-\d+ received\. We are confirming the price/);
    invoiceId = r.invoiceId;

    const { rows: [inv] } = await pool.query('select * from invoices where id=$1', [invoiceId]);
    assert.equal(Number(inv.amount), 0);
    assert.equal(inv.status, 'issued');
    assert.equal(inv.priced_at, null);

    await settle(async () => (await messages('invoice_id=$1', [invoiceId])).length >= 2);
    const out = await bodies("invoice_id=$1 and direction='out'", [invoiceId]);
    assert.ok(out.some((b) => /We have your order INV-\d+\. We are confirming the price/.test(b)), 'customer told to wait');
    assert.ok(out.some((b) => /needs pricing: USSD custom garden gate x3/.test(b)), 'owner alerted');
    assert.ok(!out.some((b) => /STK push/.test(b)), 'no M-Pesa prompt for an unpriced order');
  });

  test('shows up as unattended, stage needs_pricing, and on the dashboard', async () => {
    const un = await (await get('/api/orders/unattended')).json();
    const row = un.orders.find((o) => Number(o.invoice_id) === invoiceId);
    assert.ok(row, 'in unattended list');
    assert.equal(row.raw_text, 'USSD custom garden gate x3');

    const ord = await (await get(`/api/orders/${row.id}`)).json();
    assert.equal(ord.order.stage, 'needs_pricing');

    const html = await (await get('/')).text();
    assert.match(html, /<section id="pending-panel">/, 'panel visible');
    assert.match(html, new RegExp(`<tr id="pend-${row.id}" data-inv="${invoiceId}">`));
    assert.match(html, /needs pricing<\/span>/, 'invoice amount shown as needs pricing, not KES 0');

    const live = await (await get('/api/live')).json();
    assert.ok(live.pending.some((o) => Number(o.invoice_id) === invoiceId));
  });

  test('collections tick skips it while unpriced', async () => {
    await pool.query(`update invoices set due_date = now() - interval '1 hour' where id=$1`, [invoiceId]);
    await agent.tick();
    const { rows: [inv] } = await pool.query('select * from invoices where id=$1', [invoiceId]);
    assert.equal(inv.reminders_sent, 0);
    assert.equal(inv.status, 'issued');
  });

  test('PRICE from a non-owner is refused and creates no order', async () => {
    const before = Number((await pool.query('select count(*) from orders')).rows[0].count);
    await smsIn(STRANGER, `PRICE ${invoiceId} 1`);
    await settle(async () => (await messages("phone=$1 and direction='out'", [STRANGER])).length >= 1);
    const [reply] = await bodies("phone=$1 and direction='out'", [STRANGER]);
    assert.match(reply, /keyword for the business owner/);
    const after = Number((await pool.query('select count(*) from orders')).rows[0].count);
    assert.equal(after, before, 'no order created from the PRICE text');
    const { rows: [inv] } = await pool.query('select amount from invoices where id=$1', [invoiceId]);
    assert.equal(Number(inv.amount), 0);
  });

  test('owner SMS "PRICE <inv> 45,000" prices it and the customer gets invoice + M-Pesa prompt', async () => {
    const t0 = Date.now();
    await smsIn(OWNER, `price INV-${invoiceId} 45,000`);
    await settle(async () => (await bodies("phone=$1 and direction='out' and body like 'INV-%priced%'", [OWNER])).length >= 1);

    const { rows: [inv] } = await pool.query('select * from invoices where id=$1', [invoiceId]);
    assert.equal(Number(inv.amount), 45000);
    assert.ok(inv.priced_at, 'priced_at stamped');
    const dueMs = new Date(inv.due_date).getTime() - t0;
    assert.ok(Math.abs(dueMs - 7 * 24 * 3600e3) < 60e3, 'payment terms restart from pricing time');
    assert.equal(inv.checkout_request_id, `DRY-${invoiceId}`, 'STK push attempted');

    const { rows: [order] } = await pool.query('select * from orders where id=$1', [inv.order_id]);
    assert.equal(Number(order.total_amount), 45000);
    assert.deepEqual(order.items.map((i) => [i.unit_price, i.line_total, i.priced_by, i.sku]), [[15000, 45000, 'owner', null]]);

    const out = await bodies("invoice_id=$1 and direction='out'", [invoiceId]);
    assert.ok(out.some((b) => new RegExp(`Order INV-${invoiceId} confirmed: 3 x custom garden gate\\. Total KES 45,000, due`).test(b)), 'customer confirmation');
    assert.ok(out.some((b) => /STK push \(dry-run\) KES 45,000/.test(b)), 'M-Pesa prompt');
    const [ownerReply] = await bodies("phone=$1 and direction='out' and body like 'INV-%priced%'", [OWNER]);
    assert.match(ownerReply, new RegExp(`^INV-${invoiceId} priced: 3 x custom garden gate = KES 45,000\\. Total KES 45,000, due .*Customer sent the invoice and an M-Pesa prompt\\.$`));

    const audit = await bodies("invoice_id=$1 and direction='in' and channel='sms' and body like 'Owner priced%'", [invoiceId]);
    assert.equal(audit.length, 1);
  });

  test('now out of the unattended list, stage awaiting_payment, and the tick picks it up', async () => {
    const un = await (await get('/api/orders/unattended')).json();
    assert.ok(!un.orders.some((o) => Number(o.invoice_id) === invoiceId));
    const { rows: [inv] } = await pool.query('select order_id from invoices where id=$1', [invoiceId]);
    const ord = await (await get(`/api/orders/${inv.order_id}`)).json();
    assert.equal(ord.order.stage, 'awaiting_payment');

    const html = await (await get('/')).text();
    assert.doesNotMatch(html, new RegExp(`<tr id="pend-${inv.order_id}"`));

    await pool.query(`update invoices set due_date = now() - interval '1 hour' where id=$1`, [invoiceId]);
    await agent.tick();
    const { rows: [after] } = await pool.query('select * from invoices where id=$1', [invoiceId]);
    assert.equal(after.reminders_sent, 1);
    assert.equal(after.status, 'reminded');
    const out = await bodies("invoice_id=$1 and direction='out'", [invoiceId]);
    assert.ok(out.some((b) => new RegExp(`Invoice INV-${invoiceId} of KES 45,000 is due`).test(b)));
  });

  test('pricing it a second time is refused with the existing amount', async () => {
    await smsIn(OWNER, `PRICE ${invoiceId} 50000`);
    await settle(async () => (await bodies("phone=$1 and direction='out' and body like '%already priced%'", [OWNER])).length >= 1);
    const [reply] = await bodies("phone=$1 and direction='out' and body like '%already priced%'", [OWNER]);
    assert.match(reply, new RegExp(`INV-${invoiceId} is already priced at KES 45,000`));
    const { rows: [inv] } = await pool.query('select amount from invoices where id=$1', [invoiceId]);
    assert.equal(Number(inv.amount), 45000);
  });
});

describe('mixed orders through the JSON API', () => {
  let invoiceId, orderId;

  test('SMS order with one catalog item and one custom item prices only the custom line', async () => {
    await smsIn(CUSTOMER, '3 custom gates and 2 standard steel door');
    await settle(async () => (await pool.query(`select 1 from orders where raw_text=$1`, ['3 custom gates and 2 standard steel door'])).rowCount === 1);
    const { rows: [inv] } = await pool.query(
      `select i.*, o.items from invoices i join orders o on o.id=i.order_id where o.raw_text=$1`,
      ['3 custom gates and 2 standard steel door']);
    invoiceId = inv.id; orderId = inv.order_id;
    assert.equal(Number(inv.amount), 0, 'invoice held at 0 until every line is priced');
    assert.equal(inv.items.length, 2);
    assert.equal(inv.items[1].sku, 'DR-STD');
    assert.equal(Number(inv.items[1].unit_price), 12000);

    // 3 gates for 10,000: line total is the truth, unit price is derived.
    const r = await post(`/api/invoices/${invoiceId}/price`, { amount: 10000 });
    assert.equal(r.status, 200);
    const data = await r.json();
    assert.equal(data.total, 34000);
    assert.deepEqual(data.lines, [{ name: 'custom gates', qty: 3, line_total: 10000, unit_price: 3333.33 }]);
    assert.equal(data.customerNotified, true);
    assert.equal(data.stkResponseCode, 'dry-run');

    const { rows: [after] } = await pool.query('select amount from invoices where id=$1', [invoiceId]);
    assert.equal(Number(after.amount), 34000);
    const stage = (await (await get(`/api/orders/${orderId}`)).json()).order.stage;
    assert.equal(stage, 'awaiting_payment');
    const audit = await bodies("invoice_id=$1 and channel='api'", [invoiceId]);
    assert.equal(audit.length, 1);
    assert.match(audit[0], /Owner priced INV-\d+: 3 x custom gates = KES 10,000\. Total KES 34,000\./);
  });

  test('wrong number of amounts is a 400 that names the lines', async () => {
    await smsIn(CUSTOMER, '2 hinges and 1 bespoke railing');
    await settle(async () => (await pool.query(`select 1 from orders where raw_text=$1`, ['2 hinges and 1 bespoke railing'])).rowCount === 1);
    const { rows: [inv] } = await pool.query(
      `select i.* from invoices i join orders o on o.id=i.order_id where o.raw_text=$1`, ['2 hinges and 1 bespoke railing']);

    let r = await post(`/api/invoices/${inv.id}/price`, { amount: 5000 });
    assert.equal(r.status, 400);
    let data = await r.json();
    assert.equal(data.code, 'count_mismatch');
    assert.deepEqual([data.expected, data.got, data.lines], [2, 1, ['2 x hinges', '1 x bespoke railing']]);

    r = await post(`/api/invoices/${inv.id}/price`, { amounts: [800, 'abc'] });
    assert.equal(r.status, 400);
    assert.equal((await r.json()).code, 'bad_amounts');

    // SMS gets the same guidance in words.
    await smsIn(OWNER, `PRICE ${inv.id} 5000`);
    await settle(async () => (await bodies("phone=$1 and direction='out' and body like '%one amount per line%'", [OWNER])).length >= 1);
    const [reply] = await bodies("phone=$1 and direction='out' and body like '%one amount per line%'", [OWNER]);
    assert.match(reply, new RegExp(`Reply PRICE ${inv.id} <amount> <amount> — one amount per line: 2 x hinges, 1 x bespoke railing\\.$`));

    // Two amounts, order-scoped route this time.
    r = await post(`/api/orders/${inv.order_id}/price`, { amounts: ['1,000', 7000] });
    assert.equal(r.status, 200);
    data = await r.json();
    assert.equal(data.total, 8000);
    assert.deepEqual(data.lines.map((l) => l.unit_price), [500, 7000]);
  });

  test('404s, paid invoices, and the API key', async () => {
    assert.equal((await post('/api/invoices/999999/price', { amount: 1 })).status, 404);
    assert.equal((await post('/api/orders/999999/price', { amount: 1 })).status, 404);
    assert.equal((await post('/api/invoices/abc/price', { amount: 1 })).status, 404);
    assert.equal((await post('/api/orders/abc/price', { amount: 1 })).status, 404);

    const { invoiceId: paidId } = await ussdOrder(CUSTOMER, 'mystery widget', 1);
    await pool.query(`update invoices set status='paid', paid_at=now() where id=$1`, [paidId]);
    const r = await post(`/api/invoices/${paidId}/price`, { amount: 100 });
    assert.equal(r.status, 409);
    assert.equal((await r.json()).code, 'already_paid');

    const { invoiceId: lockedId } = await ussdOrder(CUSTOMER, 'another widget', 1);
    process.env.VOICE_AGENT_API_KEY = 'secret-key';
    try {
      assert.equal((await post(`/api/invoices/${lockedId}/price`, { amount: 100 })).status, 401, 'dashboard/anonymous locked out');
      const ok = await post(`/api/invoices/${lockedId}/price`, { amount: 100 }, { 'x-api-key': 'secret-key' });
      assert.equal(ok.status, 200);
    } finally {
      delete process.env.VOICE_AGENT_API_KEY;
    }
  });

  test('order summary counts pricing correctly after the changes', async () => {
    const s = (await (await get('/api/orders/summary')).json()).orders;
    // Only the paid-but-unpriced "mystery widget" order is still unpriced.
    assert.equal(Number(s.unfulfilled_needs_pricing), 1);
    const un = await (await get('/api/orders/unattended')).json();
    assert.equal(un.orders.length, 0, 'a paid invoice is never asked to be priced');
  });
});
