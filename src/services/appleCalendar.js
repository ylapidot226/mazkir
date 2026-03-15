const { createDAVClient } = require('tsdav');
const logger = require('../utils/logger');

/**
 * Verify Apple credentials by connecting to iCloud CalDAV
 * @param {string} appleId - Apple ID email
 * @param {string} appPassword - App-Specific Password
 * @returns {{ success: boolean, calendars: Array }}
 */
async function verifyCredentials(appleId, appPassword) {
  try {
    const client = await createDAVClient({
      serverUrl: 'https://caldav.icloud.com',
      credentials: {
        username: appleId,
        password: appPassword,
      },
      authMethod: 'Basic',
      defaultAccountType: 'caldav',
    });

    const calendars = await client.fetchCalendars();
    const calendarList = calendars.map((c) => ({
      url: c.url,
      displayName: c.displayName || 'לוח שנה',
      ctag: c.ctag,
    }));

    return { success: true, calendars: calendarList };
  } catch (error) {
    logger.error('apple', 'Failed to verify credentials', { error: error.message });
    return { success: false, calendars: [] };
  }
}

/**
 * Create a DAV client from stored credentials
 */
async function getClient(credentials) {
  const { appleId, appPassword } = JSON.parse(credentials);

  const client = await createDAVClient({
    serverUrl: 'https://caldav.icloud.com',
    credentials: {
      username: appleId,
      password: appPassword,
    },
    authMethod: 'Basic',
    defaultAccountType: 'caldav',
  });

  return client;
}

/**
 * List events from Apple Calendar
 * @param {string} credentials - JSON string with appleId + appPassword
 * @param {string} calendarUrl - Calendar URL
 * @returns {Array} events
 */
async function listEvents(credentials, calendarUrl) {
  try {
    const client = await getClient(credentials);
    const calendars = await client.fetchCalendars();
    const calendar = calendars.find((c) => c.url === calendarUrl) || calendars[0];

    if (!calendar) return [];

    // Fetch events from now onward
    const now = new Date();
    const futureDate = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000); // 90 days

    const calendarObjects = await client.fetchCalendarObjects({
      calendar,
      timeRange: {
        start: now.toISOString(),
        end: futureDate.toISOString(),
      },
    });

    return calendarObjects.map((obj) => ({
      url: obj.url,
      etag: obj.etag,
      data: obj.data,
      ...parseICS(obj.data),
    }));
  } catch (error) {
    logger.error('apple', 'Failed to list events', { error: error.message });
    return [];
  }
}

/**
 * Create an event in Apple Calendar
 */
async function createEvent(credentials, calendarUrl, event) {
  try {
    const client = await getClient(credentials);
    const calendars = await client.fetchCalendars();
    const calendar = calendars.find((c) => c.url === calendarUrl) || calendars[0];

    if (!calendar) throw new Error('Calendar not found');

    const uid = generateUID();
    const startDate = new Date(event.datetime);
    const endDate = new Date(startDate.getTime() + 60 * 60 * 1000);

    const icsData = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Mazkir//WhatsApp Bot//HE',
      'BEGIN:VEVENT',
      `UID:${uid}`,
      `DTSTART;TZID=Asia/Jerusalem:${formatLocalDate(startDate)}`,
      `DTEND;TZID=Asia/Jerusalem:${formatLocalDate(endDate)}`,
      `SUMMARY:${event.title}`,
      event.location ? `LOCATION:${event.location}` : '',
      `DTSTAMP:${formatICSDate(new Date())}`,
      'END:VEVENT',
      'END:VCALENDAR',
    ].filter(Boolean).join('\r\n');

    const result = await client.createCalendarObject({
      calendar,
      filename: `${uid}.ics`,
      iCalString: icsData,
    });

    logger.info('apple', 'Event created', { uid, title: event.title });
    return { uid, url: result?.url };
  } catch (error) {
    logger.error('apple', 'Failed to create event', { error: error.message });
    throw error;
  }
}

/**
 * Delete an event from Apple Calendar by UID
 */
async function deleteEvent(credentials, calendarUrl, eventUid) {
  try {
    const client = await getClient(credentials);
    const calendars = await client.fetchCalendars();
    const calendar = calendars.find((c) => c.url === calendarUrl) || calendars[0];

    if (!calendar) return;

    // Fetch all events and find the one matching the UID
    const objects = await client.fetchCalendarObjects({ calendar });
    const target = objects.find((obj) => {
      if (!obj.data) return false;
      const uidMatch = obj.data.match(/UID[^:]*:(.+)/i);
      return uidMatch && uidMatch[1].trim() === eventUid;
    });

    if (target) {
      await client.deleteCalendarObject({
        calendarObject: target,
      });
      logger.info('apple', 'Event deleted', { eventUid });
    } else {
      logger.warn('apple', 'Event not found for deletion', { eventUid });
    }
  } catch (error) {
    logger.error('apple', 'Failed to delete event', { error: error.message });
  }
}

/**
 * Parse basic ICS data into event fields
 */
function parseICS(icsString) {
  if (!icsString) return {};

  const getField = (name) => {
    const regex = new RegExp(`${name}[^:]*:(.+)`, 'i');
    const match = icsString.match(regex);
    return match ? match[1].trim() : null;
  };

  const summary = getField('SUMMARY');
  const location = getField('LOCATION');
  const dtstart = getField('DTSTART');
  const uid = getField('UID');

  let datetime = null;
  if (dtstart) {
    // Handle both formats: 20260315T100000Z and 20260315T100000
    const cleaned = dtstart.replace(/[^0-9TZ]/g, '');
    if (cleaned.length >= 15) {
      const year = cleaned.substring(0, 4);
      const month = cleaned.substring(4, 6);
      const day = cleaned.substring(6, 8);
      const hour = cleaned.substring(9, 11);
      const min = cleaned.substring(11, 13);
      const sec = cleaned.substring(13, 15);
      const isUTC = cleaned.endsWith('Z');
      datetime = `${year}-${month}-${day}T${hour}:${min}:${sec}${isUTC ? 'Z' : ''}`;
    }
  }

  return { summary, location, datetime, uid };
}

/**
 * Format a Date as ICS datetime string (UTC with Z)
 */
function formatICSDate(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/**
 * Format a Date as local Israel time for ICS (no Z suffix, used with TZID)
 */
function formatLocalDate(date) {
  const il = new Date(date.toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }));
  const y = il.getFullYear();
  const m = String(il.getMonth() + 1).padStart(2, '0');
  const d = String(il.getDate()).padStart(2, '0');
  const h = String(il.getHours()).padStart(2, '0');
  const min = String(il.getMinutes()).padStart(2, '0');
  const s = String(il.getSeconds()).padStart(2, '0');
  return `${y}${m}${d}T${h}${min}${s}`;
}

/**
 * Generate a unique ID for ICS events
 */
function generateUID() {
  const chars = 'abcdef0123456789';
  let uid = '';
  for (let i = 0; i < 32; i++) {
    uid += chars[Math.floor(Math.random() * chars.length)];
  }
  return `${uid}@mazkir`;
}

// ---- Apple Reminders (VTODO) ----

/**
 * Get the reminders (VTODO) calendars from iCloud
 */
async function getRemindersCalendars(credentials) {
  try {
    const { appleId, appPassword } = JSON.parse(credentials);
    const client = await createDAVClient({
      serverUrl: 'https://caldav.icloud.com',
      credentials: { username: appleId, password: appPassword },
      authMethod: 'Basic',
      defaultAccountType: 'caldav',
    });

    const calendars = await client.fetchCalendars({ calendarType: 'VTODO' });
    return { client, calendars };
  } catch (error) {
    logger.error('apple', 'Failed to get reminders calendars', { error: error.message });
    return { client: null, calendars: [] };
  }
}

/**
 * List reminders (todos) from Apple Reminders
 */
async function listReminders(credentials) {
  try {
    const { client, calendars } = await getRemindersCalendars(credentials);
    if (!client || calendars.length === 0) return [];

    const allReminders = [];
    for (const calendar of calendars) {
      try {
        const objects = await client.fetchCalendarObjects({ calendar });
        for (const obj of objects) {
          if (!obj.data || !obj.data.includes('VTODO')) continue;
          const parsed = parseVTODO(obj.data);
          if (parsed.summary) {
            allReminders.push({
              ...parsed,
              url: obj.url,
              etag: obj.etag,
              calendarUrl: calendar.url,
              calendarName: calendar.displayName || 'Reminders',
            });
          }
        }
      } catch (e) {
        // Skip calendars that fail
      }
    }

    return allReminders;
  } catch (error) {
    logger.error('apple', 'Failed to list reminders', { error: error.message });
    return [];
  }
}

/**
 * Create a reminder (VTODO) in Apple Reminders
 */
async function createReminder(credentials, title, listName) {
  try {
    const { client, calendars } = await getRemindersCalendars(credentials);
    if (!client || calendars.length === 0) throw new Error('No reminders calendars found');

    // Try to find a matching list, or use the first one
    const calendar = calendars.find((c) =>
      c.displayName && c.displayName.toLowerCase() === (listName || '').toLowerCase()
    ) || calendars[0];

    const uid = generateUID();

    const vtodoData = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Mazkir//WhatsApp Bot//HE',
      'BEGIN:VTODO',
      `UID:${uid}`,
      `DTSTAMP:${formatICSDate(new Date())}`,
      `SUMMARY:${title}`,
      'STATUS:NEEDS-ACTION',
      'END:VTODO',
      'END:VCALENDAR',
    ].join('\r\n');

    await client.createCalendarObject({
      calendar,
      filename: `${uid}.ics`,
      iCalString: vtodoData,
    });

    logger.info('apple', 'Reminder created', { uid, title, list: calendar.displayName });
    return { uid };
  } catch (error) {
    logger.error('apple', 'Failed to create reminder', { error: error.message });
    throw error;
  }
}

/**
 * Complete a reminder in Apple Reminders by UID
 */
async function completeReminder(credentials, reminderUid) {
  try {
    const { client, calendars } = await getRemindersCalendars(credentials);
    if (!client) return;

    for (const calendar of calendars) {
      try {
        const objects = await client.fetchCalendarObjects({ calendar });
        const target = objects.find((obj) => {
          if (!obj.data) return false;
          const uidMatch = obj.data.match(/UID[^:]*:(.+)/i);
          return uidMatch && uidMatch[1].trim() === reminderUid;
        });

        if (target) {
          // Update STATUS to COMPLETED
          const updatedData = target.data
            .replace(/STATUS:[^\r\n]+/, 'STATUS:COMPLETED')
            .replace(/END:VTODO/, `COMPLETED:${formatICSDate(new Date())}\r\nEND:VTODO`);

          await client.updateCalendarObject({
            calendarObject: {
              url: target.url,
              etag: target.etag,
              data: updatedData,
            },
          });

          logger.info('apple', 'Reminder completed', { reminderUid });
          return;
        }
      } catch (e) {
        // Skip
      }
    }
  } catch (error) {
    logger.error('apple', 'Failed to complete reminder', { error: error.message });
  }
}

/**
 * Delete a reminder from Apple Reminders by UID
 */
async function deleteReminder(credentials, reminderUid) {
  try {
    const { client, calendars } = await getRemindersCalendars(credentials);
    if (!client) return;

    for (const calendar of calendars) {
      try {
        const objects = await client.fetchCalendarObjects({ calendar });
        const target = objects.find((obj) => {
          if (!obj.data) return false;
          const uidMatch = obj.data.match(/UID[^:]*:(.+)/i);
          return uidMatch && uidMatch[1].trim() === reminderUid;
        });

        if (target) {
          await client.deleteCalendarObject({ calendarObject: target });
          logger.info('apple', 'Reminder deleted', { reminderUid });
          return;
        }
      } catch (e) {
        // Skip
      }
    }
  } catch (error) {
    logger.error('apple', 'Failed to delete reminder', { error: error.message });
  }
}

/**
 * Parse VTODO ICS data
 */
function parseVTODO(icsString) {
  if (!icsString) return {};

  const getField = (name) => {
    const regex = new RegExp(`${name}[^:]*:(.+)`, 'i');
    const match = icsString.match(regex);
    return match ? match[1].trim() : null;
  };

  return {
    uid: getField('UID'),
    summary: getField('SUMMARY'),
    status: getField('STATUS'),
    completed: getField('STATUS') === 'COMPLETED',
  };
}

module.exports = {
  verifyCredentials,
  listEvents,
  createEvent,
  deleteEvent,
  listReminders,
  createReminder,
  completeReminder,
  deleteReminder,
};
