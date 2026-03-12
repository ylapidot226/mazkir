const cron = require('node-cron');
const db = require('./database');
const greenApi = require('./greenApi');
const logger = require('../utils/logger');

function formatDateTime(isoString) {
  const date = new Date(isoString);
  return date.toLocaleString('he-IL', {
    timeZone: 'Asia/Jerusalem',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Check for upcoming events and send reminders
 */
async function checkEventReminders() {
  try {
    const { dayBefore, dayOf } = await db.getEventsForReminder();

    // 24-hour reminders
    for (const event of dayBefore) {
      const phone = event.users?.phone_number;
      if (!phone) continue;

      const dateStr = formatDateTime(event.datetime);
      const locationStr = event.location ? `\n📍 מיקום: ${event.location}` : '';
      const message = `⏰ תזכורת ליום מחר!\n\n📅 ${event.title}\n🕐 ${dateStr}${locationStr}\n\nאל תשכח! 😊`;

      await greenApi.sendMessage(phone, message);
      await db.markReminderSent(event.id, 'reminder_sent');
      logger.info('reminders', '24h reminder sent', { eventId: event.id, phone });
    }

    // Day-of reminders
    for (const event of dayOf) {
      const phone = event.users?.phone_number;
      if (!phone) continue;

      const dateStr = formatDateTime(event.datetime);
      const locationStr = event.location ? `\n📍 מיקום: ${event.location}` : '';
      const message = `🔔 עכשיו!\n\n📅 ${event.title}\n🕐 ${dateStr}${locationStr}\n\nבהצלחה! 💪`;

      await greenApi.sendMessage(phone, message);
      await db.markReminderSent(event.id, 'day_reminder_sent');
      logger.info('reminders', 'Day-of reminder sent', { eventId: event.id, phone });
    }
  } catch (error) {
    logger.error('reminders', 'Failed to check event reminders', error);
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

      const message = `🔔 תזכורת!\n\n${reminder.content}`;
      await greenApi.sendMessage(phone, message);
      await db.markReminderDone(reminder.id);
      logger.info('reminders', 'Custom reminder sent', { reminderId: reminder.id, phone });
    }
  } catch (error) {
    logger.error('reminders', 'Failed to check custom reminders', error);
  }
}

/**
 * Start the cron jobs for reminders
 */
function startReminderCron() {
  // Check every minute
  cron.schedule('* * * * *', async () => {
    await checkEventReminders();
    await checkCustomReminders();
  });

  logger.info('reminders', 'Reminder cron job started - checking every minute');
}

module.exports = {
  startReminderCron,
  checkEventReminders,
  checkCustomReminders,
};
