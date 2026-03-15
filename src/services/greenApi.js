const axios = require('axios');
const config = require('../config');
const logger = require('../utils/logger');

const API_BASE = config.greenApi.baseUrl;
const TOKEN = config.greenApi.token;

/**
 * Show "typing..." indicator in the chat
 */
async function sendTyping(chatId) {
  try {
    await axios.post(`${API_BASE}/sendTyping/${TOKEN}`, { chatId });
  } catch (error) {
    // Ignore typing errors - non-critical
  }
}

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

  // Extract message based on type
  const messageData = body.messageData;
  let text = null;

  if (messageData?.typeMessage === 'textMessage') {
    text = messageData.textMessageData?.textMessage;
  } else if (messageData?.typeMessage === 'extendedTextMessage') {
    text = messageData.extendedTextMessageData?.text;
  } else if (messageData?.typeMessage === 'quotedMessage') {
    // Reply to a specific message - extract text and include quoted context
    text = messageData.extendedTextMessageData?.text;
    const quotedText = messageData.quotedMessage?.textMessage;
    if (text && quotedText) {
      text = `[בתגובה ל: "${quotedText}"]\n${text}`;
    }
  } else if (messageData?.typeMessage === 'pollUpdateMessage') {
    // Poll vote received
    const pollData = messageData.pollMessageData;
    return {
      sender,
      chatId,
      senderName,
      text: null,
      isPollUpdate: true,
      pollStanzaId: pollData?.stanzaId,
      pollVotes: pollData?.votes || [],
    };
  }

  if (!text) {
    // Check if it's a media message type we should respond to
    const mediaTypes = ['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage', 'contactMessage', 'locationMessage'];
    if (mediaTypes.includes(messageData?.typeMessage)) {
      return {
        sender,
        chatId,
        senderName,
        text: null,
        isUnsupportedMedia: true,
        mediaType: messageData.typeMessage,
      };
    }
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

/**
 * Send a WhatsApp poll via Green API
 */
async function sendPoll(chatId, question, options, multipleAnswers = true) {
  try {
    const url = `${API_BASE}/sendPoll/${TOKEN}`;
    const response = await axios.post(url, {
      chatId,
      message: question,
      options: options.map((opt) => ({ optionName: opt })),
      multipleAnswers,
    });
    logger.info('greenApi', 'Poll sent', { chatId, messageId: response.data.idMessage });
    return response.data;
  } catch (error) {
    logger.error('greenApi', 'Failed to send poll', error);
    throw error;
  }
}

module.exports = {
  sendMessage,
  sendTyping,
  sendPoll,
  parseWebhook,
};
