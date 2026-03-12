require('dotenv').config();

module.exports = {
  greenApi: {
    instanceId: process.env.GREEN_API_INSTANCE_ID,
    token: process.env.GREEN_API_TOKEN,
    baseUrl: `https://api.green-api.com/waInstance${process.env.GREEN_API_INSTANCE_ID}`,
  },
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY,
    model: 'claude-sonnet-4-20250514',
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
    botNumber: process.env.WHATSAPP_BOT_NUMBER || '35799114512',
  },
  admin: {
    password: process.env.ADMIN_PASSWORD,
  },
  port: process.env.PORT || 3000,
};
