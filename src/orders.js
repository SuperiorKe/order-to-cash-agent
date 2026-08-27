// Owner: Intake (A). Customer + order creation and pricing.
const db = require('./db');
const invoices = require('./invoices');

async function upsertCustomer(phone, name) {
  const { rows } = await db.query(
    `insert into customers (phone, name) values ($1,$2)
     on conflict (phone) do update set name = coalesce(excluded.name, customers.name)
     returning *`,
    [phone, name || null],
  );
  return rows[0];
}

// Match each requested item to the catalog by name. Unknown items price at 0
// so the owner can correct them, rather than blocking the order.
async function priceItems(items) {
  const priced = [];
  for (const it of items) {
    const { rows } = await db.query(
      `select sku, name, unit_price from products
       where active and lower(name) like lower($1) limit 1`,
      [`%${it.name}%`],
    );
    const p = rows[0];
    priced.push({
      sku: p?.sku || null,
      name: p?.name || it.name,
      qty: it.qty,
      unit_price: p ? Number(p.unit_price) : 0,
    });
  }
  const total = priced.reduce((s, i) => s + i.qty * i.unit_price, 0);
  return { priced, total };
}

async function createOrder({ phone, name, items, source, rawText }) {
  const customer = await upsertCustomer(phone, name);
  const { priced, total } = await priceItems(items);
  const { rows } = await db.query(
    `insert into orders (customer_id, items, total_amount, source, raw_text)
     values ($1,$2,$3,$4,$5) returning *`,
    [customer.id, JSON.stringify(priced), total, source, rawText || null],
  );
  const order = rows[0];
  const invoice = await invoices.issueInvoice(order, total);
  // An item we could not match to the catalog prices at 0. Never ask a customer
  // to pay an amount we have not actually worked out; hand it to the owner.
  const needsPricing = total <= 0 || priced.some((i) => !i.sku || !i.unit_price);
  return { customer, order, invoice, needsPricing };
}

// One order, joined to the customer. Used by the JSON API (routes/api.js)
// for the owner's voice assistant.
async function getById(id) {
  const { rows } = await db.query(
    `select o.*, c.name, c.phone
       from orders o
       join customers c on c.id = o.customer_id
      where o.id = $1`,
    [id],
  );
  return rows[0];
}

// Orders nobody has priced yet: total_amount <= 0, or one of the items
// never matched the catalog (same condition createOrder() computes as
// needsPricing, recomputed here since it is not persisted on the row).
// This is the closest thing this schema has to "the owner hasn't dealt
// with this yet" — order.status itself is set once at creation and never
// changes anywhere in the codebase, so it can't tell attended from not.
async function needsPricingList() {
  const { rows } = await db.query(
    `select o.id, o.items, o.total_amount, o.source, o.created_at, c.name, c.phone
       from orders o
       join customers c on c.id = o.customer_id
      where o.total_amount <= 0
         or exists (
              select 1 from jsonb_array_elements(o.items) it
              where (it->>'sku') is null or coalesce((it->>'unit_price')::numeric, 0) = 0
            )
      order by o.created_at desc`,
  );
  return rows;
}

// Orders joined to customer, optionally filtered by fulfillment. 'fulfilled'
// and 'unfulfilled' are the only two states this app ever sets on
// orders.status (see markFulfilled below); anything else returns every order.
async function listAll({ status } = {}) {
  const clause = status === 'fulfilled' ? `and o.status = 'fulfilled'`
    : status === 'unfulfilled' ? `and o.status <> 'fulfilled'`
    : '';
  const { rows } = await db.query(
    `select o.id, o.items, o.total_amount, o.source, o.status, o.created_at, c.name, c.phone
       from orders o
       join customers c on c.id = o.customer_id
      where true ${clause}
      order by o.created_at desc limit 30`,
  );
  return rows;
}

// Flip an order to fulfilled. Only ever set by the owner (via Friday, the
// voice assistant) saying the physical order is done — never inferred from
// payment, which is a separate axis. Returns undefined if the order does not
// exist or was already fulfilled, so the caller can tell those apart.
async function markFulfilled(id) {
  const { rows } = await db.query(
    `update orders set status='fulfilled' where id=$1 and status <> 'fulfilled' returning *`,
    [id],
  );
  return rows[0];
}

// Counts for "what kinds of orders do I have": fulfilled vs not, and how many
// of the unfulfilled ones are also stuck waiting on pricing (see
// needsPricingList for what that condition means).
async function summary() {
  const { rows } = await db.query(
    `select
       count(*) as total,
       count(*) filter (where status = 'fulfilled') as fulfilled,
       count(*) filter (where status <> 'fulfilled') as unfulfilled,
       count(*) filter (where status <> 'fulfilled' and (
         total_amount <= 0 or exists (
           select 1 from jsonb_array_elements(items) it
           where (it->>'sku') is null or coalesce((it->>'unit_price')::numeric, 0) = 0
         )
       )) as unfulfilled_needs_pricing
     from orders`,
  );
  return rows[0];
}

module.exports = {
  upsertCustomer, priceItems, createOrder, getById, needsPricingList,
  listAll, markFulfilled, summary,
};
