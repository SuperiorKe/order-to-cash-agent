# Work log: owner pricing workflow

Autonomous session, 19 Sep 2026. Concise record of what was found, what was
decided, what broke, and how success was verified.

## 1. Discovery

- Node 26 / Express 4 / node-postgres. ~1,700 lines in `src/`, no tests, no
  test framework, no lint. Repo boots in dry-run without any credentials.
- Five tables. Order → exactly one invoice at creation. Collections tick
  (`agent.js`) escalates SMS → SMS → Voice → owner alert, driven by
  `invoices.status` string matches and `reminders_sent`.
- **Gap found:** an order whose item never matches the catalog is priced at
  KES 0. The customer is told "we are confirming the price", the owner gets
  "INV-n needs pricing", the tick skips it (`amount <= 0`), Friday lists it as
  "unattended"… and then nothing. There is no code path anywhere that prices
  it. The only way to finish that order is to edit Postgres by hand. The
  order-to-cash loop is open for every custom item.
- Environment: no running Postgres, Docker daemon inactive, no sudo. Chromium
  and Playwright are installed.

## 2. Decision: build the owner pricing workflow

Chosen because it closes the one broken state in the state machine and touches
every layer (schema, domain, webhook, API, dashboard, voice assistant, docs,
tests). Scope:

1. Core: `pricing.js` prices the unpriced lines of an order, updates the
   invoice, restarts the payment clock, and re-runs the normal "order
   confirmed + M-Pesa prompt" path the customer would have got at intake.
2. Owner SMS command: the owner replies `PRICE <invoice> <amount> [amount…]`
   to the "needs pricing" alert. Phone is the spine of this product, so this
   is the primary interface.
3. JSON API: `POST /api/invoices/:id/price` and `POST /api/orders/:id/price`.
4. Friday tool `price_order` (voice-agent/).
5. Dashboard: "Needs pricing" panel with an inline form.
6. Tests with `node:test` against a real embedded Postgres.

Design decisions:

- **Line totals, not unit prices, in the SMS.** "PRICE 12 45000" is read as
  "that line costs 45,000". For a single-line order (every USSD order) that is
  also the invoice total, which is what an owner means. Multi-line orders take
  one amount per unpriced line, in order. The reply echoes the resulting total
  so a misreading is visible immediately.
- **Only unpriced lines can be priced.** Re-pricing a priced, unpaid invoice
  is refused (409). Correcting a sent invoice means retracting an STK push and
  re-announcing a total; out of scope, noted as follow-up.
- **"Unpriced" means unit_price is 0, not "no sku".** The old condition
  `!sku || !unit_price` would keep a hand-priced custom item (sku null) in the
  needs-pricing list forever. Unmatched items already get unit_price 0, so
  dropping the sku clause changes nothing for existing rows.
- **Due date restarts at pricing time.** Payment terms run from when the
  customer receives a real amount, not from when they placed the order.
- **Dashboard pricing respects VOICE_AGENT_API_KEY.** Pricing sends a customer
  SMS and an STK push, so it is a customer-reaching action. When the key is
  set the dashboard form gets a 401 and shows it, pointing the owner to the
  SMS command or Friday. Exempting it would expose a customer-reaching action
  on a public tunnel.
- **Embedded Postgres as a dev dependency.** Tests and local dev need a real
  database (jsonb_array_elements, `update … from`, `filter (where)`). pg-mem
  does not cover that SQL. `embedded-postgres` downloads a real server and
  runs it as the current user; no Docker or root needed.

## 3. Failures and fixes

- **Docker unavailable.** Daemon inactive, no sudo. Switched to
  `embedded-postgres` (real Postgres 17 binaries, runs as the current user).
  Smoke test passed in ~2s. Added `npm run db:local` so anyone without Docker
  gets the same thing.
- **First test run: 5 of 11 failed.** Three root causes:
  1. *Real defect (pre-existing):* customer SMS printed amounts straight from
     `numeric(12,2)` — "Total KES 45000.00", "Invoice INV-1 of KES 45000.00 is
     due". Added `src/money.js` (`fmtMoney`) and used it in every human-facing
     amount: confirmation SMS, all three reminder ladders, manual reminder,
     USSD replies, pricing replies. Tests now assert "KES 45,000".
  2. *Test bug:* bigint ids come back from node-postgres as strings, so
     `o.invoice_id === invoiceId` never matched. Compared with `Number()`.
  3. *Test race:* waited for "We have your order" from a customer who already
     had one from an earlier test. Now waits for the specific order row.
- **Second run: 2 failed, one a real defect (pre-existing).** A partly matched
  order ("3 custom gates and 2 standard steel door") was invoiced at 24,000,
  the doors alone, while the customer was told "we are confirming the price".
  Because `amount > 0`, the collections tick would have chased them for the
  wrong figure the moment the due date passed. `createOrder` now issues the
  invoice at 0 whenever any line is unpriced; `pricing.js` sets the full
  total once the owner fills the gap. The second failure was a cascade.
- **Third run: 11/11 pass.**

## 4. Verification

- **Automated:** `npm test` → 11/11 pass (two suites, ~3s including Postgres
  boot). Coverage: USSD unknown item → KES 0 + alerts; unattended list, stage,
  dashboard panel, `/api/live`; tick skips unpriced; non-owner `PRICE`
  refused with no order created; owner `PRICE INV-n 45,000` → amount, due
  date, `priced_at`, item lines, customer SMS, dry-run STK, owner reply,
  audit row; unattended list empties, stage `awaiting_payment`, tick sends
  reminder #1; second `PRICE` refused; mixed catalog/custom SMS order held at
  0 then priced via API (line total 10,000 ÷ 3 → 3,333.33; total 34,000);
  `count_mismatch` 400 with named lines and SMS guidance; `bad_amounts` 400;
  404s; paid → 409; `VOICE_AGENT_API_KEY` 401/200; order summary counts.
- **Launched the app** with `npm run db:local` + `npm start`, seeded five
  orders through the real USSD/SMS webhooks (one priced, three needing
  pricing, one seed-demo overdue invoice).
- **Visual, headless Chromium screenshots** (`docs/dashboard-needs-pricing.png`
  is the first): panel renders with one input per unpriced line and priced
  lines shown read-only; invoice amounts at 0 read "needs pricing" instead of
  "KES 0". Found and fixed: dry-run STK log line still said "KES 50000.00"
  (mpesa.js now formats); a favicon 404 in the console (inline empty icon).
- **Interactive, Playwright driving system Chromium:** empty submit → inline
  validation; typed "45,000" survived a 3s poll; pricing INV-2 and INV-3 from
  the form → green confirmation, rows dropped off on the next poll, invoice
  table updated to KES 45,000 / 34,000 with new due dates, message log shows
  "Owner priced …", the customer confirmation, and the STK push. Zero console
  errors after the favicon fix.
- **Live SMS path on the running server:** owner texted `PRICE 4 120,000` →
  invoice 4 at 120,000, `priced_at` set, `checkout_request_id` DRY-4, items
  carry `priced_by: owner`, stage `awaiting_payment`, unattended list empty;
  a second `PRICE 4 5000` was refused with "already priced at KES 120,000".
- **Collections loop still runs:** the seed-demo invoice went reminded →
  reminded (2) → voice_escalated on schedule in the background while the
  above happened, with the newly formatted amounts.

## 5. Left out, deliberately

- Re-pricing an already priced, unpaid invoice (needs an STK retraction and a
  corrected-total message to the customer).
- Owner-side authentication beyond `OWNER_PHONE` for SMS; AT does not sign
  callbacks, same caveat as the existing webhooks.
- Nothing committed: changes are left in the working tree for review.
