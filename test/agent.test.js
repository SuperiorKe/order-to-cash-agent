// Collections ladder (src/agent.js tick()) behavior tests. Spec: Buzz thread
// f1838b14…, T4. Drives the real agent.tick() against a real embedded
// Postgres, controlled entirely by seeding invoices.due_date/status/
// reminders_sent directly — no real sleeps, no mocking of app logic.
//
// "amount <= 0 is skipped forever" (agent.js:29) is already covered by
// test/pricing.test.js:102 ("collections tick skips it while unpriced") and
// is not duplicated here.
//
// tick() scans every eligible invoice in the DB, including ones left by
// other tests in this file, so every assertion below is scoped to the
// invoice_id a given test seeded.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestDb } = require('./helpers/testdb');

let db, agent, cfg, pool;

before(async () => {
  db = await startTestDb();
  agent = require('../src/agent');
  cfg = require('../src/config');
  pool = require('../src/db').pool;
});

after(async () => {
  await pool?.end();
  await db?.stop();
});

// Creates a customer + order + invoice directly via SQL, bypassing intake
// entirely, with due_date set `dueMinutesAgo` minutes in the past (negative
// = due in the future).
async function seedInvoice({ status = 'issued', remindersSent = 0, dueMinutesAgo = 0, amount = 10000, name = 'Test Customer' } = {}) {
  const phone = `+2547${Math.floor(10000000 + Math.random() * 89999999)}`;
  const { rows: [cust] } = await pool.query(
    `insert into customers (name, phone) values ($1,$2) returning *`,
    [name, phone],
  );
  const items = [{ sku: 'TEST', name: 'test item', qty: 1, unit_price: amount, line_total: amount, priced_by: 'owner' }];
  const { rows: [order] } = await pool.query(
    `insert into orders (customer_id, items, total_amount, source, status) values ($1,$2,$3,'test','received') returning *`,
    [cust.id, JSON.stringify(items), amount],
  );
  const { rows: [invoice] } = await pool.query(
    `insert into invoices (order_id, amount, due_date, status, reminders_sent)
     values ($1,$2, now() - ($3 * interval '1 minute'), $4, $5) returning *`,
    [order.id, amount, dueMinutesAgo, status, remindersSent],
  );
  return { invoice, customer: cust, order };
}

const messagesFor = async (invoiceId) =>
  (await pool.query('select * from messages where invoice_id=$1 order by id', [invoiceId])).rows;

const invoiceRow = async (id) => (await pool.query('select * from invoices where id=$1', [id])).rows[0];

test('invoice not yet due is left alone', async () => {
  const { invoice } = await seedInvoice({ dueMinutesAgo: -24 * 60 });
  await agent.tick();
  const inv = await invoiceRow(invoice.id);
  const msgs = await messagesFor(invoice.id);
  assert.equal(inv.status, 'issued');
  assert.equal(inv.reminders_sent, 0);
  assert.equal(msgs.length, 0);
});

test('first reminder fires as soon as the invoice is overdue', async () => {
  const { invoice } = await seedInvoice({ dueMinutesAgo: 1 });
  await agent.tick();
  const inv = await invoiceRow(invoice.id);
  const msgs = await messagesFor(invoice.id);
  assert.equal(inv.status, 'reminded');
  assert.equal(inv.reminders_sent, 1);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].channel, 'sms');
  assert.match(msgs[0].body, /Invoice INV-\d+ of KES/);
});

test('second reminder fires once overdueBy clears reminderGapMin', async () => {
  const { reminderGapMin } = cfg.cadence;
  const { invoice } = await seedInvoice({ status: 'reminded', remindersSent: 1, dueMinutesAgo: reminderGapMin + 1 });
  await agent.tick();
  const inv = await invoiceRow(invoice.id);
  const msgs = await messagesFor(invoice.id);
  assert.equal(inv.status, 'reminded');
  assert.equal(inv.reminders_sent, 2);
  assert.equal(msgs.length, 1);
  assert.match(msgs[0].body, /^Reminder 2:/);
});

test('second reminder does not fire before reminderGapMin elapses', async () => {
  const { reminderGapMin } = cfg.cadence;
  const { invoice } = await seedInvoice({ status: 'reminded', remindersSent: 1, dueMinutesAgo: reminderGapMin - 0.5 });
  await agent.tick();
  const inv = await invoiceRow(invoice.id);
  const msgs = await messagesFor(invoice.id);
  assert.equal(inv.status, 'reminded');
  assert.equal(inv.reminders_sent, 1, 'still waiting on the gap');
  assert.equal(msgs.length, 0);
});

test('voice escalation fires once overdueBy clears 2x reminderGapMin', async () => {
  const { reminderGapMin } = cfg.cadence;
  const { invoice } = await seedInvoice({ status: 'reminded', remindersSent: 2, dueMinutesAgo: 2 * reminderGapMin - 0.5 });

  await agent.tick();
  let inv = await invoiceRow(invoice.id);
  let msgs = await messagesFor(invoice.id);
  assert.equal(inv.status, 'reminded', 'not yet at the 2x-gap threshold');
  assert.equal(msgs.length, 0);

  await pool.query(`update invoices set due_date = now() - ($2 * interval '1 minute') where id=$1`, [invoice.id, 2 * reminderGapMin + 1]);
  await agent.tick();
  inv = await invoiceRow(invoice.id);
  msgs = await messagesFor(invoice.id);
  assert.equal(inv.status, 'voice_escalated');
  assert.equal(inv.reminders_sent, 2, 'untouched by the voice step');
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].channel, 'voice');
  assert.equal(msgs[0].body, 'Automated payment reminder call');
});

test('owner escalation waits for ownerGapMin from due_date, then fires', async () => {
  const { ownerGapMin } = cfg.cadence;
  const { invoice } = await seedInvoice({ status: 'voice_escalated', remindersSent: 2, dueMinutesAgo: ownerGapMin - 0.5 });

  await agent.tick();
  let inv = await invoiceRow(invoice.id);
  let msgs = await messagesFor(invoice.id);
  assert.equal(inv.status, 'voice_escalated', 'not yet at the owner-gap threshold');
  assert.equal(msgs.length, 0);

  await pool.query(`update invoices set due_date = now() - ($2 * interval '1 minute') where id=$1`, [invoice.id, ownerGapMin + 1]);
  await agent.tick();
  inv = await invoiceRow(invoice.id);
  msgs = await messagesFor(invoice.id);
  assert.equal(inv.status, 'owner_escalated');
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].phone, cfg.cadence.ownerPhone);
  assert.match(msgs[0].body, /still unpaid after escalation/);
});

test('owner escalation never fires if ownerPhone is not configured', async () => {
  const { ownerGapMin } = cfg.cadence;
  const { invoice } = await seedInvoice({ status: 'voice_escalated', remindersSent: 2, dueMinutesAgo: ownerGapMin + 1 });

  const realOwnerPhone = cfg.cadence.ownerPhone;
  cfg.cadence.ownerPhone = '';
  try {
    await agent.tick();
    await agent.tick();
    await agent.tick();
  } finally {
    cfg.cadence.ownerPhone = realOwnerPhone;
  }

  const inv = await invoiceRow(invoice.id);
  const msgs = await messagesFor(invoice.id);
  assert.equal(inv.status, 'voice_escalated', 'stalls indefinitely with no owner phone configured');
  assert.equal(msgs.length, 0);
});

test('owner_escalated is terminal: no repeat nag no matter how overdue', async () => {
  const { invoice } = await seedInvoice({ status: 'owner_escalated', remindersSent: 2, dueMinutesAgo: 24 * 60 });
  await agent.tick();
  const inv = await invoiceRow(invoice.id);
  const msgs = await messagesFor(invoice.id);
  assert.equal(inv.status, 'owner_escalated');
  assert.equal(msgs.length, 0, 'no repeat owner notification, ever');
});

test('one state transition per tick(), even when every threshold is already overdue', async () => {
  const { ownerGapMin } = cfg.cadence;
  const { invoice } = await seedInvoice({ dueMinutesAgo: 10 * ownerGapMin });

  await agent.tick();
  let msgs = await messagesFor(invoice.id);
  let inv = await invoiceRow(invoice.id);
  assert.equal(msgs.length, 1, 'only the first reminder fires, not every threshold at once');
  assert.equal(inv.status, 'reminded');
  assert.equal(inv.reminders_sent, 1);
  assert.match(msgs[0].body, /Invoice INV-\d+ of KES/);

  await agent.tick();
  msgs = await messagesFor(invoice.id);
  inv = await invoiceRow(invoice.id);
  assert.equal(msgs.length, 2);
  assert.equal(inv.status, 'reminded');
  assert.equal(inv.reminders_sent, 2);
  assert.match(msgs[1].body, /^Reminder 2:/);

  await agent.tick();
  msgs = await messagesFor(invoice.id);
  inv = await invoiceRow(invoice.id);
  assert.equal(msgs.length, 3);
  assert.equal(inv.status, 'voice_escalated');
  assert.equal(msgs[2].channel, 'voice');

  await agent.tick();
  msgs = await messagesFor(invoice.id);
  inv = await invoiceRow(invoice.id);
  assert.equal(msgs.length, 4);
  assert.equal(inv.status, 'owner_escalated');
  assert.match(msgs[3].body, /still unpaid after escalation/);
});
