# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Quick Commands

```bash
npm start              # Run server on :3000 (dry-run if no credentials)
npm run dev            # Run with --watch for hot reload
npm run migrate        # Create Postgres tables + seed product catalog
npm run seed:demo      # Create one overdue invoice for live demo testing
npm test:sms           # Test SMS parsing by sending a raw SMS to /webhooks/sms/inbound
```

The project boots successfully without any credentials (DATABASE_URL, AT_API_KEY, etc.) and runs in dry-run mode — SMS, Voice, and M-Pesa calls are logged to console instead of sent.

## Architecture Overview

This is an **event-triggered, state-machine agent** for SME manufacturers. The flow is:

1. **Intake (routes/ussd.js, routes/sms.js):** Customer places order via USSD or free-text SMS.
2. **Parse (claude.js):** DeepSeek V4 Flash (via OpenRouter) extracts structured order from messy SMS text (tool use). The file is still named `claude.js` from before the LLM brain swap (see `a90f584`); see `AI_COMPONENTS.md`.
3. **Create invoice (orders.js, invoices.js):** Order → Invoice, send confirmation SMS.
4. **Collections loop (agent.js, cron tick):** Every minute, check due invoices and escalate:
   - SMS reminder #1 (day 0)
   - SMS reminder #2 (day 0 + gap)
   - Voice call escalation (day 0 + 2×gap)
   - Owner alert SMS (day 0 + owner_gap)
5. **Payment (mpesa.js, routes/mpesa.js):** M-Pesa STK push on demand; Safaricom callback reconciles and marks paid.

**Key principle:** No customer facing this software directly except via phone (USSD / SMS / Voice). The spine is Africa's Talking, not a bolt-on.

## Module Ownership

The codebase is split by concern for a one-day hackathon team of 4:

| Module | Owns | Concern |
|--------|------|---------|
| `routes/ussd.js`, `routes/sms.js`, `claude.js`, `orders.js` | Order intake | Menu-driven USSD + free-text SMS parsing |
| `agent.js`, `invoices.js`, `africastalking.js`, `routes/voice.js` | Collections brain | Cron tick, state machine, SMS + Voice escalation |
| `mpesa.js`, `routes/mpesa.js` | Payments | STK push, Daraja OAuth, callback reconciliation |
| `routes/dashboard.js`, `routes/api.js`, `server.js`, `Dockerfile` | Surface + deploy | Owner dashboard, JSON API, liveness, containerization |
| `voice-agent/` (Python, separate process) | Owner voice assistant | LiveKit agent ("Friday"); calls `routes/api.js`, never touches Postgres directly |

## Data Flow

### 1. USSD Order Intake
- POST `/webhooks/ussd` from Africa's Talking: `{ sessionId, phoneNumber, serviceCode, text }`
- `text` is `*` joined inputs. Respond with `CON` (menu) or `END` (finish).
- On order: create order row → create invoice → send SMS confirmation.

### 2. SMS Order Intake
- POST `/webhooks/sms/inbound` from Africa's Talking: `{ from, to, text, id }`
- Send `text` to Claude Haiku via tool use to extract `{ items, requested_delivery, notes }`.
- Match item names to `products` table → create order → create invoice → send SMS.
- **Important:** Claude parse fails gracefully; on error, log and reply to customer "we didn't understand, please try again."

### 3. Collections Tick (cron, `agent.js`)
- Every minute (configurable via `AGENT_TICK_CRON`): scan `invoices where status in ('issued', 'reminded')`.
- Compare `now` vs `due_date + gaps` to decide next action (SMS reminder #1/2, Voice, owner alert).
- All decisions are timestamped on the invoice row (`reminders_sent`, `status`) so re-runs are idempotent.
- **Log every send to `messages` table** so the dashboard shows a live audit trail.

### 4. Voice Escalation
- Agent calls `africastalking.VOICE.call({ callTo, callFrom })`.
- Africa's Talking then requests your `/webhooks/voice` (POST) with `CallSid` and session info.
- Reply with XML dial-plan: `<Response><Say>...</Say></Response>`.
- This is two-phase; the call completes independently and is not awaited.

### 5. M-Pesa Payment Flow
- Invoice issued → send SMS with "Reply PAY" option, or placed by agent on demand.
- **Step 1 (OAuth):** GET Daraja `/oauth/v1/generate` → cache `access_token` (~3599s).
- **Step 2 (STK push):** POST `/mpesa/stkpush/v1/processrequest` with Amount, PartyA (customer phone), CallbackURL.
- **Step 3 (Reconcile):** Safaricom posts to `/webhooks/mpesa/callback`; parse and mark invoice `status='paid'`.

### 6. Dashboard
- GET `/` returns simple HTML: orders table + invoices table + live message log.
- Every SMS/call/payment is logged to `messages` table in real-time so the owner sees the flow during the demo.

### 7. Owner Voice Assistant (`voice-agent/`, Friday)
- A separate Python process (LiveKit Agents SDK), outside the Node server and its module ownership split.
- STT/LLM/TTS all run through Groq (`agent.py`, `groq_tts.py`); the LLM is `gpt-oss-120b` at low reasoning effort, kept fast enough for voice.
- Tools (`tools.py`) call `routes/api.js` over HTTP — `list_overdue_invoices`, `list_unpaid_invoices`, `list_unattended_orders`, `list_orders`, `get_invoice_status`, `get_order_status`, `get_order_summary`, `mark_order_fulfilled`, `send_payment_reminder`, `send_mpesa_prompt`, `send_mpesa_prompt_for_order`, `get_business_summary`. It never queries Postgres directly.
- Talks only to the owner ("Boss"), never to a customer; the customer-facing Voice escalation is `routes/voice.js` (Section 4 above), a different system with a different, firmer tone.
- "Unattended orders" (`orders.needsPricingList()`) means an item never matched the product catalog, priced at KES 0, and needs the owner to price it by hand.
- `orders.status` starts at `'received'` and is otherwise untouched by the rest of the codebase (USSD/SMS intake, the collections tick) — the only path that ever changes it is Friday's `mark_order_fulfilled` tool, flipping it to `'fulfilled'`. That is a separate axis from invoice payment status: an order can be fulfilled and still unpaid, or paid and not yet fulfilled.
- `send_mpesa_prompt_for_order` and `send_mpesa_prompt` do the same STK push, just addressed by order id vs invoice id — order numbers and invoice numbers are different sequences, since one order maps to exactly one invoice created at the same time.
- `send_payment_reminder` sends a real SMS, and `send_mpesa_prompt` puts a real STK push on the customer's phone for the invoice's exact amount, both through the same `africastalking.js` / `mpesa.js` paths the rest of the app uses. Set `VOICE_AGENT_API_KEY` in both `.env` files once `PUBLIC_BASE_URL` is a public tunnel, or the `/api/*` routes are reachable by anyone with the URL.
- Run it with the Node server already up (`npm start`), then `python agent.py` from `voice-agent/` with its own venv and `.env`. See `voice-agent/README.md`.

## External Services & Environment

### Africa's Talking (SMS / USSD / Voice)
- **SDK:** `const at = require('africastalking')({ apiKey, username })`
- **Creds:** `AT_USERNAME` (sandbox / live), `AT_API_KEY`, `AT_SMS_SHORTCODE`, `AT_VOICE_NUMBER`, `AT_USSD_SERVICE_CODE`
- **Retry logic:** Sandbox rejects ~40% of single attempts; `africastalking.js` implements exponential backoff (`AT_SEND_ATTEMPTS`, `AT_SEND_GAP_MS`).
- **USSD callback:** expects POST with form-encoded body; reply with plain text `CON` or `END`.
- **SMS callback:** expects POST with form-encoded body; parse and log immediately (async work is ok).

### M-Pesa Daraja
- **Sandbox base:** `https://sandbox.safaricom.co.ke`
- **Creds:** `MPESA_CONSUMER_KEY`, `MPESA_CONSUMER_SECRET`, `MPESA_SHORTCODE` (test: 174379), `MPESA_PASSKEY`
- **Flow:** OAuth → STK push → callback.
- **Test MSISDN:** use the public sandbox test phone number; the STK will pop on demand.

### DeepSeek V4 Flash (Agent Brain, via OpenRouter)
- **Model:** `deepseek/deepseek-v4-flash-0731` (fast, cheap, sufficient for order parsing).
- **Endpoint:** OpenRouter's OpenAI-compatible `https://openrouter.ai/api/v1/chat/completions`.
- **Tool use:** `parseOrder(rawText)` extracts items, qty, delivery date from SMS via OpenAI-style function calling.
- **Never blocks:** tool output is validated; on error, fall back to simple keyword parse and never crash the webhook.
- **Auth:** Pass `OPENROUTER_API_KEY` as Bearer token in the Authorization header.

### Postgres
- **Connection pool:** `node-postgres` with pooling via `pgconfig.js` (handles IPv6 + session pooler).
- **Schema:** 5 tables: `customers`, `products`, `orders`, `invoices`, `messages`.
- **Migrations:** `scripts/migrate.js` creates tables idempotently and seeds a basic catalog.

## Key Development Patterns

### Error Handling in Webhooks
- Never throw from a webhook; catch and log. Respond with a 2xx status code even on internal error.
- Safaricom and Africa's Talking expect an ack. Delay actual work (SMS, DB updates) until after the response.

### Dry-Run Mode
- If `DATABASE_URL` is not set, all DB operations are disabled and logged instead.
- If `AT_API_KEY` is not set, SMS / Voice are logged to console, not sent.
- If `OPENROUTER_API_KEY` is not set, order parsing defaults to a simple regex fallback.
- This allows building and testing routes before credentials arrive.

### Idempotency
- The collections tick re-runs on every cron minute. Invoice state is stored on the row (`reminders_sent`, `status`), so re-runs do not duplicate work.
- Safaricom callback reconciliation: store `CheckoutRequestID` on invoice so a replay of the same callback is idempotent.

### Logging & Audit
- Every external call (SMS out, Voice call placed, M-Pesa STK push) is logged to the `messages` table with `direction='out'` and `channel` (sms/voice/mpesa).
- Every inbound message (USSD input, SMS, M-Pesa callback) is logged with `direction='in'`.
- This audit trail is the source of truth for the dashboard and the demo script.

### Configuration
- All config is environment variables (no `config.json`). See `.env.example` for the full list.
- `src/config.js` loads and validates env vars at startup; missing ones default safely (empty string, false, or sensible numbers).
- For the demo, set `REMINDER_GAP_MINUTES=1` or `2` so the whole escalation plays in <7 minutes.

## Testing & Demo

- **Manual SMS test:** `npm run test:sms` sends a raw SMS via the webhook (requires `.env` and DB).
- **Live demo seeding:** `npm run seed:demo` creates one customer + one invoice already past due. Next cron tick fires reminder #1 live on stage.
- **Risk mitigation:** See BUILD_PLAN.md Section 9 for risks (inbound SMS not provisioned, callback URL not reachable, Voice latency, STK cancellation) and their mitigations.
- **The core moment:** a real phone must ring or buzz in the room during the voice escalation. That single fact makes the judge believe the whole loop.

## Deployment

- **Container:** Dockerfile copies npm deps and source, exposes :3000, runs `node src/server.js`.
- **Marketplace:** Push to Africa's Talking container registry (CI from GitHub). Declare env vars, database need, and pricing plan.
- **Public URL:** Must be reachable from Africa's Talking and Safaricom for callbacks. Set `PUBLIC_BASE_URL` to your tunnel / instance URL in hour 0.
- **Database:** Optional. Boots without it; all features work in memory (orders/invoices logged to console). For production, provision Postgres and run `npm run migrate`.

## Memory & Important Notes

- Supabase pooler: the direct DB host does not resolve in this environment; use the AWS session pooler (`aws-1-eu-west-1` in the connection string). See [Supabase pooler and IPv6](supabase-pooler-ipv6.md).
- USSD service code: Africa's Talking expects `*384*45324#` (or your custom code), callback goes to `/webhooks/ussd` (not `/webhooks/ussd/`).
- SMS shortcode: sender ID and shortcode are different. Check your AT dashboard for the provisioned shortcode before testing.
