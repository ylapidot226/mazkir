require('dotenv').config();

// Validate critical env vars at startup
const required = ['OPENAI_API_KEY', 'SUPABASE_URL', 'SUPABASE_KEY', 'GREEN_API_INSTANCE_ID', 'GREEN_API_TOKEN'];
for (const key of required) {
  if (!process.env[key]) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
}

module.exports = {
  greenApi: {
    instanceId: process.env.GREEN_API_INSTANCE_ID,
    token: process.env.GREEN_API_TOKEN,
    baseUrl: `https://api.green-api.com/waInstance${process.env.GREEN_API_INSTANCE_ID}`,
    webhookToken: process.env.WEBHOOK_TOKEN || '',
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
    botNumber: process.env.WHATSAPP_BOT_NUMBER,
  },
  admin: {
    password: process.env.ADMIN_PASSWORD,
    path: process.env.ADMIN_PATH || '/admin',
  },
  cron: {
    secret: process.env.CRON_SECRET || '',
  },
  port: process.env.PORT || 3000,
};
