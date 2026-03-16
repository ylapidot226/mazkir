const crypto = require('crypto');
const db = require('../services/database');

/**
 * Generate a one-time connect token for a user
 * Stored in Supabase so it works across serverless invocations
 */
async function generateConnectToken(userId) {
  const token = crypto.randomBytes(4).toString('hex');
  await db.saveConnectToken(token, userId);
  return token;
}

/**
 * Validate a connect token and return userId, or null if invalid/expired
 */
async function validateToken(token) {
  if (!token) return null;
  const data = await db.getConnectToken(token);
  if (!data) return null;
  if (Date.now() - new Date(data.created_at).getTime() > 15 * 60 * 1000) {
    await db.deleteConnectToken(token);
    return null;
  }
  return data.user_id;
}

const EXPIRED_HTML = `
  <html dir="rtl"><head><link href="https://fonts.googleapis.com/css2?family=Heebo:wght@400;600;700&display=swap" rel="stylesheet"></head>
  <body style="font-family:'Heebo',sans-serif;text-align:center;padding:50px;background:#ECE5DD;color:#111b21;">
    <div style="max-width:400px;margin:0 auto;background:rgba(255,255,255,0.85);border-radius:16px;padding:40px;border:1px solid rgba(0,0,0,0.08);">
      <img src="/logo.png" alt="מזכיר" style="width:48px;height:48px;border-radius:12px;margin-bottom:16px;">
      <h2 style="margin:0 0 12px;">הקישור לא תקין או שפג תוקפו</h2>
      <p style="color:#667781;">שלח שוב את הבקשה בוואטסאפ כדי לקבל קישור חדש</p>
    </div>
  </body></html>
`;

module.exports = { generateConnectToken, validateToken, EXPIRED_HTML };
