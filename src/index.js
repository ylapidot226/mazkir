const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const config = require('./config');
const logger = require('./utils/logger');
const webhookRoutes = require('./routes/webhook');
const adminRoutes = require('./routes/admin');
const { router: calendarRoutes } = require('./routes/calendar');
const { runAllReminders } = require('./services/reminders');

const app = express();

// Trust proxy (Vercel runs behind a reverse proxy)
app.set('trust proxy', 1);

// Security headers (#8)
app.use(helmet({
  contentSecurityPolicy: false, // Allow inline scripts for landing page
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: false, // Allow WhatsApp/social crawlers to fetch og:image
}));

// CORS - restrict to own domain (#4)
app.use(cors({
  origin: process.env.NODE_ENV === 'production'
    ? ['https://maztary.com', 'https://www.maztary.com', 'https://accounts.google.com']
    : true,
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
}));

app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));

// Serve static files (landing page + admin)
app.use(express.static(path.join(__dirname, '..', 'public')));

// Admin panel at non-obvious path (#12)
app.get(config.admin.path, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'admin.html'));
});

// Routes
app.use('/webhook', webhookRoutes);
app.use('/api/admin', adminRoutes);
app.use('/calendar', calendarRoutes);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Cron endpoint - secured with secret (#3)
app.get('/api/cron/reminders', async (req, res) => {
  // Allow Vercel cron (sends authorization header) or check secret
  const authHeader = req.headers['authorization'];
  const querySecret = req.query.secret;
  const cronSecret = config.cron.secret;

  if (cronSecret && authHeader !== `Bearer ${cronSecret}` && querySecret !== cronSecret) {
    logger.warn('cron', 'Unauthorized cron attempt', { ip: req.ip });
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    await runAllReminders();
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
    startReminderCron();
  });
}

module.exports = app;
