const express = require('express');
const cors = require('cors');
const path = require('path');
const config = require('./config');
const logger = require('./utils/logger');
const webhookRoutes = require('./routes/webhook');
const adminRoutes = require('./routes/admin');
const { checkEventReminders, checkCustomReminders } = require('./services/reminders');

const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files (landing page + admin)
app.use(express.static(path.join(__dirname, '..', 'public')));

// Routes
app.use('/webhook', webhookRoutes);
app.use('/api/admin', adminRoutes);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Cron endpoint for Vercel Cron Jobs
app.get('/api/cron/reminders', async (req, res) => {
  try {
    await checkEventReminders();
    await checkCustomReminders();
    res.json({ success: true, timestamp: new Date().toISOString() });
  } catch (error) {
    logger.error('cron', 'Cron job failed', error);
    res.status(500).json({ error: 'Cron failed' });
  }
});

// Start server (only when not running on Vercel)
if (process.env.VERCEL !== '1') {
  const { startReminderCron } = require('./services/reminders');
  app.listen(config.port, () => {
    logger.info('server', `Mazkir server running on port ${config.port}`);
    logger.info('server', `Landing page: http://localhost:${config.port}`);
    logger.info('server', `Admin panel: http://localhost:${config.port}/admin.html`);
    logger.info('server', `Webhook URL: http://localhost:${config.port}/webhook/whatsapp`);
    startReminderCron();
  });
}

module.exports = app;
