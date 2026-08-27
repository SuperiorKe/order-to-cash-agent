-- Order-to-Cash agent schema. Idempotent: safe to run more than once.

create table if not exists customers (
  id           bigserial primary key,
  name         text,
  phone        text not null unique,
  created_at   timestamptz not null default now()
);

create table if not exists products (
  id           bigserial primary key,
  sku          text unique,
  name         text not null,
  unit_price   numeric(12,2) not null,
  active       boolean not null default true
);

create table if not exists orders (
  id            bigserial primary key,
  customer_id   bigint references customers(id),
  items         jsonb not null,
  total_amount  numeric(12,2) not null,
  source        text not null,
  status        text not null default 'received',
  scheduled_for date,
  raw_text      text,
  created_at    timestamptz not null default now()
);

create table if not exists invoices (
  id                  bigserial primary key,
  order_id            bigint references orders(id),
  amount              numeric(12,2) not null,
  due_date            timestamptz not null,
  status              text not null default 'issued',
  reminders_sent      int not null default 0,
  checkout_request_id text,
  mpesa_receipt       text,
  paid_at             timestamptz,
  created_at          timestamptz not null default now()
);

create table if not exists messages (
  id           bigserial primary key,
  direction    text not null,
  channel      text not null,
  phone        text,
  body         text,
  provider_id  text,
  order_id     bigint references orders(id),
  invoice_id   bigint references invoices(id),
  created_at   timestamptz not null default now()
);

create index if not exists idx_invoices_status on invoices (status);
create index if not exists idx_messages_created on messages (created_at desc);

-- Starter catalog so USSD/SMS orders can be priced. Edit for your demo.
insert into products (sku, name, unit_price) values
  ('GRL4',   '4 inch window grille',  3500),
  ('GRL6',   '6 inch window grille',  4200),
  ('DR-STD', 'Standard steel door',  12000),
  ('GATE-SL','Sliding gate panel',   25000)
on conflict (sku) do nothing;
