# AI Components

Two separate AI systems live in this codebase. Different providers, different
jobs, different audiences. Neither calls the other.

## 1. Order-parsing brain (`src/claude.js`)

Turns a customer's messy free-text SMS ("3 doors and 2 gates by friday") into a
structured order: items, quantities, requested delivery date.

- **Model:** DeepSeek V4 Flash, called through OpenRouter's OpenAI-compatible
  endpoint (`OPENROUTER_MODEL`, default `deepseek/deepseek-v4-flash-0731`).
- **Method:** tool use (function calling). The model is given a schema for
  `{ items, requested_delivery, notes }` and returns structured JSON, not free text
  to re-parse.
- **Fails safe:** if `OPENROUTER_API_KEY` is not set, or the call errors, intake
  falls back to `keywordParse()` in the same file, a regex-based splitter on
  "and / plus / , / ; / then". The webhook never blocks or crashes on the LLM
  being unavailable; a customer's order still gets created, just less precisely
  parsed.
- **Where it's used:** `routes/sms.js` on inbound free-text SMS only. USSD orders
  are menu-driven and never touch an LLM.

The file is still named `claude.js` from before the project's LLM brain swap
(commit `a90f584`, "Switch LLM brain from Claude to DeepSeek V4 Flash via
OpenRouter"). It has not been renamed because `routes/sms.js` imports it by that
path; the name describes what it used to call, not what it calls now.

## 2. Owner voice assistant, "Friday" (`voice-agent/`)

A separate Python process (LiveKit Agents SDK) the shop owner talks to directly,
by voice, to check on the business: overdue invoices, unattended orders, order
status, and to trigger a reminder or M-Pesa prompt on demand. It never speaks to
a customer (that is SMS, USSD, and the Africa's Talking Voice escalation
described in the main README), and it never touches Postgres directly, only the
`/api/*` routes on the Node server (see `routes/api.js`).

- **Provider:** Groq, used for all three stages of the voice pipeline (STT,
  LLM, and TTS), kept on one fast provider so voice latency stays low enough
  to feel like a conversation.
- **STT:** Whisper, run with `detect_language=True` (no language pinned), so it
  transcribes English or Swahili as spoken rather than forcing English decoding.
  The owner can code-switch mid-sentence.
- **LLM:** `gpt-oss-120b` at low reasoning effort, fast enough for voice, and
  instructed (`voice-agent/prompts.py`) to always reply out loud in English
  regardless of which language it heard.
- **TTS:** Groq's hosted Orpheus voice. This is the one deliberate gap: Orpheus
  only speaks English and Arabic, no Swahili voice, so a Friday that replies
  *in* Swahili would need a second TTS provider (e.g. ElevenLabs multilingual).
  Not added; out of scope for this build.
- **Tools** (`voice-agent/tools.py`), each an HTTP call to `routes/api.js`:
  `list_overdue_invoices`, `list_unpaid_invoices`, `list_unattended_orders`,
  `list_orders`, `get_order_summary`, `get_order_status`, `get_invoice_status`,
  `mark_order_fulfilled`, `send_payment_reminder`, `send_mpesa_prompt`,
  `send_mpesa_prompt_for_order`, `get_business_summary`.
- **Real side effects:** `send_payment_reminder` sends a real SMS and
  `send_mpesa_prompt` / `send_mpesa_prompt_for_order` put a real M-Pesa STK push
  on a customer's phone, through the same `africastalking.js` / `mpesa.js` paths
  the rest of the app uses. Set `VOICE_AGENT_API_KEY` in both `.env` files once
  `PUBLIC_BASE_URL` is a public tunnel, otherwise those two routes are reachable
  by anyone with the URL.

See `voice-agent/README.md` to run it, and `CLAUDE.md`'s "Owner Voice Assistant"
section for the full tool list and how `stage` is derived per order.
