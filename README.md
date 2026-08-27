# Order-to-Cash Agent

An event-triggered agent for SME and Jua Kali manufacturers. It takes an order,
confirms and schedules it, collects payment by M-Pesa, and chases late payment
with an escalating SMS then a Voice call. Built for the Africa's Talking
Manufacturing Hackathon, Nairobi, 27 Aug 2026.

See `BUILD_PLAN.md` for the full design, the call sequences, and the demo script.

## Quickstart

```bash
npm install
cp .env.example .env        # fill in what you have; it boots without any of it
npm start                   # server on :3000, dashboard at http://localhost:3000
```

Everything runs in dry-run mode with no credentials: SMS, Voice and M-Pesa are
logged to the console instead of sent, so you can build and test the flow before
keys arrive.

## With a database

```bash
# set DATABASE_URL in .env, then:
npm run migrate             # create tables + seed the product catalog
npm run seed:demo           # optional: one overdue invoice for the live demo
npm start
```

## Endpoints

| Method | Path | Caller |
|---|---|---|
| GET  | `/health` | Marketplace / you |
| GET  | `/` | Owner dashboard |
| POST | `/webhooks/ussd` | Africa's Talking (USSD) |
| POST | `/webhooks/sms/inbound` | Africa's Talking (inbound SMS) |
| POST | `/webhooks/voice` | Africa's Talking (Voice) |
| POST | `/webhooks/mpesa/callback` | Safaricom (STK result) |

Point the Africa's Talking and Daraja callbacks at `PUBLIC_BASE_URL` + the path.
In development, expose your machine with a tunnel and set `PUBLIC_BASE_URL` to it.

## Who owns what (one-day split)

- **A — Intake:** `routes/ussd.js`, `routes/sms.js`, `claude.js`, `orders.js`
- **B — Collections:** `agent.js`, `invoices.js`, `africastalking.js`, `routes/voice.js`
- **C — Payments:** `mpesa.js`, `routes/mpesa.js`
- **D — Surface + ship:** `routes/dashboard.js`, `Dockerfile`, Marketplace metadata
