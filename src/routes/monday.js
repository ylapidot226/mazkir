const express = require('express');
const router = express.Router();
const db = require('../services/database');
const monday = require('../services/monday');
const logger = require('../utils/logger');

// Reuse the same token system from calendar.js
const { generateConnectToken, validateToken, EXPIRED_HTML } = require('./calendarHelpers');

/**
 * GET /monday/auth?token=xxx - Start Monday.com OAuth
 */
router.get('/auth', async (req, res) => {
  const { token } = req.query;
  const userId = await validateToken(token);
  if (!userId) return res.status(400).send(EXPIRED_HTML);

  const state = JSON.stringify({ connectToken: token, userId });
  const authUrl = monday.getAuthUrl(state);
  res.redirect(authUrl);
});

/**
 * GET /monday/callback - Monday.com OAuth callback
 */
router.get('/callback', async (req, res) => {
  const { code, state, error: oauthError } = req.query;

  if (oauthError) {
    logger.warn('monday', 'OAuth denied', { error: oauthError });
    return res.send(`
      <html dir="rtl"><head><link href="https://fonts.googleapis.com/css2?family=Heebo:wght@400;600;700&display=swap" rel="stylesheet"></head>
      <body style="font-family:'Heebo',sans-serif;text-align:center;padding:50px;background:#ECE5DD;color:#111b21;">
        <div style="max-width:400px;margin:0 auto;background:rgba(255,255,255,0.85);border-radius:16px;padding:40px;border:1px solid rgba(0,0,0,0.08);">
          <img src="/logo.png" alt="מזכיר" style="width:48px;height:48px;border-radius:12px;margin-bottom:16px;">
          <h2 style="margin:0 0 12px;">החיבור בוטל</h2>
          <p style="color:#667781;">אפשר לנסות שוב על ידי שליחת "חבר מאנדיי" בוואטסאפ</p>
        </div>
      </body></html>
    `);
  }

  if (!code || !state) {
    return res.status(400).json({ error: 'Missing code or state' });
  }

  try {
    const { connectToken } = JSON.parse(state);
    const userId = await validateToken(connectToken);
    if (!userId) return res.status(400).send(EXPIRED_HTML);

    const accessToken = await monday.getTokenFromCode(code);

    // Verify the token works
    const me = await monday.getMe(accessToken);
    logger.info('monday', 'User authenticated', { userId, mondayUser: me.name });

    // Save connection (token never expires for Monday.com)
    await db.saveCalendarConnection(userId, 'monday', JSON.stringify({ access_token: accessToken }), me.id.toString());
    await db.deleteConnectToken(connectToken);

    logger.info('monday', 'Monday.com connected', { userId });

    res.send(`
      <html dir="rtl"><head><link href="https://fonts.googleapis.com/css2?family=Heebo:wght@400;600;700&display=swap" rel="stylesheet"></head>
      <body style="font-family:'Heebo',sans-serif;text-align:center;padding:50px;background:#ECE5DD;color:#111b21;">
        <div style="max-width:400px;margin:0 auto;background:rgba(255,255,255,0.85);border-radius:16px;padding:40px;border:1px solid rgba(0,0,0,0.08);">
          <img src="/logo.png" alt="מזכיר" style="width:48px;height:48px;border-radius:12px;margin-bottom:16px;">
          <div style="font-size:48px;margin-bottom:16px;">🎉</div>
          <h2 style="color:#6161FF;margin:0 0 12px;">Monday.com מחובר!</h2>
          <p style="color:#667781;margin-top:15px;">
            מעכשיו אפשר לנהל את הבורדים שלך ב-Monday.com ישירות דרך וואטסאפ!
            <br><br>
            נסה לכתוב: "תראה בורדים"
          </p>
          <p style="color:#667781;margin-top:15px;">אפשר לסגור את הדף ולחזור לוואטסאפ 💬</p>
        </div>
      </body></html>
    `);
  } catch (error) {
    logger.error('monday', 'OAuth callback failed', { error: error.message });
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

module.exports = router;
