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
      `DTSTART:${formatICSDate(startDate)}`,
      `DTEND:${formatICSDate(endDate)}`,
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
 * Delete an event from Apple Calendar
 */
async function deleteEvent(credentials, calendarUrl, eventUrl) {
  try {
    const client = await getClient(credentials);

    await client.deleteCalendarObject({
      calendarObject: { url: eventUrl, etag: '' },
    });

    logger.info('apple', 'Event deleted', { eventUrl });
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
 * Format a Date as ICS datetime string
 */
function formatICSDate(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
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

module.exports = {
  verifyCredentials,
  listEvents,
  createEvent,
  deleteEvent,
};
