const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const config = require('./config');
const logger = require('./utils/logger');
const webhookRoutes = require('./routes/webhook');
const adminRoutes = require('./routes/admin');
const { runAllReminders } = require('./services/reminders');

const app = express();

app.set('trust proxy', 1);

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: false,
}));

app.use(cors({
  origin: process.env.NODE_ENV === 'production'
    ? ['https://maztary.com', 'https://www.maztary.com']
    : true,
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
}));

app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));

app.use(express.static(path.join(__dirname, '..', 'public')));

app.get(config.admin.path, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'admin.html'));
});

app.use('/webhook', webhookRoutes);
app.use('/api/admin', adminRoutes);

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/api/cron/reminders', async (req, res) => {
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

app.get('/api/cron/bug-report', async (req, res) => {
  const authHeader = req.headers['authorization'];
  const querySecret = req.query.secret;
  const cronSecret = config.cron.secret;

  if (cronSecret && authHeader !== `Bearer ${cronSecret}` && querySecret !== cronSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const { runBugReport } = require('./services/bugMonitor');
    await runBugReport();
    res.json({ success: true, timestamp: new Date().toISOString() });
  } catch (error) {
    logger.error('cron', 'Bug report failed', error);
    res.status(500).json({ error: 'Bug report failed' });
  }
});

if (process.env.VERCEL !== '1') {
  const { startReminderCron } = require('./services/reminders');
  app.listen(config.port, () => {
    logger.info('server', `Mazkir server running on port ${config.port}`);
    startReminderCron();
  });
}

module.exports = app;
