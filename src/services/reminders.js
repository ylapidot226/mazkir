const cron = require('node-cron');
const db = require('./database');
const greenApi = require('./greenApi');
const logger = require('../utils/logger');

const DAYS_HE = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
const MONTHS_HE = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];

function formatTime(isoString) {
  const d = new Date(isoString);
  const il = new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }));
  const hours = String(il.getHours()).padStart(2, '0');
  const minutes = String(il.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

function formatDateFull(isoString) {
  const d = new Date(isoString);
  const il = new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }));
  const day = DAYS_HE[il.getDay()];
  const date = il.getDate();
  const month = MONTHS_HE[il.getMonth()];
  const hours = String(il.getHours()).padStart(2, '0');
  const minutes = String(il.getMinutes()).padStart(2, '0');
  return `יום ${day}, ${date} ב${month} בשעה ${hours}:${minutes}`;
}

/**
 * Check if it's around 6:00 AM Israel time (within a 10-minute window)
 */
function isDailySummaryTime() {
  const now = new Date();
  const ilTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }));
  const hours = ilTime.getHours();
  const minutes = ilTime.getMinutes();
  // 6:00-6:09 AM Israel time
  return hours === 6 && minutes < 10;
}

/**
 * Send daily morning summary at 6:00 AM to all active users
 */
async function sendDailySummary() {
  try {
    if (!isDailySummaryTime()) return;

    const todayEvents = await db.getTodayEventsAllUsers();

    // Group events by user
    const eventsByUser = {};
    for (const event of todayEvents) {
      const phone = event.users?.phone_number;
      if (!phone) continue;
      if (!eventsByUser[phone]) eventsByUser[phone] = [];
      eventsByUser[phone].push(event);
    }

    for (const [phone, events] of Object.entries(eventsByUser)) {
      // Check if we already sent today's summary (using the first event's day_summary_sent flag)
      const alreadySent = events.some((e) => e.day_summary_sent);
      if (alreadySent) continue;

      const eventLines = events.map((e) => {
        const time = formatTime(e.datetime);
        const loc = e.location ? ` 📍 ${e.location}` : '';
        return `• ${time} - ${e.title}${loc}`;
      }).join('\n');

      const message = `☀️ בוקר טוב! הנה מה שמחכה לך היום:\n\n${eventLines}\n\nיום מוצלח! 💪`;

      await greenApi.sendMessage(phone, message);

      // Mark all today's events as summary sent
      for (const event of events) {
        await db.markReminderSent(event.id, 'day_summary_sent');
      }

      logger.info('reminders', 'Daily summary sent', { phone, eventCount: events.length });
    }
  } catch (error) {
    logger.error('reminders', 'Failed to send daily summary', error);
  }
}

/**
 * Send reminders 1 hour before each event
 */
async function checkHourlyReminders() {
  try {
    const events = await db.getEventsForHourlyReminder();

    for (const event of events) {
      const phone = event.users?.phone_number;
      if (!phone) continue;

      const time = formatTime(event.datetime);
      const loc = event.location ? `\n📍 ${event.location}` : '';
      const message = `⏰ בעוד שעה: ${event.title} ב-${time}${loc}`;

      await greenApi.sendMessage(phone, message);
      await db.markReminderSent(event.id, 'reminder_sent');
      logger.info('reminders', 'Hourly reminder sent', { eventId: event.id, phone });
    }
  } catch (error) {
    logger.error('reminders', 'Failed to check hourly reminders', error);
  }
}

/**
 * Check for due custom reminders
 */
async function checkCustomReminders() {
  try {
    const dueReminders = await db.getDueReminders();

    for (const reminder of dueReminders) {
      const phone = reminder.users?.phone_number;
      if (!phone) continue;

      const message = `🔔 תזכורת: ${reminder.content}`;
      await greenApi.sendMessage(phone, message);
      await db.markReminderDone(reminder.id);
      logger.info('reminders', 'Custom reminder sent', { reminderId: reminder.id, phone });
    }
  } catch (error) {
    logger.error('reminders', 'Failed to check custom reminders', error);
  }
}

/**
 * Run all reminder checks
 */
async function runAllReminders() {
  await sendDailySummary();
  await checkHourlyReminders();
  await checkCustomReminders();
}

/**
 * Start the cron jobs for reminders (local dev)
 */
function startReminderCron() {
  // Check every minute
  cron.schedule('* * * * *', async () => {
    await runAllReminders();
  });

  logger.info('reminders', 'Reminder cron job started - checking every minute');
}

module.exports = {
  startReminderCron,
  runAllReminders,
  sendDailySummary,
  checkHourlyReminders,
  checkCustomReminders,
};
