const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const db = require('../services/database');
const googleCalendar = require('../services/googleCalendar');
const appleCalendar = require('../services/appleCalendar');
const logger = require('../utils/logger');

// In-memory store for connect tokens (userId -> token, 15 min expiry)
const connectTokens = new Map();

/**
 * Generate a one-time connect token for a user
 * Called from webhook when user says "חבר לוח שנה"
 */
function generateConnectToken(userId) {
  const token = crypto.randomBytes(8).toString('hex');
  connectTokens.set(token, {
    userId,
    createdAt: Date.now(),
  });

  // Cleanup expired tokens
  for (const [k, v] of connectTokens) {
    if (Date.now() - v.createdAt > 15 * 60 * 1000) {
      connectTokens.delete(k);
    }
  }

  return token;
}

/**
 * GET /calendar/connect?token=xxx&provider=google|apple
 * Serve the connect calendar page (validates token)
 */
router.get('/connect', (req, res) => {
  const { token, provider } = req.query;

  if (!token || !connectTokens.has(token)) {
    return res.status(400).send(`
      <html dir="rtl"><body style="font-family:sans-serif;text-align:center;padding:50px;">
        <h2>הקישור לא תקין או שפג תוקפו</h2>
        <p>שלח שוב "חבר לוח שנה" בוואטסאפ כדי לקבל קישור חדש</p>
      </body></html>
    `);
  }

  res.redirect(`/connect-calendar.html?token=${token}&provider=${provider || ''}`);
});

/**
 * GET /calendar/google/auth?token=xxx
 * Start Google OAuth flow
 */
router.get('/google/auth', (req, res) => {
  const { token } = req.query;

  if (!token || !connectTokens.has(token)) {
    return res.status(400).json({ error: 'Invalid or expired token' });
  }

  const tokenData = connectTokens.get(token);
  const state = JSON.stringify({ connectToken: token, userId: tokenData.userId });
  const authUrl = googleCalendar.getAuthUrl(state);

  res.redirect(authUrl);
});

/**
 * GET /calendar/google/callback
 * Handle Google OAuth callback
 */
router.get('/google/callback', async (req, res) => {
  const { code, state, error: oauthError } = req.query;

  if (oauthError) {
    logger.warn('calendar', 'OAuth denied', { error: oauthError });
    return res.send(`
      <html dir="rtl"><body style="font-family:sans-serif;text-align:center;padding:50px;">
        <h2>החיבור בוטל</h2>
        <p>אפשר לנסות שוב על ידי שליחת "חבר לוח שנה" בוואטסאפ</p>
      </body></html>
    `);
  }

  if (!code || !state) {
    return res.status(400).json({ error: 'Missing code or state' });
  }

  try {
    const { connectToken, userId } = JSON.parse(state);

    if (!connectTokens.has(connectToken)) {
      return res.status(400).send(`
        <html dir="rtl"><body style="font-family:sans-serif;text-align:center;padding:50px;">
          <h2>הקישור פג תוקף</h2>
          <p>שלח שוב "חבר לוח שנה" בוואטסאפ</p>
        </body></html>
      `);
    }

    const tokens = await googleCalendar.getTokensFromCode(code);
    await db.saveCalendarConnection(userId, 'google', JSON.stringify(tokens), 'primary');
    connectTokens.delete(connectToken);

    logger.info('calendar', 'Google Calendar connected', { userId });

    res.send(`
      <html dir="rtl"><body style="font-family:sans-serif;text-align:center;padding:50px;background:#080808;color:#F1F1F1;">
        <div style="max-width:400px;margin:0 auto;">
          <div style="font-size:64px;margin-bottom:20px;">🎉</div>
          <h2 style="color:#A78BFA;">Google Calendar מחובר!</h2>
          <p style="color:#8B8B8B;margin-top:15px;">
            מעכשיו כל האירועים שתוסיף דרך וואטסאפ יופיעו גם ב-Google Calendar, וכל מה שתוסיף ב-Google Calendar יופיע גם אצל מזכיר.
          </p>
          <p style="color:#8B8B8B;margin-top:15px;">אפשר לסגור את הדף ולחזור לוואטסאפ 💬</p>
        </div>
      </body></html>
    `);
  } catch (error) {
    logger.error('calendar', 'Google OAuth callback failed', { error: error.message });
    res.status(500).send(`
      <html dir="rtl"><body style="font-family:sans-serif;text-align:center;padding:50px;">
        <h2>שגיאה בחיבור</h2>
        <p>נסה שוב מאוחר יותר</p>
      </body></html>
    `);
  }
});

/**
 * POST /calendar/apple/connect
 * Connect Apple Calendar via CalDAV credentials
 */
router.post('/apple/connect', async (req, res) => {
  const { token, appleId, appPassword } = req.body;

  if (!token || !connectTokens.has(token)) {
    return res.status(400).json({ error: 'הקישור פג תוקף. שלח שוב "חבר לוח שנה" בוואטסאפ.' });
  }

  if (!appleId || !appPassword) {
    return res.status(400).json({ error: 'נא למלא Apple ID וסיסמה ייעודית.' });
  }

  const { userId } = connectTokens.get(token);

  try {
    // Verify credentials work
    const result = await appleCalendar.verifyCredentials(appleId, appPassword);

    if (!result.success || result.calendars.length === 0) {
      return res.status(400).json({ error: 'לא הצלחתי להתחבר. בדוק שה-Apple ID והסיסמה הייעודית נכונים.' });
    }

    // Save connection with first calendar URL
    const credentials = JSON.stringify({ appleId, appPassword });
    const calendarUrl = result.calendars[0].url;

    await db.saveCalendarConnection(userId, 'apple', credentials, calendarUrl);
    connectTokens.delete(token);

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
 * Check calendar connection status
 */
router.get('/status', async (req, res) => {
  const { token } = req.query;

  if (!token || !connectTokens.has(token)) {
    return res.status(400).json({ error: 'Invalid token' });
  }

  const { userId } = connectTokens.get(token);

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
 * Disconnect a calendar
 */
router.post('/disconnect', async (req, res) => {
  const { token, provider } = req.body;

  if (!token || !connectTokens.has(token)) {
    return res.status(400).json({ error: 'Invalid token' });
  }

  const { userId } = connectTokens.get(token);

  try {
    await db.deleteCalendarConnection(userId, provider);
    logger.info('calendar', 'Calendar disconnected', { userId, provider });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to disconnect' });
  }
});

module.exports = { router, generateConnectToken };
