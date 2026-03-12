const axios = require('axios');
const config = require('../config');
const logger = require('../utils/logger');

const API_BASE = config.greenApi.baseUrl;
const TOKEN = config.greenApi.token;

/**
 * Send a WhatsApp text message via Green API
 */
async function sendMessage(chatId, text) {
  try {
    const url = `${API_BASE}/sendMessage/${TOKEN}`;
    const response = await axios.post(url, {
      chatId,
      message: text,
    });
    logger.info('greenApi', 'Message sent', { chatId, messageId: response.data.idMessage });
    return response.data;
  } catch (error) {
    logger.error('greenApi', 'Failed to send message', error);
    throw error;
  }
}

/**
 * Parse incoming webhook data and extract sender + message
 */
function parseWebhook(body) {
  const typeWebhook = body.typeWebhook;

  // Only process incoming messages
  if (typeWebhook !== 'incomingMessageReceived') {
    return null;
  }

  const sender = body.senderData?.sender;
  const chatId = body.senderData?.chatId;
  const senderName = body.senderData?.senderName;

  // Filter out groups and status updates - only private chats
  if (!chatId || !chatId.endsWith('@c.us')) {
    logger.info('greenApi', 'Skipping non-private message', { chatId, typeWebhook });
    return null;
  }

  // Extract text message
  const messageData = body.messageData;
  let text = null;

  if (messageData?.typeMessage === 'textMessage') {
    text = messageData.textMessageData?.textMessage;
  } else if (messageData?.typeMessage === 'extendedTextMessage') {
    text = messageData.extendedTextMessageData?.text;
  }

  if (!text) {
    logger.info('greenApi', 'Skipping non-text message', { chatId, type: messageData?.typeMessage });
    return null;
  }

  return {
    sender,
    chatId,
    senderName,
    text,
  };
}

module.exports = {
  sendMessage,
  parseWebhook,
};
