-- Demo seed: one customer with an already-overdue invoice, so the agent tick
-- sends reminder #1 live on stage and then rolls into the Voice escalation.
-- Change the phone number to a handset you control in the room.

with c as (
  insert into customers (name, phone) values ('Demo Buyer', '+254700000000')
  on conflict (phone) do update set name = excluded.name
  returning id
), o as (
  insert into orders (customer_id, items, total_amount, source, raw_text)
  select id,
         '[{"sku":"GRL4","name":"4 inch window grille","qty":10,"unit_price":3500}]'::jsonb,
         35000, 'manual', 'demo seed'
  from c
  returning id
)
insert into invoices (order_id, amount, due_date, status, reminders_sent)
select id, 35000, now() - interval '1 minute', 'issued', 0 from o;
