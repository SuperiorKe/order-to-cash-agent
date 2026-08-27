// Credential check. Sends one SMS through Africa's Talking and reports exactly
// what came back. Newly generated AT keys take up to 5 minutes to activate, so
// this retries once a minute rather than failing on the first 401.
//
//   npm run test:sms                 -> sends to the default test number
//   npm run test:sms +2547XXXXXXXX   -> sends to a number you name

require('dotenv').config({ override: true });
const cfg = require('../src/config');

const to = process.argv[2] || '+254711222333';
const attempts = Number(process.env.TEST_SMS_ATTEMPTS || 10);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

if (!cfg.at.apiKey || !cfg.at.username) {
  console.error('AT_USERNAME or AT_API_KEY is not set in .env');
  process.exit(1);
}

const AT = require('africastalking')({ apiKey: cfg.at.apiKey, username: cfg.at.username });

(async () => {
  console.log(`sending to ${to} as "${cfg.at.username}"${cfg.at.smsShortcode ? ' from ' + cfg.at.smsShortcode : ''}`);
  for (let i = 1; i <= attempts; i++) {
    const stamp = new Date().toTimeString().slice(0, 8);
    try {
      const res = await AT.SMS.send({
        to: [to],
        from: cfg.at.smsShortcode || undefined,
        message: `Test from the ${cfg.businessName} order-to-cash agent. If you can read this, the send path works.`,
      });
      console.log(`[${stamp}] attempt ${i}: SUCCESS`);
      console.log(JSON.stringify(res, null, 2));
      return process.exit(0);
    } catch (e) {
      console.log(`[${stamp}] attempt ${i}: ${e.message}`);
    }
    if (i < attempts) await wait(60000);
  }
  console.log(`no success after ${attempts} attempts. The key is being rejected, not just propagating.`);
  process.exit(1);
})();
