// Owner: Collections (B). Invoice lifecycle and state transitions.
const db = require('./db');
const cfg = require('./config');

async function issueInvoice(order, amount) {
  const due = new Date(Date.now() + cfg.cadence.termsDays * 24 * 60 * 60 * 1000);
  const { rows } = await db.query(
    `insert into invoices (order_id, amount, due_date, status)
     values ($1,$2,$3,'issued') returning *`,
    [order.id, amount, due.toISOString()],
  );
  return rows[0];
}

// Invoices the agent tick should consider, joined to the customer to reach them.
async function dueForFollowUp() {
  const { rows } = await db.query(
    `select i.*, c.phone, c.name
       from invoices i
       join orders o    on o.id = i.order_id
       join customers c on c.id = o.customer_id
      where i.status in ('issued','reminded','voice_escalated')
      order by i.due_date asc`,
  );
  return rows;
}

async function markReminded(id, count, status) {
  await db.query('update invoices set reminders_sent=$2, status=$3 where id=$1', [id, count, status]);
}

async function markVoiceEscalated(id) {
  await db.query("update invoices set status='voice_escalated' where id=$1", [id]);
}

async function markOwnerEscalated(id) {
  await db.query("update invoices set status='owner_escalated' where id=$1", [id]);
}

async function setCheckoutRequestId(id, checkoutRequestId) {
  await db.query('update invoices set checkout_request_id=$2 where id=$1', [id, checkoutRequestId]);
}

// Reconcile an M-Pesa success. Idempotent: only flips an unpaid invoice.
async function markPaid(checkoutRequestId, receipt) {
  const { rows } = await db.query(
    `update invoices set status='paid', mpesa_receipt=$2, paid_at=now()
      where checkout_request_id=$1 and status <> 'paid'
      returning *`,
    [checkoutRequestId, receipt],
  );
  return rows[0];
}

async function latestUnpaidByPhone(phone) {
  const { rows } = await db.query(
    `select i.* from invoices i
       join orders o    on o.id = i.order_id
       join customers c on c.id = o.customer_id
      where c.phone = $1 and i.status <> 'paid'
      order by i.created_at desc limit 1`,
    [phone],
  );
  return rows[0];
}

// One invoice, joined to the customer that owes it. Used by the JSON API
// (routes/api.js) so the owner's voice assistant can read the same row the
// dashboard shows, without a second path into Postgres.
async function getById(id) {
  const { rows } = await db.query(
    `select i.*, c.name, c.phone
       from invoices i
       join orders o    on o.id = i.order_id
       join customers c on c.id = o.customer_id
      where i.id = $1`,
    [id],
  );
  return rows[0];
}

// The one invoice for an order, joined to the customer that owes it. Every
// order gets exactly one invoice at creation (orders.createOrder calls
// issueInvoice once), so this is a lookup, not a list. Used by the
// order-scoped STK push route so Boss can name an order instead of an
// invoice number.
async function getByOrderId(orderId) {
  const { rows } = await db.query(
    `select i.*, c.name, c.phone
       from invoices i
       join orders o    on o.id = i.order_id
       join customers c on c.id = o.customer_id
      where o.id = $1`,
    [orderId],
  );
  return rows[0];
}

// Every unpaid invoice, due or not. Broader than overdueList(): lets the
// owner ask "who hasn't paid" and act on one before the collections tick
// would have escalated it on its own.
async function unpaidList() {
  const { rows } = await db.query(
    `select i.id, i.amount, i.status, i.due_date, i.reminders_sent, c.name, c.phone
       from invoices i
       join orders o    on o.id = i.order_id
       join customers c on c.id = o.customer_id
      where i.status <> 'paid'
      order by i.due_date asc`,
  );
  return rows;
}

// Invoices actually past due right now, as opposed to dueForFollowUp() which
// also includes ones not yet due (the tick needs those to know when to wait).
async function overdueList() {
  const { rows } = await db.query(
    `select i.id, i.amount, i.status, i.due_date, i.reminders_sent, c.name, c.phone
       from invoices i
       join orders o    on o.id = i.order_id
       join customers c on c.id = o.customer_id
      where i.status in ('issued','reminded','voice_escalated')
        and i.due_date < now()
      order by i.due_date asc`,
  );
  return rows;
}

module.exports = {
  issueInvoice, dueForFollowUp, markReminded, markVoiceEscalated,
  markOwnerEscalated, setCheckoutRequestId, markPaid, latestUnpaidByPhone,
  getById, getByOrderId, overdueList, unpaidList,
};
