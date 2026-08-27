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

module.exports = { upsertCustomer, priceItems, createOrder };
