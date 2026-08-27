# Marketplace listing copy

Everything below is ready to paste into the Africa's Talking Marketplace submission
form. Section 7 of `BUILD_PLAN.md` is the checklist this satisfies.

---

## 1. Name

**Order to Cash**

Slug: `order-to-cash`

The name says the job in the words the category already uses, so it reads correctly
next to Order Management and Manufacturing Finance in the listing grid. Two alternates
if the team prefers something shorter: **Paid** (memorable, weak in search) and
**Invoice Chaser** (plain, but it hides the order intake half of the product).

---

## 2. One-line description

> Takes orders by USSD and SMS, then chases every invoice to paid by SMS, Voice and M-Pesa.

89 characters. If the form caps you lower, use:

> Takes the order, then chases the invoice to paid by SMS, Voice and M-Pesa.

---

## 3. Long description

### What it does

Order to Cash is an agent that runs the whole distance between a customer placing an
order and the money landing in your M-Pesa. It takes the order over USSD or SMS,
confirms it and puts it on the schedule, issues the invoice, watches the due date, and
when payment is late it chases on its own. First an SMS. Then a second SMS. Then an
automated Voice call. When the money arrives it reconciles the receipt and stops
chasing, without anyone telling it to.

Over 60% of Kenyan SME invoices are paid more than 30 days late. The chasing is real
work, and it is work that owners do at night after production stops. This agent does
it during the day, every day, and it never forgets an invoice.

### The loop

1. **Order in.** A customer dials your USSD code or sends a text. Free-text orders
   like "need 10 window grilles 4 inch by friday" are read by Claude and turned into
   structured line items priced against your catalog.
2. **Confirm and schedule.** The buyer gets an SMS with the order number, the total,
   and the due date. The order lands in your dashboard.
3. **Collect.** An M-Pesa STK push goes to the buyer's phone straight away. They can
   also reply PAY at any time to get the prompt again.
4. **Watch.** The agent tracks the due date on every unpaid invoice.
5. **Chase.** Overdue triggers reminder one. The gap you set passes, reminder two.
   Still nothing, and it places a Voice call that speaks the reminder aloud.
6. **Escalate.** If it is still unpaid after the call, the agent SMSes you, the owner,
   so a human can decide what happens next.
7. **Reconcile.** Safaricom confirms the payment, the invoice flips to paid, the buyer
   gets a thank-you SMS with the receipt number, and all follow-up stops.

Every message in and out is logged, so the dashboard shows you the full trail on one
screen: who ordered, what was sent, what was said on the call, what was paid.

### Who it is for

Fabrication workshops, furniture makers, food processors, printers, and any Jua Kali
or SME manufacturer who takes repeat orders from customers and waits to be paid. Your
customers do not need a smartphone, an app, or an account. They need a phone that can
dial and receive a text, which is the phone they already have.

### What you need before you deploy

- An Africa's Talking account with SMS, USSD and Voice enabled.
- An M-Pesa Daraja account, either the sandbox for testing or your own paybill or
  till for production.
- An Anthropic API key if you want free-text SMS orders parsed by Claude. Without one
  the agent falls back to a keyword parser and USSD ordering still works fully.
- A Postgres database. Declare it at deploy time and the agent creates its own tables
  on first run.

Every setting is an environment variable. Nothing requires touching code.

### What it does not do

It does not manage your production floor, your machines, or your stock. It does not
replace your accountant. It handles the order and the money around it, and it hands
you the audit trail for everything else.

---

## 4. Pricing plans

Africa's Talking and Safaricom bill the SMS, Voice and M-Pesa traffic on your own
account. These plans cover the agent itself, not the messages it sends.

| Plan | Price | Included |
|---|---|---|
| **Starter** | KES 1,500 / month | Up to 200 invoices per month. USSD and SMS ordering, SMS reminders, Voice escalation, M-Pesa collection, owner dashboard. |
| **Workshop** | KES 4,500 / month | Up to 1,000 invoices per month. Everything in Starter, plus a configurable reminder cadence and owner escalation alerts. |
| **Factory** | KES 12,000 / month | Unlimited invoices. Everything in Workshop, plus a custom Voice script, custom SMS sender ID, and priority support. |

If the form only accepts one plan for the hackathon submission, publish **Starter** on
its own. It is the plan a stranger will pick to try the product, and it is the one the
judges will click.

---

## 5. Supporting metadata

**Category.** Primary: Manufacturing Finance. Secondary: Order Management. If neither
is available in the picker, use Fintech, then Other.

**Africa's Talking products used.** SMS (outbound reminders and confirmations, inbound
orders), USSD (primary order intake), Voice (payment escalation calls).

**Database need.** One Postgres 14 or newer database. Around 50MB covers the first
year at 200 invoices per month. The agent runs its own migration on deploy.

**Logo direction.** A single dark square, and inside it a plain circular arrow closing
back on itself with a small filled dot where it closes. The loop is the product, and
the dot is the payment landing. No gradient, one colour, readable at 64px.

**Environment variables to declare.**

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | Yes | Postgres connection string |
| `PUBLIC_BASE_URL` | Yes | Instance host, used to build every callback URL |
| `AT_USERNAME` | Yes | `sandbox` for testing |
| `AT_API_KEY` | Yes | |
| `AT_SMS_SHORTCODE` | No | Sender ID, falls back to the account default |
| `AT_VOICE_NUMBER` | No | Needed for Voice escalation |
| `AT_USSD_SERVICE_CODE` | No | Your assigned code, for reference |
| `AT_SEND_ATTEMPTS` | No | Retries per SMS or call, defaults to 5 |
| `AT_SEND_GAP_MS` | No | Gap between retries, defaults to 3000 |
| `MPESA_ENV` | Yes | `sandbox` or `production` |
| `MPESA_CONSUMER_KEY` | Yes | |
| `MPESA_CONSUMER_SECRET` | Yes | |
| `MPESA_SHORTCODE` | Yes | Defaults to the sandbox shortcode 174379 |
| `MPESA_PASSKEY` | Yes | |
| `ANTHROPIC_API_KEY` | No | Without it, free-text SMS orders use a keyword parser |
| `ANTHROPIC_MODEL` | No | Defaults to `claude-haiku-4-5-20251001` |
| `BUSINESS_NAME` | No | Appears in every message to your customers |
| `CURRENCY` | No | Defaults to KES |
| `DEFAULT_PAYMENT_TERMS_DAYS` | No | Defaults to 7 |
| `REMINDER_GAP_MINUTES` | No | Gap between escalation steps, defaults to 2 |
| `OWNER_GAP_MINUTES` | No | When the owner gets alerted, defaults to 6 |
| `OWNER_PHONE` | No | Where owner escalations are sent |
| `AGENT_TICK_CRON` | No | Defaults to every minute |

For production, raise `REMINDER_GAP_MINUTES` and `OWNER_GAP_MINUTES` into hours or
days. The low defaults exist so the whole loop plays inside a demo window.
