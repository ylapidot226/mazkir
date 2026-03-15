const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const db = require('../services/database');
const googleCalendar = require('../services/googleCalendar');
const appleCalendar = require('../services/appleCalendar');
const logger = require('../utils/logger');

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
      <p style="color:#667781;">שלח שוב "חבר לוח שנה" בוואטסאפ כדי לקבל קישור חדש</p>
    </div>
  </body></html>
`;

/**
 * GET /calendar/connect?token=xxx&provider=google|apple
 */
router.get('/connect', async (req, res) => {
  const { token, provider } = req.query;
  const userId = await validateToken(token);
  if (!userId) return res.status(400).send(EXPIRED_HTML);
  res.redirect(`/connect-calendar.html?token=${token}&provider=${provider || ''}`);
});

/**
 * GET /calendar/google/auth?token=xxx
 */
router.get('/google/auth', async (req, res) => {
  const { token } = req.query;
  const userId = await validateToken(token);
  if (!userId) return res.status(400).send(EXPIRED_HTML);

  const state = JSON.stringify({ connectToken: token, userId });
  const authUrl = googleCalendar.getAuthUrl(state);
  res.redirect(authUrl);
});

/**
 * GET /calendar/google/callback
 */
router.get('/google/callback', async (req, res) => {
  const { code, state, error: oauthError } = req.query;

  if (oauthError) {
    logger.warn('calendar', 'OAuth denied', { error: oauthError });
    return res.send(`
      <html dir="rtl"><head><link href="https://fonts.googleapis.com/css2?family=Heebo:wght@400;600;700&display=swap" rel="stylesheet"></head>
      <body style="font-family:'Heebo',sans-serif;text-align:center;padding:50px;background:#ECE5DD;color:#111b21;">
        <div style="max-width:400px;margin:0 auto;background:rgba(255,255,255,0.85);border-radius:16px;padding:40px;border:1px solid rgba(0,0,0,0.08);">
          <img src="/logo.png" alt="מזכיר" style="width:48px;height:48px;border-radius:12px;margin-bottom:16px;">
          <h2 style="margin:0 0 12px;">החיבור בוטל</h2>
          <p style="color:#667781;">אפשר לנסות שוב על ידי שליחת "חבר לוח שנה" בוואטסאפ</p>
        </div>
      </body></html>
    `);
  }

  if (!code || !state) {
    return res.status(400).json({ error: 'Missing code or state' });
  }

  try {
    const { connectToken, userId } = JSON.parse(state);
    const validUserId = await validateToken(connectToken);
    if (!validUserId) return res.status(400).send(EXPIRED_HTML);

    const tokens = await googleCalendar.getTokensFromCode(code);
    await db.saveCalendarConnection(userId, 'google', JSON.stringify(tokens), 'primary');
    await db.deleteConnectToken(connectToken);

    logger.info('calendar', 'Google Calendar connected', { userId });

    res.send(`
      <html dir="rtl"><head><link href="https://fonts.googleapis.com/css2?family=Heebo:wght@400;600;700&display=swap" rel="stylesheet"></head>
      <body style="font-family:'Heebo',sans-serif;text-align:center;padding:50px;background:#ECE5DD;color:#111b21;">
        <div style="max-width:400px;margin:0 auto;background:rgba(255,255,255,0.85);border-radius:16px;padding:40px;border:1px solid rgba(0,0,0,0.08);">
          <img src="/logo.png" alt="מזכיר" style="width:48px;height:48px;border-radius:12px;margin-bottom:16px;">
          <div style="font-size:48px;margin-bottom:16px;">🎉</div>
          <h2 style="color:#25D366;margin:0 0 12px;">Google Calendar מחובר!</h2>
          <p style="color:#667781;margin-top:15px;">
            מעכשיו כל האירועים שתוסיף דרך וואטסאפ יופיעו גם ב-Google Calendar, וכל מה שתוסיף ב-Google Calendar יופיע גם אצל מזכיר.
          </p>
          <p style="color:#667781;margin-top:15px;">אפשר לסגור את הדף ולחזור לוואטסאפ 💬</p>
        </div>
      </body></html>
    `);
  } catch (error) {
    logger.error('calendar', 'Google OAuth callback failed', { error: error.message });
    res.status(500).send(`
      <html dir="rtl"><head><link href="https://fonts.googleapis.com/css2?family=Heebo:wght@400;600;700&display=swap" rel="stylesheet"></head>
      <body style="font-family:'Heebo',sans-serif;text-align:center;padding:50px;background:#ECE5DD;color:#111b21;">
        <div style="max-width:400px;margin:0 auto;background:rgba(255,255,255,0.85);border-radius:16px;padding:40px;border:1px solid rgba(0,0,0,0.08);">
          <img src="/logo.png" alt="מזכיר" style="width:48px;height:48px;border-radius:12px;margin-bottom:16px;">
          <h2 style="margin:0 0 12px;">שגיאה בחיבור</h2>
          <p style="color:#667781;">נסה שוב מאוחר יותר</p>
        </div>
      </body></html>
    `);
  }
});

/**
 * POST /calendar/apple/connect
 */
router.post('/apple/connect', async (req, res) => {
  const { token, appleId, appPassword } = req.body;
  const userId = await validateToken(token);
  if (!userId) {
    return res.status(400).json({ error: 'הקישור פג תוקף. שלח שוב "חבר לוח שנה" בוואטסאפ.' });
  }

  if (!appleId || !appPassword) {
    return res.status(400).json({ error: 'נא למלא Apple ID וסיסמה ייעודית.' });
  }

  try {
    const result = await appleCalendar.verifyCredentials(appleId, appPassword);

    if (!result.success || result.calendars.length === 0) {
      return res.status(400).json({ error: 'לא הצלחתי להתחבר. בדוק שה-Apple ID והסיסמה הייעודית נכונים.' });
    }

    const credentials = JSON.stringify({ appleId, appPassword });
    const calendarUrl = result.calendars[0].url;

    await db.saveCalendarConnection(userId, 'apple', credentials, calendarUrl);
    await db.deleteConnectToken(token);

    logger.info('calendar', 'Apple Calendar connected', { userId, calendars: result.calendars.length });

    res.json({
      success: true,
      calendars: result.calendars.map((c) => c.displayName),
    });
  } catch (error) {
    logger.error('calendar', 'Apple Calendar connect failed', { error: error.message });
    res.status(500).json({ error: 'שגיאה בחיבור. נסה שוב.' });
  }
});

/**
 * GET /calendar/status?token=xxx
 */
router.get('/status', async (req, res) => {
  const { token } = req.query;
  const userId = await validateToken(token);
  if (!userId) return res.status(400).json({ error: 'Invalid token' });

  try {
    const connections = await db.getUserCalendarConnections(userId);
    res.json({
      google: connections.some((c) => c.provider === 'google'),
      apple: connections.some((c) => c.provider === 'apple'),
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get status' });
  }
});

/**
 * POST /calendar/disconnect
 */
router.post('/disconnect', async (req, res) => {
  const { token, provider } = req.body;
  const userId = await validateToken(token);
  if (!userId) return res.status(400).json({ error: 'Invalid token' });

  try {
    await db.deleteCalendarConnection(userId, provider);
    logger.info('calendar', 'Calendar disconnected', { userId, provider });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to disconnect' });
  }
});

module.exports = { router, generateConnectToken };
