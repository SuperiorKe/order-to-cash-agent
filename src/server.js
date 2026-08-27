const express = require('express');
const cfg = require('./config');
const db = require('./db');
const { startAgent } = require('./agent');

const app = express();
app.use(express.json());                          // Safaricom posts JSON
app.use(express.urlencoded({ extended: false })); // Africa's Talking posts form-encoded

app.get('/health', async (req, res) => {
  res.json({
    status: 'ok',
    db: await db.healthy(),
    business: cfg.businessName,
    time: new Date().toISOString(),
  });
});

app.use('/ussd', require('./routes/ussd'));
app.use('/webhooks/sms', require('./routes/sms'));
app.use('/webhooks/voice', require('./routes/voice'));
app.use('/webhooks/mpesa', require('./routes/mpesa'));
app.use('/', require('./routes/api'));       // JSON surface for voice-agent/ (Friday)
app.use('/', require('./routes/dashboard'));

app.listen(cfg.port, () => {
  console.log(`[server] ${cfg.businessName} order-to-cash agent listening on :${cfg.port}`);
  console.log(`[server] public base: ${cfg.publicBaseUrl}`);
  startAgent();
});
