const db = require('./database');
const googleCalendar = require('./googleCalendar');
const logger = require('../utils/logger');

/**
 * Sync events for all users with connected calendars
 * Called by the cron job every few minutes
 */
async function syncAllCalendars() {
  try {
    const connections = await db.getAllCalendarConnections();

    for (const conn of connections) {
      try {
        if (conn.provider === 'google') {
          await syncGoogleCalendar(conn);
        }
        // Apple CalDAV will be added here later
      } catch (error) {
        logger.error('calendarSync', `Failed to sync calendar for user ${conn.user_id}`, {
          provider: conn.provider,
          error: error.message,
        });
      }
    }
  } catch (error) {
    logger.error('calendarSync', 'Failed to sync calendars', { error: error.message });
  }
}

/**
 * Sync Google Calendar for a specific connection
 */
async function syncGoogleCalendar(connection) {
  const { user_id, credentials, sync_token, calendar_id } = connection;
  const tokens = JSON.parse(credentials);
  const calId = calendar_id || 'primary';

  // Refresh tokens if needed
  let currentTokens = tokens;
  try {
    currentTokens = await googleCalendar.refreshTokensIfNeeded(tokens);
    if (currentTokens.access_token !== tokens.access_token) {
      await db.updateCalendarCredentials(connection.id, JSON.stringify(currentTokens));
    }
  } catch (error) {
    logger.error('calendarSync', 'Token refresh failed', { user_id, error: error.message });
    return;
  }

  // 1. Pull events from Google → Supabase
  await pullFromGoogle(user_id, connection.id, currentTokens, sync_token, calId);

  // 2. Push new local events to Google
  await pushToGoogle(user_id, currentTokens, calId);
}

/**
 * Pull events from Google Calendar into Supabase
 */
async function pullFromGoogle(userId, connectionId, tokens, syncToken, calendarId) {
  try {
    const { events, nextSyncToken } = await googleCalendar.listEvents(tokens, syncToken, calendarId);

    for (const gEvent of events) {
      // Skip cancelled events
      if (gEvent.status === 'cancelled') {
        await db.deleteEventByExternalId(userId, gEvent.id);
        continue;
      }

      // Skip all-day events (no dateTime)
      const startDateTime = gEvent.start?.dateTime;
      if (!startDateTime) continue;

      const existingEvent = await db.getEventByExternalId(userId, gEvent.id);

      if (existingEvent) {
        // Update if changed
        const hasChanged =
          existingEvent.title !== gEvent.summary ||
          new Date(existingEvent.datetime).getTime() !== new Date(startDateTime).getTime() ||
          (existingEvent.location || '') !== (gEvent.location || '');

        if (hasChanged) {
          await db.updateEventFromExternal(existingEvent.id, {
            title: gEvent.summary || 'אירוע',
            datetime: startDateTime,
            location: gEvent.location || null,
          });
          logger.info('calendarSync', 'Event updated from Google', { userId, title: gEvent.summary });
        }
      } else {
        // Create new event from Google
        await db.addEventFromExternal(userId, {
          title: gEvent.summary || 'אירוע',
          datetime: startDateTime,
          location: gEvent.location || null,
          external_id: gEvent.id,
          source: 'google',
        });
        logger.info('calendarSync', 'Event pulled from Google', { userId, title: gEvent.summary });
      }
    }

    // Save sync token for next incremental sync
    if (nextSyncToken) {
      await db.updateCalendarSyncToken(connectionId, nextSyncToken);
    }
  } catch (error) {
    logger.error('calendarSync', 'Pull from Google failed', { userId, error: error.message });
  }
}

/**
 * Push local events (created via WhatsApp) to Google Calendar
 */
async function pushToGoogle(userId, tokens, calendarId) {
  try {
    const unpushedEvents = await db.getUnpushedEvents(userId);

    for (const event of unpushedEvents) {
      try {
        const gEvent = await googleCalendar.createEvent(tokens, event, calendarId);
        await db.markEventPushed(event.id, gEvent.id, 'google');
        logger.info('calendarSync', 'Event pushed to Google', { userId, title: event.title });
      } catch (error) {
        logger.error('calendarSync', 'Failed to push event to Google', {
          userId,
          eventId: event.id,
          error: error.message,
        });
      }
    }
  } catch (error) {
    logger.error('calendarSync', 'Push to Google failed', { userId, error: error.message });
  }
}

/**
 * Push a single event to Google Calendar immediately after creation
 */
async function pushEventToGoogle(userId, eventId) {
  try {
    const connection = await db.getCalendarConnection(userId, 'google');
    if (!connection) return;

    const tokens = JSON.parse(connection.credentials);
    const calId = connection.calendar_id || 'primary';

    let currentTokens = tokens;
    try {
      currentTokens = await googleCalendar.refreshTokensIfNeeded(tokens);
      if (currentTokens.access_token !== tokens.access_token) {
        await db.updateCalendarCredentials(connection.id, JSON.stringify(currentTokens));
      }
    } catch (error) {
      return;
    }

    const event = await db.getEventById(eventId);
    if (!event || event.external_id) return;

    const gEvent = await googleCalendar.createEvent(currentTokens, event, calId);
    await db.markEventPushed(event.id, gEvent.id, 'google');
    logger.info('calendarSync', 'Event immediately pushed to Google', { userId, title: event.title });
  } catch (error) {
    logger.error('calendarSync', 'Immediate push failed', { userId, eventId, error: error.message });
  }
}

/**
 * Delete an event from Google Calendar when deleted locally
 */
async function deleteEventFromGoogle(userId, externalId) {
  try {
    const connection = await db.getCalendarConnection(userId, 'google');
    if (!connection || !externalId) return;

    const tokens = JSON.parse(connection.credentials);
    const calId = connection.calendar_id || 'primary';

    await googleCalendar.deleteEvent(tokens, externalId, calId);
    logger.info('calendarSync', 'Event deleted from Google', { userId, externalId });
  } catch (error) {
    logger.error('calendarSync', 'Failed to delete from Google', { userId, error: error.message });
  }
}

module.exports = {
  syncAllCalendars,
  pushEventToGoogle,
  deleteEventFromGoogle,
};
