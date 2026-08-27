# Build Plan — Order-to-Cash Agent (#8)

Africa's Talking Manufacturing Hackathon, Nairobi, 27 Aug 2026.
Target: a Marketplace-ready container that takes an order, confirms and schedules it, collects payment by M-Pesa, and chases late payment with an escalating SMS then a Voice call.

---

## 0. Decisions already made (do not re-litigate on the clock)

| Choice | Decision | Why |
|---|---|---|
| Runtime | Node.js 20 + Express | AT ships a first-class `africastalking` npm SDK. One language for the whole team. |
| Database | Postgres via `DATABASE_URL` | Marketplace asks you to "declare database needs". Portable, isolated per instance. |
| LLM (the agent brain) | Claude Haiku 4.5 (`claude-haiku-4-5-20251001`) | Fast and cheap for parsing messy orders. Direct Anthropic SDK, self-contained in the container. |
| Tenancy | Single manufacturer per container | Marketplace deploys "isolated instances". The whole container IS one customer. No tenant table. |
| Order intake for the live demo | USSD (primary), inbound SMS (secondary) | USSD is reliable in the AT sandbox. Inbound SMS shortcodes can be slow to provision. |
| Payments | M-Pesa Daraja STK Push (sandbox) | Named in the brief. STK to a test MSISDN demos cleanly. |
| Deploy target | Docker image to AT container registry | This is the win condition, not Vercel. |

---

## 1. Architecture

```
                         ┌──────────────────────────────────────────┐
   Customer phone        │            order-to-cash-agent            │
   (USSD / SMS)  ───────▶│  POST /webhooks/ussd                      │
                         │  POST /webhooks/sms/inbound  ──▶ Claude    │  parse messy order → JSON
                         │                                            │
   Agent tick (cron) ───▶│  scan invoices → drive state machine      │
                         │     ├─ SMS reminder      (AT SMS)          │──────▶ Customer phone
                         │     └─ Voice escalation  (AT Voice)        │──────▶ Customer phone
                         │                                            │
   Safaricom      ──────▶│  POST /webhooks/mpesa/callback (reconcile) │
   M-Pesa                │  POST /webhooks/voice (XML for the call)   │
                         │                                            │
   Owner browser  ──────▶│  GET /  (orders + invoices dashboard)      │
                         │  GET /health                               │
                         └──────────────────────────────────────────┘
                                   │
                                   ▼  Postgres (DATABASE_URL)
```

Every external party is on a basic phone, outside the software. That is why Africa's Talking is the spine and not a bolt-on.

---

## 2. Data model (Postgres)

```sql
create table customers (
  id           bigserial primary key,
  name         text,
  phone        text not null unique,          -- E.164, e.g. +2547XXXXXXXX
  created_at   timestamptz not null default now()
);

create table products (                        -- optional catalog for USSD
  id           bigserial primary key,
  sku          text unique,
  name         text not null,
  unit_price   numeric(12,2) not null,
  active       boolean not null default true
);

create table orders (
  id            bigserial primary key,
  customer_id   bigint references customers(id),
  items         jsonb not null,                -- [{sku, name, qty, unit_price}]
  total_amount  numeric(12,2) not null,
  source        text not null,                 -- 'ussd' | 'sms' | 'manual'
  status        text not null default 'received',
                                               -- received → confirmed → in_production → ready → delivered
  scheduled_for date,
  raw_text      text,                          -- original SMS, for audit
  created_at    timestamptz not null default now()
);

create table invoices (
  id                  bigserial primary key,
  order_id            bigint references orders(id),
  amount              numeric(12,2) not null,
  due_date            timestamptz not null,
  status              text not null default 'issued',
                      -- issued → reminded → voice_escalated → paid → owner_escalated
  reminders_sent      int not null default 0,
  checkout_request_id text,                    -- links to the STK push
  mpesa_receipt       text,
  paid_at             timestamptz,
  created_at          timestamptz not null default now()
);

create table messages (                        -- full comms audit, powers the demo dashboard
  id           bigserial primary key,
  direction    text not null,                  -- 'in' | 'out'
  channel      text not null,                  -- 'sms' | 'voice' | 'ussd' | 'mpesa'
  phone        text,
  body         text,
  provider_id  text,
  order_id     bigint references orders(id),
  invoice_id   bigint references invoices(id),
  created_at   timestamptz not null default now()
);
```

---

## 3. HTTP surface

| Method | Path | Caller | Job |
|---|---|---|---|
| POST | `/webhooks/ussd` | Africa's Talking | USSD order-taking session |
| POST | `/webhooks/sms/inbound` | Africa's Talking | Inbound SMS order or reply → Claude parse |
| POST | `/webhooks/voice` | Africa's Talking | Return XML the outbound call speaks |
| POST | `/webhooks/mpesa/callback` | Safaricom | Reconcile STK result → mark invoice paid |
| GET | `/` | Owner | Minimal dashboard: orders + invoices + message log |
| GET | `/health` | Marketplace | Liveness check, returns 200 |

All webhook URLs are built from `PUBLIC_BASE_URL`.

---

## 4. The agent loop (state machine)

A cron tick (`node-cron`, every 1 minute) runs the collections brain:

```
for each invoice where status in ('issued','reminded'):
    if now >= due_date and reminders_sent == 0:
        send SMS reminder #1 → reminders_sent = 1, status = 'reminded'
    elif now >= due_date + REMINDER_GAP and reminders_sent == 1:
        send SMS reminder #2 → reminders_sent = 2
    elif now >= due_date + (2 * REMINDER_GAP) and reminders_sent >= 2:
        place Voice escalation call → status = 'voice_escalated'
    if status == 'voice_escalated' and now >= due_date + OWNER_GAP:
        SMS the owner: "INV-x still unpaid" → status = 'owner_escalated'

on M-Pesa callback success (any state):
    status = 'paid', record receipt, stop all follow-up
```

`REMINDER_GAP` and the others are env-configurable. For the demo, set them to minutes and seed an invoice already past due (Section 8).

This is the honest agentic loop: observe (due date), decide (which step), act (SMS/Voice), wait, escalate, and adapt when payment lands.

---

## 5. External call sequences

### 5a. USSD order intake  (POST /webhooks/ussd)

AT posts `sessionId, phoneNumber, serviceCode, text`. `text` is the user's inputs joined by `*`. Reply `text/plain` starting with `CON` (continue) or `END` (finish).

```js
app.post('/webhooks/ussd', (req, res) => {
  const { text = '', phoneNumber } = req.body;
  const steps = text.split('*');
  res.set('Content-Type', 'text/plain');

  if (text === '') return res.send('CON Welcome to <Business>.\n1. Place order\n2. Check my orders');
  if (steps[0] === '1' && steps.length === 1) return res.send('CON Enter product code:');
  if (steps[0] === '1' && steps.length === 2) return res.send('CON Enter quantity:');
  if (steps[0] === '1' && steps.length === 3) {
    // createOrder(phoneNumber, steps[1], steps[2]) → issue invoice → confirm by SMS
    return res.send('END Order received. We will SMS your confirmation and payment request.');
  }
  return res.send('END Invalid choice.');
});
```

### 5b. Inbound SMS intake + Claude parse  (POST /webhooks/sms/inbound)

AT posts `from, to, text, id`. Send the free text to Claude and get structured JSON back. This is where "interpret messy information" is real.

```js
const Anthropic = require('@anthropic-ai/sdk');
const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function parseOrder(rawText) {
  const msg = await claude.messages.create({
    model: process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001',
    max_tokens: 400,
    tools: [{
      name: 'record_order',
      description: 'Extract a manufacturing order from a customer message.',
      input_schema: {
        type: 'object',
        properties: {
          items: { type: 'array', items: { type: 'object', properties: {
            name: { type: 'string' }, qty: { type: 'integer' } }, required: ['name','qty'] } },
          requested_delivery: { type: 'string', description: 'ISO date or empty' },
          notes: { type: 'string' }
        },
        required: ['items']
      }
    }],
    tool_choice: { type: 'tool', name: 'record_order' },
    messages: [{ role: 'user', content: `Customer SMS: "${rawText}"` }]
  });
  const call = msg.content.find(c => c.type === 'tool_use');
  return call.input;   // { items:[{name,qty}], requested_delivery, notes }
}
```
Match names to `products`, compute total, create the order, issue the invoice, then send the confirmation SMS (5c pattern).

### 5c. Outbound SMS (confirmation + reminders)

```js
const AfricasTalking = require('africastalking')({
  apiKey: process.env.AT_API_KEY, username: process.env.AT_USERNAME
});

await AfricasTalking.SMS.send({
  to: [customer.phone],
  from: process.env.AT_SMS_SHORTCODE,          // sender id / shortcode
  message: `Hello ${name}, order INV-${id} confirmed. Amount KES ${amount}, due ${date}. Reply PAY to get an M-Pesa prompt.`
});
```
Log every send into `messages` so the dashboard shows the trail live.

### 5d. Voice escalation

Two parts. First place the call. AT then requests your voice callback for what to speak.

```js
// place the call from the agent tick
await AfricasTalking.VOICE.call({
  callFrom: process.env.AT_VOICE_NUMBER,
  callTo: [customer.phone]
});
```
```js
// POST /webhooks/voice  → return dial-plan XML
app.post('/webhooks/voice', (req, res) => {
  res.set('Content-Type', 'application/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="woman">Hello. This is an automated reminder from <Business>.
  Invoice number is overdue. Please pay by M-Pesa today. Thank you.</Say>
</Response>`);
});
```

### 5e. M-Pesa Daraja: STK push + reconciliation

**Step 1 — OAuth token** (cache it, it lasts ~3599s):
```
GET {MPESA_BASE}/oauth/v1/generate?grant_type=client_credentials
Authorization: Basic base64(CONSUMER_KEY:CONSUMER_SECRET)
→ { access_token, expires_in }
```

**Step 2 — STK push** (fired when invoice is issued, or on "PAY" reply):
```
POST {MPESA_BASE}/mpesa/stkpush/v1/processrequest
Authorization: Bearer <access_token>
{
  "BusinessShortCode": <MPESA_SHORTCODE>,
  "Password": base64(SHORTCODE + PASSKEY + Timestamp),   // Timestamp = YYYYMMDDHHmmss
  "Timestamp": "20260827120000",
  "TransactionType": "CustomerPayBillOnline",
  "Amount": <invoice.amount>,
  "PartyA": <customer msisdn 2547...>,
  "PartyB": <MPESA_SHORTCODE>,
  "PhoneNumber": <customer msisdn 2547...>,
  "CallBackURL": "{PUBLIC_BASE_URL}/webhooks/mpesa/callback",
  "AccountReference": "INV-<id>",
  "TransactionDesc": "Invoice INV-<id>"
}
→ { CheckoutRequestID, ResponseCode }   // store CheckoutRequestID on the invoice
```

**Step 3 — reconcile the callback**:
```js
app.post('/webhooks/mpesa/callback', async (req, res) => {
  const cb = req.body.Body.stkCallback;
  res.json({ ResultCode: 0, ResultDesc: 'ok' });          // ack Safaricom immediately
  if (cb.ResultCode !== 0) return;                         // user cancelled / failed
  const meta = Object.fromEntries(cb.CallbackMetadata.Item.map(i => [i.Name, i.Value]));
  // find invoice by CheckoutRequestID → set status='paid', mpesa_receipt=meta.MpesaReceiptNumber, paid_at=now
  // send a thank-you SMS
});
```
Sandbox base: `https://sandbox.safaricom.co.ke`. Sandbox shortcode `174379` with the public test passkey. STK goes to the Safaricom test MSISDN.

---

## 6. Environment variables (Marketplace config)

Everything the plugin needs is an env var, so a stranger can Deploy and configure without touching code.

```bash
# --- Africa's Talking ---
AT_USERNAME=              # 'sandbox' for the demo, real username in prod
AT_API_KEY=
AT_SMS_SHORTCODE=         # sender id / shortcode
AT_VOICE_NUMBER=          # AT voice-enabled number
AT_USSD_SERVICE_CODE=     # e.g. *384*XXXX#

# --- M-Pesa Daraja ---
MPESA_ENV=sandbox         # sandbox | production
MPESA_CONSUMER_KEY=
MPESA_CONSUMER_SECRET=
MPESA_SHORTCODE=174379
MPESA_PASSKEY=

# --- Claude (agent brain) ---
ANTHROPIC_API_KEY=
ANTHROPIC_MODEL=claude-haiku-4-5-20251001

# --- Core ---
DATABASE_URL=postgres://...
PUBLIC_BASE_URL=https://<your-instance-host>    # used to build every callback URL
BUSINESS_NAME=Acme Fabricators
CURRENCY=KES

# --- Collections cadence (minutes for the demo, hours/days in prod) ---
DEFAULT_PAYMENT_TERMS_DAYS=7
REMINDER_GAP_MINUTES=2
OWNER_GAP_MINUTES=6
OWNER_PHONE=+2547XXXXXXXX
AGENT_TICK_CRON=*/1 * * * *
```

---

## 7. Packaging for the Marketplace (the win condition)

**Dockerfile**
```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
EXPOSE 3000
CMD ["node", "src/server.js"]
```

**Marketplace metadata checklist** (from the brief, all mandatory to win):
- [ ] Name + slug + one-line + long description
- [ ] Logo uploaded
- [ ] Docker image pushed to the AT container registry (CI from GitHub is fine)
- [ ] Env vars declared, database need declared
- [ ] At least one pricing plan
- [ ] Category tagged (use **Other** or **Fintech**), AT product tagged
- [ ] Terms of Service + Privacy Policy accepted
- [ ] Passes their test: a stranger finds it, picks a plan, clicks Deploy, gets a live instance

**Suggested pricing plan:** `Starter — KES 1,500 / month — up to 200 invoices, SMS + Voice + M-Pesa collections`.

---

## 8. One-day timeline and team split (assume 4 people)

**Hour 0 to 1 — everyone together (no forking yet)**
- Repo, `npm init`, Express skeleton, `/health`, Postgres schema loaded, `.env` filled with sandbox creds.
- Get a public HTTPS URL early (the AT container deploy, or ngrok for dev). Nothing works until callbacks are reachable. Set `PUBLIC_BASE_URL`.

**Hour 1 to 5 — parallel**
- **A — Intake:** USSD flow (5a) + inbound SMS + Claude parse (5b). Owns the `orders` table.
- **B — Collections brain:** the cron tick + state machine (Section 4) + outbound SMS (5c) + Voice (5d). Owns `invoices`.
- **C — Payments:** Daraja OAuth, STK push, callback reconcile (5e). Owns the money path end to end.
- **D — Surface + ship:** the `/` dashboard reading `messages`, the Dockerfile, Marketplace metadata, and the demo script.

**Hour 5 to 6 — integrate.** Wire intake → invoice → tick → SMS → Voice → STK → callback → paid. One happy path, working.

**Hour 6 to close — rehearse the 7-minute demo twice.** Seed data, freeze the build.

---

## 9. Demo seeding and risk mitigations

**Seed before you present** so the escalation fires on cue:
- One customer with a phone you control in the room.
- One invoice with `due_date` a few minutes in the past and `reminders_sent = 0`. The next tick sends reminder #1 live on stage, then rolls to Voice.
- Keep `REMINDER_GAP_MINUTES` low (1 to 2) so the whole loop plays inside the demo window.

**Risks and the mitigation for each:**
| Risk | Mitigation |
|---|---|
| Inbound SMS shortcode not provisioned in time | Lead the demo with USSD (reliable in sandbox). Keep inbound SMS as the "and it also reads free-text orders" beat. |
| Callback URL not reachable | Set `PUBLIC_BASE_URL` in hour 0 and curl every webhook before building features. |
| M-Pesa STK cancelled or slow on stage | Pre-record a successful STK as backup, but try live first with the test MSISDN. |
| Voice call latency | Place the call one beat before you narrate it, so it rings on time. |
| Claude parse returns junk | Validate the tool output against the schema; on failure, fall back to a simple keyword parse. Never crash the webhook. |

**The one thing to protect:** a real phone must ring or buzz in the room. That single moment is what makes a judge believe the whole loop without an architecture lecture.
```
