// Owner: Collections (B). The autonomous loop.
// observe (due date) -> decide (which step) -> act (SMS / Voice) -> escalate.

const cron = require('node-cron');
const cfg = require('./config');
const invoices = require('./invoices');
const at = require('./africastalking');
const db = require('./db');

const MIN = 60 * 1000;

async function tick() {
  if (!(await db.healthy())) return; // no DB yet, skip quietly

  const now = Date.now();
  const gap = cfg.cadence.reminderGapMin * MIN;
  const ownerGap = cfg.cadence.ownerGapMin * MIN;

  let rows;
  try {
    rows = await invoices.dueForFollowUp();
  } catch (e) {
    console.error('[agent] query failed', e.message);
    return;
  }

  for (const inv of rows) {
    if (Number(inv.amount) <= 0) continue; // waiting on the owner to price it
    const due = new Date(inv.due_date).getTime();
    if (now < due) continue;
    const overdueBy = now - due;

    try {
      if (inv.status !== 'voice_escalated' && inv.reminders_sent === 0) {
        await at.sendSMS({
          to: inv.phone, invoiceId: inv.id,
          message: `Hello${inv.name ? ' ' + inv.name : ''}. Invoice INV-${inv.id} of ${cfg.currency} ${inv.amount} is due. Reply PAY for an M-Pesa prompt. — ${cfg.businessName}`,
        });
        await invoices.markReminded(inv.id, 1, 'reminded');
      } else if (inv.status === 'reminded' && inv.reminders_sent === 1 && overdueBy >= gap) {
        await at.sendSMS({
          to: inv.phone, invoiceId: inv.id,
          message: `Reminder 2: INV-${inv.id} (${cfg.currency} ${inv.amount}) is still unpaid. Please settle today. — ${cfg.businessName}`,
        });
        await invoices.markReminded(inv.id, 2, 'reminded');
      } else if (inv.status === 'reminded' && inv.reminders_sent >= 2 && overdueBy >= 2 * gap) {
        await at.placeCall({ to: inv.phone, invoiceId: inv.id });
        await invoices.markVoiceEscalated(inv.id);
      } else if (inv.status === 'voice_escalated' && overdueBy >= ownerGap && cfg.cadence.ownerPhone) {
        await at.sendSMS({
          to: cfg.cadence.ownerPhone, invoiceId: inv.id,
          message: `INV-${inv.id} (${cfg.currency} ${inv.amount}) from ${inv.name || inv.phone} is still unpaid after escalation.`,
        });
        await invoices.markOwnerEscalated(inv.id);
      }
    } catch (e) {
      console.error(`[agent] step failed for INV-${inv.id}`, e.message);
    }
  }
}

function startAgent() {
  console.log(`[agent] collections tick scheduled: ${cfg.cadence.tickCron}`);
  cron.schedule(cfg.cadence.tickCron, () => {
    tick().catch((e) => console.error('[agent] tick error', e.message));
  });
}

module.exports = { startAgent, tick };
