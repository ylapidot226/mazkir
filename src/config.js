require('dotenv').config();

// Validate critical env vars at startup
const required = ['OPENAI_API_KEY', 'SUPABASE_URL', 'SUPABASE_KEY'];
for (const key of required) {
  if (!process.env[key]) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
}

module.exports = {
  twilio: {
    accountSid: process.env.TWILIO_ACCOUNT_SID,
    authToken: process.env.TWILIO_AUTH_TOKEN,
    whatsappNumber: process.env.TWILIO_WHATSAPP_NUMBER || '+13502251169',
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY,
    model: 'gpt-4o-mini',
  },
  supabase: {
    url: process.env.SUPABASE_URL,
    key: process.env.SUPABASE_KEY,
  },
  resend: {
    apiKey: process.env.RESEND_API_KEY,
    fromEmail: process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev',
  },
  whatsapp: {
    botNumber: process.env.WHATSAPP_BOT_NUMBER || process.env.TWILIO_WHATSAPP_NUMBER?.replace('+', '') || '13502251169',
  },
  admin: {
    password: process.env.ADMIN_PASSWORD,
    path: process.env.ADMIN_PATH || '/admin',
  },
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    redirectUri: process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3000/calendar/google/callback',
  },
  monday: {
    clientId: process.env.MONDAY_CLIENT_ID || '',
    clientSecret: process.env.MONDAY_CLIENT_SECRET || '',
    redirectUri: process.env.MONDAY_REDIRECT_URI || 'http://localhost:3000/monday/callback',
  },
  cron: {
    secret: process.env.CRON_SECRET || '',
  },
  encryption: {
    key: process.env.ENCRYPTION_KEY,
  },
  baseUrl: process.env.BASE_URL || 'http://localhost:3000',
  port: process.env.PORT || 3000,
};
