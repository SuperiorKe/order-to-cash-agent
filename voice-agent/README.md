# Friday — Order-to-Cash voice assistant

Friday is the owner's voice interface into the Order-to-Cash Agent (`../src`).
Ask it who is overdue, what an invoice or order looks like, or tell it to send
a reminder, and it calls the same JSON API the dashboard polls
(`../src/routes/api.js`) instead of touching Postgres on its own.

It does not talk to customers. Collections SMS, USSD, and the Voice
escalation call are handled elsewhere in this repo (`../src/agent.js`,
`../src/routes/voice.js`). Friday is the owner-facing layer on top of that.

## Setup

1. Create and activate a virtual environment, then `pip install -r requirements.txt`.
2. Copy `.env.example` to `.env` and fill in your LiveKit and Groq credentials.
   Accept the Orpheus TTS terms once at
   https://console.groq.com/playground?model=canopylabs%2Forpheus-v1-english
   or the agent stays silent.
3. Start the Node server first (`npm start` from the repo root), then point
   `ORDER_TO_CASH_API_URL` at it — the default `http://localhost:3000` is
   right for local development.
4. If the Node server sets `VOICE_AGENT_API_KEY`, set the same value here so
   Friday's requests are accepted.
5. On Windows, run with `PYTHONIOENCODING=utf-8` or the console crashes on an
   emoji in the logs.

## What it can do

- List overdue invoices, or every unpaid invoice regardless of due date
- List orders still waiting on pricing (an item didn't match the catalog)
- Look up one invoice or order by number
- Send an out-of-cycle SMS payment reminder
- Put a real M-Pesa payment prompt (STK push) on a customer's phone for one invoice
- Give a spoken summary of open, overdue, and outstanding amounts

Everything it says comes from a live call to the Node API; if that API is
unreachable, Friday says so rather than guessing a number. Two of these
(the SMS reminder and the STK push) reach a real customer, so treat them
like you would any other "send" button, only fire them when you mean to.

## Voice stack

STT, LLM, and TTS all run through Groq (`agent.py`), OpenAI-shaped endpoints
pointed at Groq's base URL. `groq_tts.py` patches around the one field Groq's
`/audio/speech` endpoint rejects that the stock OpenAI plugin always sends.
