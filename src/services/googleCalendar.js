const { google } = require('googleapis');
const config = require('../config');
const logger = require('../utils/logger');

const oauth2Client = new google.auth.OAuth2(
  config.google.clientId,
  config.google.clientSecret,
  config.google.redirectUri
);

/**
 * Generate OAuth2 authorization URL for a user
 */
function getAuthUrl(userId) {
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: ['https://www.googleapis.com/auth/calendar'],
    state: userId,
  });
}

/**
 * Exchange authorization code for tokens
 */
async function getTokensFromCode(code) {
  const { tokens } = await oauth2Client.getToken(code);
  return tokens;
}

/**
 * Create an authenticated calendar client for a user
 */
function getCalendarClient(tokens) {
  const auth = new google.auth.OAuth2(
    config.google.clientId,
    config.google.clientSecret,
    config.google.redirectUri
  );
  auth.setCredentials(tokens);

  // Listen for token refresh
  auth.on('tokens', (newTokens) => {
    logger.info('google', 'Tokens refreshed');
  });

  return { calendar: google.calendar({ version: 'v3', auth }), auth };
}

/**
 * List events from Google Calendar
 * @param {object} tokens - OAuth2 tokens
 * @param {string} syncToken - For incremental sync (null for full sync)
 * @param {string} calendarId - Calendar ID (default: 'primary')
 * @returns {{ events: Array, nextSyncToken: string }}
 */
async function listEvents(tokens, syncToken = null, calendarId = 'primary') {
  const { calendar } = getCalendarClient(tokens);

  const params = {
    calendarId,
    singleEvents: true,
    orderBy: 'startTime',
    maxResults: 250,
  };

  if (syncToken) {
    params.syncToken = syncToken;
  } else {
    // Full sync: only future events
    params.timeMin = new Date().toISOString();
  }

  try {
    const allEvents = [];
    let pageToken = null;
    let nextSyncToken = null;

    do {
      if (pageToken) params.pageToken = pageToken;
      const response = await calendar.events.list(params);
      allEvents.push(...(response.data.items || []));
      pageToken = response.data.nextPageToken;
      nextSyncToken = response.data.nextSyncToken;
    } while (pageToken);

    return { events: allEvents, nextSyncToken };
  } catch (error) {
    // If sync token is invalid, do a full sync
    if (error.code === 410 && syncToken) {
      logger.warn('google', 'Sync token expired, doing full sync');
      return listEvents(tokens, null, calendarId);
    }
    throw error;
  }
}

/**
 * Create an event in Google Calendar
 */
async function createEvent(tokens, event, calendarId = 'primary') {
  const { calendar } = getCalendarClient(tokens);

  const eventBody = {
    summary: event.title,
    location: event.location || undefined,
    start: {
      dateTime: event.datetime,
      timeZone: 'Asia/Jerusalem',
    },
    end: {
      dateTime: new Date(new Date(event.datetime).getTime() + 60 * 60 * 1000).toISOString(),
      timeZone: 'Asia/Jerusalem',
    },
  };

  const response = await calendar.events.insert({
    calendarId,
    requestBody: eventBody,
  });

  logger.info('google', 'Event created', { eventId: response.data.id, title: event.title });
  return response.data;
}

/**
 * Delete an event from Google Calendar
 */
async function deleteEvent(tokens, eventId, calendarId = 'primary') {
  const { calendar } = getCalendarClient(tokens);

  await calendar.events.delete({
    calendarId,
    eventId,
  });

  logger.info('google', 'Event deleted', { eventId });
}

/**
 * Update an event in Google Calendar
 */
async function updateEvent(tokens, eventId, event, calendarId = 'primary') {
  const { calendar } = getCalendarClient(tokens);

  const eventBody = {
    summary: event.title,
    location: event.location || undefined,
    start: {
      dateTime: event.datetime,
      timeZone: 'Asia/Jerusalem',
    },
    end: {
      dateTime: new Date(new Date(event.datetime).getTime() + 60 * 60 * 1000).toISOString(),
      timeZone: 'Asia/Jerusalem',
    },
  };

  const response = await calendar.events.update({
    calendarId,
    eventId,
    requestBody: eventBody,
  });

  return response.data;
}

/**
 * Refresh tokens if needed and return updated tokens
 */
async function refreshTokensIfNeeded(tokens) {
  const auth = new google.auth.OAuth2(
    config.google.clientId,
    config.google.clientSecret,
    config.google.redirectUri
  );
  auth.setCredentials(tokens);

  const { credentials } = await auth.refreshAccessToken();
  return credentials;
}

module.exports = {
  getAuthUrl,
  getTokensFromCode,
  listEvents,
  createEvent,
  deleteEvent,
  updateEvent,
  refreshTokensIfNeeded,
};
