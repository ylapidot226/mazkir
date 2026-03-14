const db = require('./database');
const googleCalendar = require('./googleCalendar');
const appleCalendar = require('./appleCalendar');
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
        } else if (conn.provider === 'apple') {
          await syncAppleCalendar(conn);
        }
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

// ---- Google Calendar Sync ----

async function syncGoogleCalendar(connection) {
  const { user_id, credentials, sync_token, calendar_id } = connection;
  const tokens = JSON.parse(credentials);
  const calId = calendar_id || 'primary';

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

  await pullFromGoogle(user_id, connection.id, currentTokens, sync_token, calId);
  await pushToGoogle(user_id, currentTokens, calId);
}

async function pullFromGoogle(userId, connectionId, tokens, syncToken, calendarId) {
  try {
    const { events, nextSyncToken } = await googleCalendar.listEvents(tokens, syncToken, calendarId);

    for (const gEvent of events) {
      if (gEvent.status === 'cancelled') {
        await db.deleteEventByExternalId(userId, gEvent.id);
        continue;
      }

      const startDateTime = gEvent.start?.dateTime;
      if (!startDateTime) continue;

      const existingEvent = await db.getEventByExternalId(userId, gEvent.id);

      if (existingEvent) {
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

    if (nextSyncToken) {
      await db.updateCalendarSyncToken(connectionId, nextSyncToken);
    }
  } catch (error) {
    logger.error('calendarSync', 'Pull from Google failed', { userId, error: error.message });
  }
}

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
          userId, eventId: event.id, error: error.message,
        });
      }
    }
  } catch (error) {
    logger.error('calendarSync', 'Push to Google failed', { userId, error: error.message });
  }
}

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

// ---- Apple Calendar Sync ----

async function syncAppleCalendar(connection) {
  const { user_id, credentials, calendar_id } = connection;

  // Pull events from Apple → Supabase
  await pullFromApple(user_id, connection.id, credentials, calendar_id);

  // Push new local events to Apple
  await pushToApple(user_id, credentials, calendar_id);
}

async function pullFromApple(userId, connectionId, credentials, calendarUrl) {
  try {
    const events = await appleCalendar.listEvents(credentials, calendarUrl);

    for (const aEvent of events) {
      if (!aEvent.datetime || !aEvent.summary) continue;

      const externalId = aEvent.uid || aEvent.url;
      if (!externalId) continue;

      const existingEvent = await db.getEventByExternalId(userId, externalId);

      if (existingEvent) {
        const hasChanged =
          existingEvent.title !== aEvent.summary ||
          new Date(existingEvent.datetime).getTime() !== new Date(aEvent.datetime).getTime() ||
          (existingEvent.location || '') !== (aEvent.location || '');

        if (hasChanged) {
          await db.updateEventFromExternal(existingEvent.id, {
            title: aEvent.summary,
            datetime: aEvent.datetime,
            location: aEvent.location || null,
          });
          logger.info('calendarSync', 'Event updated from Apple', { userId, title: aEvent.summary });
        }
      } else {
        await db.addEventFromExternal(userId, {
          title: aEvent.summary,
          datetime: aEvent.datetime,
          location: aEvent.location || null,
          external_id: externalId,
          source: 'apple',
        });
        logger.info('calendarSync', 'Event pulled from Apple', { userId, title: aEvent.summary });
      }
    }

    await db.updateCalendarSyncToken(connectionId, new Date().toISOString());
  } catch (error) {
    logger.error('calendarSync', 'Pull from Apple failed', { userId, error: error.message });
  }
}

async function pushToApple(userId, credentials, calendarUrl) {
  try {
    const unpushedEvents = await db.getUnpushedEvents(userId);

    for (const event of unpushedEvents) {
      try {
        const result = await appleCalendar.createEvent(credentials, calendarUrl, event);
        const externalId = result.uid || result.url;
        if (externalId) {
          await db.markEventPushed(event.id, externalId, 'apple');
          logger.info('calendarSync', 'Event pushed to Apple', { userId, title: event.title });
        }
      } catch (error) {
        logger.error('calendarSync', 'Failed to push event to Apple', {
          userId, eventId: event.id, error: error.message,
        });
      }
    }
  } catch (error) {
    logger.error('calendarSync', 'Push to Apple failed', { userId, error: error.message });
  }
}

async function pushEventToApple(userId, eventId) {
  try {
    const connection = await db.getCalendarConnection(userId, 'apple');
    if (!connection) return;

    const event = await db.getEventById(eventId);
    if (!event || event.external_id) return;

    const result = await appleCalendar.createEvent(connection.credentials, connection.calendar_id, event);
    const externalId = result.uid || result.url;
    if (externalId) {
      await db.markEventPushed(event.id, externalId, 'apple');
      logger.info('calendarSync', 'Event immediately pushed to Apple', { userId, title: event.title });
    }
  } catch (error) {
    logger.error('calendarSync', 'Immediate Apple push failed', { userId, eventId, error: error.message });
  }
}

async function deleteEventFromApple(userId, externalId) {
  try {
    const connection = await db.getCalendarConnection(userId, 'apple');
    if (!connection || !externalId) return;

    await appleCalendar.deleteEvent(connection.credentials, connection.calendar_id, externalId);
    logger.info('calendarSync', 'Event deleted from Apple', { userId, externalId });
  } catch (error) {
    logger.error('calendarSync', 'Failed to delete from Apple', { userId, error: error.message });
  }
}

// ---- Combined push/delete for all providers ----

async function pushEventToCalendars(userId, eventId) {
  await Promise.all([
    pushEventToGoogle(userId, eventId),
    pushEventToApple(userId, eventId),
  ]);
}

async function deleteEventFromCalendars(userId, externalId, source) {
  if (source === 'google') {
    await deleteEventFromGoogle(userId, externalId);
  } else if (source === 'apple') {
    await deleteEventFromApple(userId, externalId);
  }
}

module.exports = {
  syncAllCalendars,
  pushEventToGoogle,
  pushEventToApple,
  pushEventToCalendars,
  deleteEventFromGoogle,
  deleteEventFromApple,
  deleteEventFromCalendars,
};
