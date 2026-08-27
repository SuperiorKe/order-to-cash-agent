// override: the shell running this may already export ANTHROPIC_API_KEY or
// DATABASE_URL from another tool, and a stale ambient value silently beating
// .env is very hard to spot. .env is in .dockerignore, so it never reaches the
// deployed container and real platform env vars still win there.
require('dotenv').config({ override: true });

const num = (v, d) => (v === undefined || v === '' ? d : Number(v));

const mpesaEnv = process.env.MPESA_ENV || 'sandbox';
const atEnv = process.env.AT_ENVIRONMENT || 'sandbox';

// Select AT credentials based on environment
const atUsername = atEnv === 'live' ? process.env.AT_LIVE_USERNAME : process.env.AT_USERNAME;
const atSmsShortcode = atEnv === 'live' ? process.env.AT_LIVE_SMS_SHORTCODE : process.env.AT_SMS_SHORTCODE;
const atUssdServiceCode = atEnv === 'live' ? process.env.AT_LIVE_USSD_SERVICE_CODE : process.env.AT_USSD_SERVICE_CODE;

module.exports = {
  port: num(process.env.PORT, 3000),
  publicBaseUrl: process.env.PUBLIC_BASE_URL || 'http://localhost:3000',
  businessName: process.env.BUSINESS_NAME || 'Acme Fabricators',
  currency: process.env.CURRENCY || 'KES',
  databaseUrl: process.env.DATABASE_URL || '',
  atEnvironment: atEnv,
  // Shared secret for the M-Pesa callback URL (the money path). Empty by
  // default, which keeps dry-run and the current behaviour unchanged.
  webhookSecret: process.env.WEBHOOK_SECRET || '',

  at: {
    username: atUsername || '',
    apiKey: process.env.AT_API_KEY || '',
    smsShortcode: atSmsShortcode || '',
    voiceNumber: process.env.AT_VOICE_NUMBER || '',
    ussdServiceCode: atUssdServiceCode || '',
  },

  mpesa: {
    env: mpesaEnv,
    base: mpesaEnv === 'production'
      ? 'https://api.safaricom.co.ke'
      : 'https://sandbox.safaricom.co.ke',
    consumerKey: process.env.MPESA_CONSUMER_KEY || '',
    consumerSecret: process.env.MPESA_CONSUMER_SECRET || '',
    shortcode: process.env.MPESA_SHORTCODE || '174379',
    passkey: process.env.MPESA_PASSKEY || '',
  },

  llm: {
    apiKey: process.env.OPENROUTER_API_KEY || '',
    model: process.env.OPENROUTER_MODEL || 'deepseek/deepseek-v4-flash-0731',
    baseUrl: 'https://openrouter.ai/api/v1',
  },

  cadence: {
    termsDays: num(process.env.DEFAULT_PAYMENT_TERMS_DAYS, 7),
    reminderGapMin: num(process.env.REMINDER_GAP_MINUTES, 2),
    ownerGapMin: num(process.env.OWNER_GAP_MINUTES, 6),
    ownerPhone: process.env.OWNER_PHONE || '',
    tickCron: process.env.AGENT_TICK_CRON || '*/1 * * * *',
  },
};
