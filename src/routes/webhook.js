const express = require('express');
const router = express.Router();
const greenApi = require('../services/greenApi');
const claude = require('../services/claude');
const db = require('../services/database');
const logger = require('../utils/logger');

router.post('/whatsapp', async (req, res) => {
  try {
    const parsed = greenApi.parseWebhook(req.body);
    if (!parsed) {
      return res.status(200).json({ success: true });
    }

    const { sender, chatId, senderName, text } = parsed;
    logger.info('webhook', 'Message received', { sender, senderName, text: text.substring(0, 100) });

    // Check if user exists and is active
    const user = await db.getUser(sender);

    if (!user) {
      // Not registered - send to website
      await greenApi.sendMessage(
        chatId,
        `שלום ${senderName || ''} 👋\n\nכדי להשתמש במזכיר צריך להירשם קודם באתר:\nhttps://mazkir.vercel.app\n\nנתראה שם! 😊`
      );
      logger.info('webhook', 'Unknown user directed to website', { sender });
      return res.status(200).json({ success: true });
    }

    if (user.status === 'pending') {
      await greenApi.sendMessage(
        chatId,
        'הבקשה שלך עדיין ממתינה לאישור ⏳\nנעדכן אותך במייל ברגע שתאושר!'
      );
      return res.status(200).json({ success: true });
    }

    if (user.status === 'blocked') {
      logger.info('webhook', 'Blocked user tried to send message', { sender });
      return res.status(200).json({ success: true });
    }

    // Get conversation history for context
    const history = await db.getRecentMessages(user.id, 10);

    // Get current context data for enriching AI response
    const [events, categories, shoppingList] = await Promise.all([
      db.getUpcomingEvents(user.id),
      db.getCategories(user.id),
      db.getShoppingList(user.id),
    ]);

    const contextInfo = `
[הקשר נוכחי]
אירועים קרובים: ${events.length > 0 ? events.map((e) => `${e.title} (${new Date(e.datetime).toLocaleDateString('he-IL')})`).join(', ') : 'אין'}
קטגוריות משימות: ${categories.length > 0 ? categories.join(', ') : 'אין'}
פריטים ברשימת קניות: ${shoppingList.length > 0 ? shoppingList.map((s) => s.item).join(', ') : 'ריקה'}
`;

    // Process with Claude
    const enrichedMessage = `${contextInfo}\n${text}`;
    const aiResponse = await claude.processMessage(enrichedMessage, history);

    // Save user message
    await db.saveMessage(user.id, 'user', text);

    // Execute the action
    await executeAction(user.id, chatId, aiResponse);

    // Save assistant response
    await db.saveMessage(user.id, 'assistant', aiResponse.response);

    return res.status(200).json({ success: true });
  } catch (error) {
    logger.error('webhook', 'Error processing webhook', error);
    return res.status(200).json({ success: true });
  }
});

/**
 * Execute the action returned by Claude
 */
async function executeAction(userId, chatId, aiResponse) {
  const { action, category, content, datetime, location, reminder_datetime, response } = aiResponse;

  try {
    switch (action) {
      case 'add_event':
        await db.addEvent(userId, content, datetime, location);
        if (reminder_datetime) {
          await db.addReminder(userId, `תזכורת: ${content}`, reminder_datetime);
        }
        break;

      case 'add_task':
        await db.addTask(userId, category || 'כללי', content);
        break;

      case 'add_shopping':
        const items = content.split(',').map((i) => i.trim()).filter(Boolean);
        for (const item of items) {
          await db.addShoppingItem(userId, item);
        }
        break;

      case 'query_events': {
        const events = await db.getUpcomingEvents(userId);
        if (events.length === 0) {
          await greenApi.sendMessage(chatId, 'אין לך אירועים קרובים 📅');
          return;
        }
        break;
      }

      case 'query_tasks': {
        const tasks = await db.getTasks(userId, category);
        if (tasks.length === 0) {
          const catMsg = category ? ` בקטגוריה "${category}"` : '';
          await greenApi.sendMessage(chatId, `אין משימות פתוחות${catMsg} ✅`);
          return;
        }
        break;
      }

      case 'query_shopping': {
        const list = await db.getShoppingList(userId);
        if (list.length === 0) {
          await greenApi.sendMessage(chatId, 'רשימת הקניות ריקה! 🛒');
          return;
        }
        break;
      }

      case 'complete_task':
        await db.completeTaskByContent(userId, category, content);
        break;

      case 'complete_shopping':
        await db.markShoppingDone(userId, content);
        break;

      case 'clear_shopping':
        await db.clearShoppingList(userId);
        break;

      case 'add_reminder':
        if (datetime) {
          await db.addReminder(userId, content, datetime);
        }
        break;

      case 'chat':
        break;

      default:
        logger.warn('webhook', 'Unknown action', { action });
    }

    if (response) {
      await greenApi.sendMessage(chatId, response);
    }
  } catch (error) {
    logger.error('webhook', 'Failed to execute action', { action, error: error.message });
    await greenApi.sendMessage(chatId, 'אופס, משהו השתבש 😅 אפשר לנסות שוב?');
  }
}

module.exports = router;
