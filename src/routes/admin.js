const express = require('express');
const router = express.Router();
const db = require('../services/database');
const greenApi = require('../services/greenApi');
const { sendWelcomeEmail } = require('../services/email');
const config = require('../config');
const logger = require('../utils/logger');

// Simple auth middleware
function requireAuth(req, res, next) {
  const password = req.headers['x-admin-password'] || req.query.password;
  if (password !== config.admin.password) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// Get stats
router.get('/stats', requireAuth, async (req, res) => {
  try {
    const stats = await db.getStats();
    res.json(stats);
  } catch (error) {
    logger.error('admin', 'Failed to get stats', error);
    res.status(500).json({ error: 'Internal error' });
  }
});

// Get all users
router.get('/users', requireAuth, async (req, res) => {
  try {
    const users = await db.getAllUsers();
    res.json(users);
  } catch (error) {
    logger.error('admin', 'Failed to get users', error);
    res.status(500).json({ error: 'Internal error' });
  }
});

// Get pending users
router.get('/users/pending', requireAuth, async (req, res) => {
  try {
    const users = await db.getPendingUsers();
    res.json(users);
  } catch (error) {
    logger.error('admin', 'Failed to get pending users', error);
    res.status(500).json({ error: 'Internal error' });
  }
});

// Approve user
router.post('/users/:id/approve', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    await db.activateUser(id);

    // Get user to send welcome email with WhatsApp link
    const users = await db.getAllUsers();
    const user = users.find((u) => u.id === id);
    if (user && user.email) {
      try {
        await sendWelcomeEmail(user.email, user.name || '');
        logger.info('admin', 'Welcome email sent on approval', { email: user.email });
      } catch (emailError) {
        logger.error('admin', 'Failed to send welcome email', emailError);
      }
    }

    logger.info('admin', 'User approved', { userId: id });
    res.json({ success: true });
  } catch (error) {
    logger.error('admin', 'Failed to approve user', error);
    res.status(500).json({ error: 'Internal error' });
  }
});

// Block user
router.post('/users/:id/block', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    await db.blockUser(id);
    logger.info('admin', 'User blocked', { userId: id });
    res.json({ success: true });
  } catch (error) {
    logger.error('admin', 'Failed to block user', error);
    res.status(500).json({ error: 'Internal error' });
  }
});

// Unblock user (set back to active)
router.post('/users/:id/unblock', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    await db.activateUser(id);
    logger.info('admin', 'User unblocked', { userId: id });
    res.json({ success: true });
  } catch (error) {
    logger.error('admin', 'Failed to unblock user', error);
    res.status(500).json({ error: 'Internal error' });
  }
});

// Delete user
router.delete('/users/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    await db.deleteUser(id);
    logger.info('admin', 'User deleted', { userId: id });
    res.json({ success: true });
  } catch (error) {
    logger.error('admin', 'Failed to delete user', error);
    res.status(500).json({ error: 'Internal error' });
  }
});

// Register from landing page
router.post('/register', async (req, res) => {
  try {
    const { name, phone, email } = req.body;

    if (!phone || !name || !email) {
      return res.status(400).json({ error: 'שם, טלפון ומייל הם שדות חובה' });
    }

    // Normalize phone number - add Israel country code if needed
    let normalizedPhone = phone.replace(/[\s\-()]/g, '');
    if (normalizedPhone.startsWith('0')) {
      normalizedPhone = '972' + normalizedPhone.substring(1);
    }
    if (!normalizedPhone.includes('@')) {
      normalizedPhone = normalizedPhone + '@c.us';
    }

    // Check if user already exists
    const existing = await db.getUser(normalizedPhone);
    if (existing) {
      return res.json({ success: true, message: 'כבר נרשמת! בדוק את המייל שלך לקישור לוואטסאפ.' });
    }

    await db.createUser(normalizedPhone, name, email);
    logger.info('admin', 'New registration from landing page', { name, phone: normalizedPhone, email });

    res.json({ success: true, message: 'נרשמת בהצלחה! נכנסת לרשימת ההמתנה ונעדכן אותך במייל כשהחשבון יאושר 🙌' });
  } catch (error) {
    logger.error('admin', 'Failed to register', error);
    res.status(500).json({ error: 'שגיאה בהרשמה, נסה שוב' });
  }
});

module.exports = router;
