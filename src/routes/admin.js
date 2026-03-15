const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const db = require('../services/database');
const greenApi = require('../services/greenApi');
const { sendWelcomeEmail } = require('../services/email');
const config = require('../config');
const logger = require('../utils/logger');

// Rate limiting for admin login (#5, #7)
const adminLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 30, // 30 attempts per window
  message: { error: 'יותר מדי ניסיונות. נסה שוב בעוד 15 דקות.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Rate limiting for registration (#5)
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5, // 5 registrations per IP per hour
  message: { error: 'יותר מדי הרשמות. נסה שוב מאוחר יותר.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Auth middleware - header only, no query param (#2)
function requireAuth(req, res, next) {
  const password = req.headers['x-admin-password'];
  if (!password || password !== config.admin.password) {
    logger.warn('admin', 'Failed auth attempt', { ip: req.ip });
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// Audit log helper (#11)
function auditLog(action, req, details = {}) {
  logger.info('admin_audit', action, {
    ip: req.ip,
    timestamp: new Date().toISOString(),
    ...details,
  });
}

// Get stats
router.get('/stats', adminLimiter, requireAuth, async (req, res) => {
  try {
    const stats = await db.getStats();
    res.json(stats);
  } catch (error) {
    logger.error('admin', 'Failed to get stats', { message: error.message });
    res.status(500).json({ error: 'Internal error' });
  }
});

// Get all users
router.get('/users', adminLimiter, requireAuth, async (req, res) => {
  try {
    const users = await db.getAllUsers();
    res.json(users);
  } catch (error) {
    logger.error('admin', 'Failed to get users', { message: error.message });
    res.status(500).json({ error: 'Internal error' });
  }
});

// Get pending users
router.get('/users/pending', adminLimiter, requireAuth, async (req, res) => {
  try {
    const users = await db.getPendingUsers();
    res.json(users);
  } catch (error) {
    logger.error('admin', 'Failed to get pending users', { message: error.message });
    res.status(500).json({ error: 'Internal error' });
  }
});

// Approve user
router.post('/users/:id/approve', adminLimiter, requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    await db.activateUser(id);

    const users = await db.getAllUsers();
    const user = users.find((u) => u.id === id);
    if (user && user.email) {
      try {
        await sendWelcomeEmail(user.email, user.name || '');
      } catch (emailError) {
        logger.error('admin', 'Failed to send welcome email', { message: emailError.message });
      }
    }

    auditLog('User approved', req, { userId: id });
    res.json({ success: true });
  } catch (error) {
    logger.error('admin', 'Failed to approve user', { message: error.message });
    res.status(500).json({ error: 'Internal error' });
  }
});

// Block user
router.post('/users/:id/block', adminLimiter, requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    await db.blockUser(id);
    auditLog('User blocked', req, { userId: id });
    res.json({ success: true });
  } catch (error) {
    logger.error('admin', 'Failed to block user', { message: error.message });
    res.status(500).json({ error: 'Internal error' });
  }
});

// Unblock user
router.post('/users/:id/unblock', adminLimiter, requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    await db.activateUser(id);
    auditLog('User unblocked', req, { userId: id });
    res.json({ success: true });
  } catch (error) {
    logger.error('admin', 'Failed to unblock user', { message: error.message });
    res.status(500).json({ error: 'Internal error' });
  }
});

// Update user phone number
router.put('/users/:id/phone', adminLimiter, requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { phone } = req.body;

    if (!phone) {
      return res.status(400).json({ error: 'מספר טלפון הוא שדה חובה' });
    }

    // Validate and normalize phone number
    let normalizedPhone = phone.replace(/[\s\-()+]/g, '');
    if (normalizedPhone.startsWith('0')) {
      normalizedPhone = '972' + normalizedPhone.substring(1);
    } else if (normalizedPhone.startsWith('972972')) {
      // Fix double country code
      normalizedPhone = normalizedPhone.substring(3);
    }
    if (!/^\d{8,15}$/.test(normalizedPhone)) {
      return res.status(400).json({ error: 'מספר טלפון לא תקין' });
    }
    if (!normalizedPhone.includes('@')) {
      normalizedPhone = normalizedPhone + '@c.us';
    }

    // Check if phone already taken by another user
    const existing = await db.getUser(normalizedPhone);
    if (existing && existing.id !== id) {
      return res.status(409).json({ error: 'מספר טלפון זה כבר בשימוש' });
    }

    await db.updateUserPhone(id, normalizedPhone);
    auditLog('User phone updated', req, { userId: id, newPhone: normalizedPhone });
    res.json({ success: true });
  } catch (error) {
    logger.error('admin', 'Failed to update user phone', { message: error.message });
    res.status(500).json({ error: 'Internal error' });
  }
});

// Delete user
router.delete('/users/:id', adminLimiter, requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    await db.deleteUser(id);
    auditLog('User deleted', req, { userId: id });
    res.json({ success: true });
  } catch (error) {
    logger.error('admin', 'Failed to delete user', { message: error.message });
    res.status(500).json({ error: 'Internal error' });
  }
});

// Register from landing page - with rate limiting and phone validation (#7)
router.post('/register', registerLimiter, async (req, res) => {
  try {
    const { name, phone, email } = req.body;

    if (!phone || !name || !email) {
      return res.status(400).json({ error: 'שם, טלפון ומייל הם שדות חובה' });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: 'כתובת מייל לא תקינה' });
    }

    // Validate and normalize phone number (#7)
    let normalizedPhone = phone.replace(/[\s\-()+]/g, '');
    if (normalizedPhone.startsWith('0')) {
      normalizedPhone = '972' + normalizedPhone.substring(1);
    } else if (normalizedPhone.startsWith('972972')) {
      // Fix double country code
      normalizedPhone = normalizedPhone.substring(3);
    }
    // Must be only digits and reasonable length
    if (!/^\d{8,15}$/.test(normalizedPhone)) {
      return res.status(400).json({ error: 'מספר טלפון לא תקין' });
    }
    if (!normalizedPhone.includes('@')) {
      normalizedPhone = normalizedPhone + '@c.us';
    }

    // Sanitize name - strip HTML
    const sanitizedName = name.replace(/<[^>]*>/g, '').trim().substring(0, 100);

    // Check if user already exists
    const existing = await db.getUser(normalizedPhone);
    if (existing) {
      return res.json({ success: true, message: 'כבר נרשמת! בדוק את המייל שלך לקישור לוואטסאפ.' });
    }

    await db.createUser(normalizedPhone, sanitizedName, email);
    auditLog('New registration', req, { phone: normalizedPhone });

    // Notify admin via WhatsApp
    const ADMIN_PHONE = process.env.ADMIN_PHONE || '35795167764@c.us';
    greenApi.sendMessage(ADMIN_PHONE, `🆕 נרשם משתמש חדש!\n\n👤 ${sanitizedName}\n📱 ${normalizedPhone.replace('@c.us', '')}\n📧 ${email}\n\nממתין לאישור בפאנל הניהול.`).catch(() => {});

    res.json({ success: true, message: 'נרשמת בהצלחה! נכנסת לרשימת ההמתנה ונעדכן אותך במייל כשהחשבון יאושר 🙌' });
  } catch (error) {
    logger.error('admin', 'Failed to register', { message: error.message });
    res.status(500).json({ error: 'שגיאה בהרשמה, נסה שוב' });
  }
});

module.exports = router;
