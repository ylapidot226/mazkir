const cron = require('node-cron');
const db = require('./database');
const whatsapp = require('./twilio');
const logger = require('../utils/logger');

const DAYS_HE = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
const MONTHS_HE = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];

function formatTime(isoString, timezone = 'Asia/Jerusalem') {
  const d = new Date(isoString);
  const il = new Date(d.toLocaleString('en-US', { timeZone: timezone }));
  const hours = String(il.getHours()).padStart(2, '0');
  const minutes = String(il.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

function formatDateFull(isoString, timezone = 'Asia/Jerusalem') {
  const d = new Date(isoString);
  const il = new Date(d.toLocaleString('en-US', { timeZone: timezone }));
  const day = DAYS_HE[il.getDay()];
  const date = il.getDate();
  const month = MONTHS_HE[il.getMonth()];
  const hours = String(il.getHours()).padStart(2, '0');
  const minutes = String(il.getMinutes()).padStart(2, '0');
  return `יום ${day}, ${date} ב${month} בשעה ${hours}:${minutes}`;
}

/**
 * Check if it's 9:00 PM Israel time (within the hour window)
 */
function isDailySummaryTime() {
  const now = new Date();
  const ilTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }));
  const hours = ilTime.getHours();
  // 21:00-21:59 Israel time (9 PM - summary for tomorrow)
  // day_summary_sent flag prevents duplicate sends
  return hours === 21;
}

// Map Hebrew day names to JS day numbers (0=Sunday)
const DAY_NAME_TO_NUM = {
  'ראשון': 0, 'שני': 1, 'שלישי': 2, 'רביעי': 3,
  'חמישי': 4, 'שישי': 5, 'שבת': 6,
  'sunday': 0, 'monday': 1, 'tuesday': 2, 'wednesday': 3,
  'thursday': 4, 'friday': 5, 'saturday': 6,
  '0': 0, '1': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6,
};

/**
 * Generate today's events from recurring patterns
 */
async function generateRecurringEvents() {
  try {
    const recurringEvents = await db.getActiveRecurringEvents();
    if (recurringEvents.length === 0) return;

    const now = new Date();
    const ilTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }));
    const todayDayNum = ilTime.getDay(); // 0=Sunday

    for (const recurring of recurringEvents) {
      // Parse days string (e.g., "1,2,3,4" or "שני,שלישי,רביעי,חמישי")
      const days = recurring.days.split(',').map((d) => {
        const trimmed = d.trim().toLowerCase();
        return DAY_NAME_TO_NUM[trimmed] ?? parseInt(trimmed, 10);
      }).filter((d) => !isNaN(d));

      // Check if today is one of the recurring days
      if (!days.includes(todayDayNum)) continue;

      // Parse time (e.g., "13:00")
      const [hours, minutes] = recurring.time.split(':').map(Number);

      // Build today's datetime in Israel timezone
      const eventDate = new Date(ilTime);
      eventDate.setHours(hours, minutes, 0, 0);

      // Convert back to UTC for storage
      const utcStr = now.toLocaleString('en-US', { timeZone: 'UTC', hour12: false });
      const ilStr = now.toLocaleString('en-US', { timeZone: 'Asia/Jerusalem', hour12: false });
      const offsetMs = new Date(ilStr) - new Date(utcStr);
      const eventUtc = new Date(eventDate.getTime() - offsetMs);

      // Check if this event already exists today
      const exists = await db.recurringEventExistsToday(
        recurring.user_id, recurring.title, eventUtc.toISOString()
      );
      if (exists) continue;

      // Create the event
      await db.addEvent(recurring.user_id, recurring.title, eventUtc.toISOString(), recurring.location);
      logger.info('reminders', 'Recurring event generated', {
        userId: recurring.user_id, title: recurring.title, datetime: eventUtc.toISOString(),
      });
    }
  } catch (error) {
    logger.error('reminders', 'Failed to generate recurring events', error);
  }
}

// Track which task-only users already received today's summary (no DB flag for tasks)
let taskOnlySummaryDate = '';
const taskOnlySummarySent = new Set();

/**
 * Send daily evening summary at 9:00 PM to all active users (for tomorrow)
 */
async function sendDailySummary() {
  try {
    if (!isDailySummaryTime()) return;

    const tomorrowEvents = await db.getTomorrowEventsAllUsers();
    const recurringEvents = await db.getActiveRecurringEvents();

    // Determine tomorrow's day number
    const now = new Date();
    const ilTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }));
    const tomorrowDate = new Date(ilTime);
    tomorrowDate.setDate(tomorrowDate.getDate() + 1);
    const tomorrowDayNum = tomorrowDate.getDay();

    // Group events by user
    const eventsByUser = {};
    for (const event of tomorrowEvents) {
      const phone = event.users?.phone_number;
      if (!phone) continue;
      if (!eventsByUser[phone]) eventsByUser[phone] = [];
      eventsByUser[phone].push(event);
    }

    // Add recurring events for tomorrow
    for (const recurring of recurringEvents) {
      const days = recurring.days.split(',').map((d) => {
        const trimmed = d.trim().toLowerCase();
        return DAY_NAME_TO_NUM[trimmed] ?? parseInt(trimmed, 10);
      }).filter((d) => !isNaN(d));

      if (!days.includes(tomorrowDayNum)) continue;

      const phone = recurring.users?.phone_number;
      if (!phone) continue;
      if (!eventsByUser[phone]) eventsByUser[phone] = [];

      // Check if this recurring event isn't already in the list (as a generated event)
      const alreadyExists = eventsByUser[phone].some((e) => e.title === recurring.title);
      if (alreadyExists) continue;

      eventsByUser[phone].push({
        title: recurring.title,
        datetime: null,
        time_display: recurring.time,
        location: recurring.location,
      });
    }

    // Get open tasks for all users to include in daily summary
    const allTasks = await db.getOpenTasksAllUsers();
    const tasksByUser = {};
    for (const task of allTasks) {
      const phone = task.users?.phone_number;
      if (!phone) continue;
      if (!tasksByUser[phone]) tasksByUser[phone] = [];
      tasksByUser[phone].push(task);
    }

    // Reset task-only tracking on new day
    const todayStr = ilTime.toISOString().substring(0, 10);
    if (taskOnlySummaryDate !== todayStr) {
      taskOnlySummaryDate = todayStr;
      taskOnlySummarySent.clear();
    }

    // Collect all phones that have either events or tasks
    const allPhones = new Set([...Object.keys(eventsByUser), ...Object.keys(tasksByUser)]);

    for (const phone of allPhones) {
      const events = eventsByUser[phone] || [];
      const tasks = tasksByUser[phone] || [];

      // Check if we already sent this summary
      const alreadySent = events.length > 0
        ? events.some((e) => e.day_summary_sent)
        : taskOnlySummarySent.has(phone);
      if (alreadySent) continue;

      let messageParts = [];

      if (events.length > 0) {
        const eventLines = events.map((e) => {
          const time = e.time_display || formatTime(e.datetime);
          const loc = e.location && e.location !== 'Asia/Jerusalem' ? ` 📍 ${e.location}` : '';
          return `• ${time} - ${e.title}${loc}`;
        }).join('\n');
        messageParts.push(`📅 מחר:\n\n${eventLines}`);
      }

      if (tasks.length > 0) {
        const taskLines = tasks.map((t) => `• ${t.content}${t.category && t.category !== 'כללי' ? ` (${t.category})` : ''}`).join('\n');
        messageParts.push(`📋 משימות פתוחות:\n\n${taskLines}`);
      }

      if (messageParts.length === 0) continue;

      const message = `🌙 ערב טוב!\n\n${messageParts.join('\n\n')}\n\nלילה טוב! 😴`;

      await whatsapp.sendMessage(phone, message);

      // Mark events as summary sent
      for (const event of events) {
        if (event.id) await db.markReminderSent(event.id, 'day_summary_sent');
      }
      // Track task-only users in memory
      if (events.length === 0) {
        taskOnlySummarySent.add(phone);
      }

      logger.info('reminders', 'Daily summary sent', { phone, eventCount: events.length, taskCount: tasks.length });
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
      const loc = event.location && event.location !== 'Asia/Jerusalem' ? `\n📍 ${event.location}` : '';
      const message = `⏰ בעוד שעה: ${event.title} ב-${time}${loc}`;

      await whatsapp.sendMessage(phone, message);
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
      await whatsapp.sendMessage(phone, message);
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
  await generateRecurringEvents();
  await sendDailySummary();
  await checkHourlyReminders();
  await checkCustomReminders();

  // Calendar sync (runs on same schedule)
  try {
    const { syncAllCalendars } = require('./calendarSync');
    await syncAllCalendars();
  } catch (error) {
    logger.error('reminders', 'Calendar sync failed', { error: error.message });
  }

  // Bug report (every 6 hours)
  try {
    const { runBugReport, isBugReportTime } = require('./bugMonitor');
    if (isBugReportTime()) {
      await runBugReport();
    }
  } catch (error) {
    logger.error('reminders', 'Bug report failed', { error: error.message });
  }
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
