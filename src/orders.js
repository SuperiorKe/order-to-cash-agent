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

// One definition of "this line still needs a price", shared by the JS that
// computes needsPricing at intake, the SQL lists below, and routes/api.js.
// An unmatched item is stored with unit_price 0 (see priceItems), and a
// custom item the owner prices by hand keeps sku null, so the price is the
// only honest signal — a sku check would keep hand-priced lines in the
// needs-pricing list forever.
function isUnpriced(item) {
  return !(Number(item?.unit_price) > 0);
}
const UNPRICED_ITEM_SQL = `exists (
  select 1 from jsonb_array_elements(%ITEMS%) it
  where coalesce((it->>'unit_price')::numeric, 0) <= 0
)`;
const unpricedSql = (itemsCol, totalCol) =>
  `(${totalCol} <= 0 or ${UNPRICED_ITEM_SQL.replace('%ITEMS%', itemsCol)})`;

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
  // An item we could not match to the catalog prices at 0. Never ask a customer
  // to pay an amount we have not actually worked out; hand it to the owner.
  // The invoice is held at 0 until every line has a price — otherwise a
  // partly matched order ("3 custom gates and 2 steel doors") would be
  // invoiced, and then chased by the collections tick, for the doors alone.
  // pricing.js sets the real amount once the owner fills in the gap.
  const needsPricing = total <= 0 || priced.some(isUnpriced);
  const invoice = await invoices.issueInvoice(order, needsPricing ? 0 : total);
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
    `select o.id, o.items, o.total_amount, o.source, o.raw_text, o.created_at, c.name, c.phone,
            i.id as invoice_id, i.status as invoice_status
       from orders o
       join customers c on c.id = o.customer_id
       left join invoices i on i.order_id = o.id
      where ${unpricedSql('o.items', 'o.total_amount')}
        and coalesce(i.status, '') <> 'paid'
      order by o.created_at desc`,
  );
  return rows;
}

// Orders joined to customer and (left) to their invoice, optionally filtered.
// 'fulfilled'/'unfulfilled' read orders.status (see markFulfilled below).
// 'payment_failed' reads the invoice's last recorded STK failure — this is
// an independent lens, not a third fulfillment bucket, the same way
// 'unattended' already overlaps 'unfulfilled' rather than excluding it.
// Anything else (or omitted) returns every order.
async function listAll({ status } = {}) {
  const clause = status === 'fulfilled' ? `and o.status = 'fulfilled'`
    : status === 'unfulfilled' ? `and o.status <> 'fulfilled'`
    : status === 'payment_failed' ? `and i.last_stk_result is not null and i.status <> 'paid'`
    : '';
  const { rows } = await db.query(
    `select o.id, o.items, o.total_amount, o.source, o.status, o.created_at, c.name, c.phone,
            i.status as invoice_status, i.last_stk_result, i.last_stk_result_at
       from orders o
       join customers c on c.id = o.customer_id
       left join invoices i on i.order_id = o.id
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
       count(*) filter (where status <> 'fulfilled' and ${unpricedSql('items', 'total_amount')})
         as unfulfilled_needs_pricing
     from orders`,
  );
  return rows[0];
}

// Persist owner-set prices onto an order's item lines and recompute the
// total. `prices` is keyed by line index: { unit_price, line_total }. The
// owner names what a line costs, so line_total is the truth and unit_price
// is derived (rounded to 2dp) — 3 gates for 10,000 must invoice 10,000, not
// 9,999.99. Lines priced this way carry `priced_by: "owner"` so the audit
// trail can tell a hand price from a catalog match; sku stays null for
// custom items. Pure persistence — validation and the customer-facing
// follow-up live in pricing.js.
async function applyPrices(orderId, prices) {
  const order = await getById(orderId);
  if (!order) return undefined;
  const items = (order.items || []).map((it, idx) => (
    prices[idx] === undefined ? it
      : { ...it, unit_price: prices[idx].unit_price, line_total: prices[idx].line_total, priced_by: 'owner' }
  ));
  const total = items.reduce((s, i) => s + (
    i.line_total !== undefined ? Number(i.line_total) : Number(i.qty) * Number(i.unit_price)
  ), 0);
  const { rows } = await db.query(
    `update orders set items=$2, total_amount=$3 where id=$1 returning *`,
    [orderId, JSON.stringify(items), total],
  );
  return rows[0];
}

module.exports = {
  upsertCustomer, priceItems, createOrder, getById, needsPricingList,
  listAll, markFulfilled, summary, isUnpriced, unpricedSql, applyPrices,
};
