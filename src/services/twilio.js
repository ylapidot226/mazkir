const twilio = require('twilio');
const config = require('../config');
const logger = require('../utils/logger');

const client = twilio(config.twilio.accountSid, config.twilio.authToken);
const FROM_NUMBER = `whatsapp:${config.twilio.whatsappNumber}`;

/**
 * Convert Green API phone format (1234567890@c.us) to Twilio format (whatsapp:+1234567890)
 */
function toTwilioFormat(greenApiPhone) {
  if (!greenApiPhone) return greenApiPhone;
  // Already in Twilio format
  if (greenApiPhone.startsWith('whatsapp:')) return greenApiPhone;
  // Strip @c.us suffix
  const phone = greenApiPhone.replace('@c.us', '');
  return `whatsapp:+${phone}`;
}

/**
 * Convert Twilio phone format (whatsapp:+1234567890) to Green API format (1234567890@c.us)
 */
function toGreenApiFormat(twilioPhone) {
  if (!twilioPhone) return twilioPhone;
  // Already in Green API format
  if (twilioPhone.endsWith('@c.us')) return twilioPhone;
  // Strip whatsapp: prefix and + sign
  const phone = twilioPhone.replace('whatsapp:', '').replace('+', '');
  return `${phone}@c.us`;
}

/**
 * Show "typing..." indicator in the chat
 * Twilio doesn't support typing indicators - no-op
 */
async function sendTyping(chatId) {
  // No-op: Twilio WhatsApp API does not support typing indicators
}

/**
 * Send a WhatsApp text message via Twilio
 */
async function sendMessage(chatId, text) {
  try {
    const to = toTwilioFormat(chatId);
    const message = await client.messages.create({
      from: FROM_NUMBER,
      to,
      body: text,
    });
    logger.info('twilio', 'Message sent', { chatId, messageSid: message.sid });
    return { idMessage: message.sid };
  } catch (error) {
    logger.error('twilio', 'Failed to send message', error);
    throw error;
  }
}

/**
 * Parse incoming Twilio webhook data and extract sender + message
 *
 * Twilio POSTs form-encoded data with fields:
 *   Body, From (whatsapp:+1234567890), To, MessageSid, ProfileName, NumMedia
 */
function parseWebhook(body) {
  const from = body.From;
  const messageBody = body.Body;
  const messageSid = body.MessageSid;
  const profileName = body.ProfileName;
  const numMedia = parseInt(body.NumMedia || '0', 10);

  // Must be a WhatsApp message
  if (!from || !from.startsWith('whatsapp:')) {
    return null;
  }

  // Convert to Green API format for database compatibility
  const sender = toGreenApiFormat(from);
  const chatId = sender; // In Twilio, chatId is the same as sender for private chats

  // Handle media messages (no text body, but has media)
  if (!messageBody && numMedia > 0) {
    return {
      sender,
      chatId,
      senderName: profileName || '',
      text: null,
      isUnsupportedMedia: true,
      mediaType: 'imageMessage', // Generic media type
    };
  }

  // Must have text content
  if (!messageBody) {
    logger.info('twilio', 'Skipping empty message', { from, messageSid });
    return null;
  }

  return {
    sender,
    chatId,
    senderName: profileName || '',
    text: messageBody,
  };
}

/**
 * Send a poll-like message via Twilio
 * Twilio doesn't support WhatsApp polls, so we send a numbered list instead.
 * Returns null for pollMessageId since we can't track poll votes.
 */
async function sendPoll(chatId, question, options, multipleAnswers = true) {
  try {
    const numbered = options.map((opt, i) => `${i + 1}. ${opt}`).join('\n');
    const text = `${question}\n\n${numbered}\n\nהשב עם המספר כדי לסמן כבוצע.`;
    await sendMessage(chatId, text);
    // Return null - no poll message ID since Twilio doesn't support polls
    return null;
  } catch (error) {
    logger.error('twilio', 'Failed to send poll-like message', error);
    throw error;
  }
}

/**
 * Validate that a Twilio webhook request is authentic
 * Uses X-Twilio-Signature header validation
 */
function validateWebhook(req) {
  const twilioSignature = req.headers['x-twilio-signature'];
  if (!twilioSignature) return false;

  // Build the full URL that Twilio used to generate the signature
  const url = `${config.baseUrl}${req.originalUrl}`;

  return twilio.validateRequest(
    config.twilio.authToken,
    twilioSignature,
    url,
    req.body
  );
}

module.exports = {
  sendMessage,
  sendTyping,
  sendPoll,
  parseWebhook,
  validateWebhook,
  toTwilioFormat,
  toGreenApiFormat,
};
