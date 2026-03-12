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
    const history = await db.getRecentMessages(user.id, 4);

    // Process with Claude - send only the user text, no context enrichment
    // Context was causing the AI to re-trigger actions from previous conversations
    const aiResponse = await claude.processMessage(text, history);

    // Save user message
    await db.saveMessage(user.id, 'user', text);

    // Execute the action and get the response that was actually sent
    const sentResponse = await executeAction(user.id, chatId, aiResponse);

    // Save the actual response that was sent to the user
    if (sentResponse) {
      await db.saveMessage(user.id, 'assistant', sentResponse);
    }

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

      case 'add_shopping': {
        const items = content.split(',').map((i) => i.trim()).filter(Boolean);
        for (const item of items) {
          await db.addShoppingItem(userId, item);
        }
        break;
      }

      case 'query_events': {
        const events = await db.getUpcomingEvents(userId);
        let msg;
        if (events.length === 0) {
          msg = 'אין לך אירועים קרובים 📅';
        } else {
          const formatted = events.map((e) => {
            const d = new Date(e.datetime);
            const dateStr = d.toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Asia/Jerusalem' });
            const timeStr = d.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jerusalem' });
            const loc = e.location ? ` 📍 ${e.location}` : '';
            return `• ${e.title} - ${dateStr} בשעה ${timeStr}${loc}`;
          }).join('\n');
          msg = `📅 האירועים הקרובים שלך:\n\n${formatted}`;
        }
        await greenApi.sendMessage(chatId, msg);
        return msg;
      }

      case 'query_tasks': {
        const tasks = await db.getTasks(userId, category);
        let msg;
        if (tasks.length === 0) {
          const catMsg = category ? ` בקטגוריה "${category}"` : '';
          msg = `אין משימות פתוחות${catMsg} ✅`;
        } else {
          const grouped = {};
          for (const t of tasks) {
            if (!grouped[t.category]) grouped[t.category] = [];
            grouped[t.category].push(t.content);
          }
          msg = '📋 המשימות שלך:\n';
          for (const [cat, items] of Object.entries(grouped)) {
            msg += `\n*${cat}:*\n`;
            msg += items.map((item) => `• ${item}`).join('\n');
          }
        }
        await greenApi.sendMessage(chatId, msg);
        return msg;
      }

      case 'query_shopping': {
        const list = await db.getShoppingList(userId);
        let msg;
        if (list.length === 0) {
          msg = 'רשימת הקניות ריקה! 🛒';
        } else {
          const formatted = list.map((s) => `• ${s.item}`).join('\n');
          msg = `🛒 רשימת הקניות:\n\n${formatted}`;
        }
        await greenApi.sendMessage(chatId, msg);
        return msg;
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
    return response || null;
  } catch (error) {
    logger.error('webhook', 'Failed to execute action', { action, error: error.message });
    const errMsg = 'אופס, משהו השתבש 😅 אפשר לנסות שוב?';
    await greenApi.sendMessage(chatId, errMsg);
    return errMsg;
  }
}

module.exports = router;
