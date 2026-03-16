const { google } = require('googleapis');
const config = require('../config');
const logger = require('../utils/logger');

/**
 * Create an authenticated OAuth2 client from stored credentials
 */
function getAuthClient(credentials) {
  const auth = new google.auth.OAuth2(
    config.google.clientId,
    config.google.clientSecret,
    config.google.redirectUri
  );
  auth.setCredentials(credentials);
  return auth;
}

/**
 * List/search emails from Gmail
 * @param {object} credentials - OAuth2 tokens
 * @param {string} query - Gmail search query (optional)
 * @param {number} maxResults - Maximum number of results
 * @returns {Array} List of emails with subject, from, snippet, date
 */
async function listEmails(credentials, query = '', maxResults = 5) {
  const auth = getAuthClient(credentials);
  const gmail = google.gmail({ version: 'v1', auth });

  const response = await gmail.users.messages.list({
    userId: 'me',
    q: query || undefined,
    maxResults,
  });

  const messages = response.data.messages || [];
  const emails = [];

  for (const msg of messages) {
    const detail = await gmail.users.messages.get({
      userId: 'me',
      id: msg.id,
      format: 'metadata',
      metadataHeaders: ['Subject', 'From', 'Date'],
    });

    const headers = detail.data.payload.headers || [];
    const getHeader = (name) => {
      const h = headers.find((h) => h.name.toLowerCase() === name.toLowerCase());
      return h ? h.value : '';
    };

    emails.push({
      id: detail.data.id,
      subject: getHeader('Subject'),
      from: getHeader('From'),
      date: getHeader('Date'),
      snippet: detail.data.snippet || '',
    });
  }

  return emails;
}

/**
 * Read full email content
 * @param {object} credentials - OAuth2 tokens
 * @param {string} emailId - Gmail message ID
 * @returns {object} Email with full body text
 */
async function readEmail(credentials, emailId) {
  const auth = getAuthClient(credentials);
  const gmail = google.gmail({ version: 'v1', auth });

  const detail = await gmail.users.messages.get({
    userId: 'me',
    id: emailId,
    format: 'full',
  });

  const headers = detail.data.payload.headers || [];
  const getHeader = (name) => {
    const h = headers.find((h) => h.name.toLowerCase() === name.toLowerCase());
    return h ? h.value : '';
  };

  // Extract text body from parts
  const body = extractTextBody(detail.data.payload);

  return {
    id: detail.data.id,
    subject: getHeader('Subject'),
    from: getHeader('From'),
    date: getHeader('Date'),
    body: body || detail.data.snippet || '',
  };
}

/**
 * Recursively extract text/plain body from email payload
 */
function extractTextBody(payload) {
  if (!payload) return '';

  // Direct body
  if (payload.mimeType === 'text/plain' && payload.body && payload.body.data) {
    return decodeBase64Url(payload.body.data);
  }

  // Check parts recursively
  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body && part.body.data) {
        return decodeBase64Url(part.body.data);
      }
      if (part.parts) {
        const nested = extractTextBody(part);
        if (nested) return nested;
      }
    }
    // Fallback to text/html if no text/plain found
    for (const part of payload.parts) {
      if (part.mimeType === 'text/html' && part.body && part.body.data) {
        const html = decodeBase64Url(part.body.data);
        // Strip HTML tags for a rough text version
        return html.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
      }
    }
  }

  // Single-part message with body data
  if (payload.body && payload.body.data) {
    return decodeBase64Url(payload.body.data);
  }

  return '';
}

/**
 * Decode base64url encoded string
 */
function decodeBase64Url(data) {
  const base64 = data.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(base64, 'base64').toString('utf-8');
}

/**
 * Send an email via Gmail
 * @param {object} credentials - OAuth2 tokens
 * @param {string} to - Recipient email address
 * @param {string} subject - Email subject
 * @param {string} body - Email body (plain text)
 * @returns {object} Sent message info
 */
async function sendEmail(credentials, to, subject, body) {
  const auth = getAuthClient(credentials);
  const gmail = google.gmail({ version: 'v1', auth });

  const rawMessage = createRawMessage(to, subject, body);

  const response = await gmail.users.messages.send({
    userId: 'me',
    requestBody: {
      raw: rawMessage,
    },
  });

  return {
    id: response.data.id,
    threadId: response.data.threadId,
  };
}

/**
 * Reply to an email
 * @param {object} credentials - OAuth2 tokens
 * @param {string} emailId - Gmail message ID to reply to
 * @param {string} body - Reply body (plain text)
 * @returns {object} Sent message info
 */
async function replyToEmail(credentials, emailId, body) {
  const auth = getAuthClient(credentials);
  const gmail = google.gmail({ version: 'v1', auth });

  // Get the original message to extract headers
  const original = await gmail.users.messages.get({
    userId: 'me',
    id: emailId,
    format: 'metadata',
    metadataHeaders: ['Subject', 'From', 'To', 'Message-ID'],
  });

  const headers = original.data.payload.headers || [];
  const getHeader = (name) => {
    const h = headers.find((h) => h.name.toLowerCase() === name.toLowerCase());
    return h ? h.value : '';
  };

  const from = getHeader('From');
  const subject = getHeader('Subject');
  const messageId = getHeader('Message-ID');
  const replySubject = subject.startsWith('Re:') ? subject : `Re: ${subject}`;

  // Extract email address from "Name <email>" format
  const emailMatch = from.match(/<(.+)>/);
  const replyTo = emailMatch ? emailMatch[1] : from;

  const rawMessage = createRawMessage(replyTo, replySubject, body, {
    'In-Reply-To': messageId,
    References: messageId,
  });

  const response = await gmail.users.messages.send({
    userId: 'me',
    requestBody: {
      raw: rawMessage,
      threadId: original.data.threadId,
    },
  });

  return {
    id: response.data.id,
    threadId: response.data.threadId,
  };
}

/**
 * Create a base64url encoded raw email message
 */
function createRawMessage(to, subject, body, extraHeaders = {}) {
  const headerLines = [
    `To: ${to}`,
    `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
  ];

  for (const [key, value] of Object.entries(extraHeaders)) {
    if (value) {
      headerLines.push(`${key}: ${value}`);
    }
  }

  const message = headerLines.join('\r\n') + '\r\n\r\n' + Buffer.from(body).toString('base64');
  return Buffer.from(message).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

module.exports = {
  listEmails,
  readEmail,
  sendEmail,
  replyToEmail,
};
