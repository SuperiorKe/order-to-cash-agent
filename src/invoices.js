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

module.exports = {
  issueInvoice, dueForFollowUp, markReminded, markVoiceEscalated,
  markOwnerEscalated, setCheckoutRequestId, markPaid, latestUnpaidByPhone,
};
