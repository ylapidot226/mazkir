const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const greenApi = require('../services/greenApi');
const claude = require('../services/claude');
const db = require('../services/database');
const config = require('../config');
const logger = require('../utils/logger');

// Hebrew date formatting that works on all platforms
const DAYS_HE = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
const MONTHS_HE = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];

function formatDateHe(isoString) {
  const d = new Date(isoString);
  const il = new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }));
  const day = DAYS_HE[il.getDay()];
  const date = il.getDate();
  const month = MONTHS_HE[il.getMonth()];
  const hours = String(il.getHours()).padStart(2, '0');
  const minutes = String(il.getMinutes()).padStart(2, '0');
  return { day, date, month, time: `${hours}:${minutes}`, full: `יום ${day}, ${date} ב${month} בשעה ${hours}:${minutes}` };
}

// Rate limiting per IP (#5)
const webhookLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30, // 30 requests per minute per IP
  message: { error: 'Too many requests' },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Validate datetime string (#10)
 */
function isValidDatetime(dt) {
  if (!dt) return false;
  const d = new Date(dt);
  return !isNaN(d.getTime());
}

/**
 * Sanitize text for ilike queries - escape special pattern chars (#6)
 */
function sanitizeForLike(str) {
  if (!str) return str;
  return str.replace(/[%_\\]/g, (c) => '\\' + c);
}

/**
 * Verify webhook comes from Green API (#1)
 */
function verifyWebhook(req, res, next) {
  const webhookToken = config.greenApi.webhookToken;

  // If no token configured, skip verification (but log warning)
  if (!webhookToken) {
    return next();
  }

  // Green API sends instance ID in the body
  const instanceId = req.body?.instanceData?.idInstance?.toString();
  if (instanceId && instanceId === config.greenApi.instanceId) {
    return next();
  }

  // Also check custom token header if configured
  const headerToken = req.headers['x-webhook-token'];
  if (headerToken === webhookToken) {
    return next();
  }

  logger.warn('webhook', 'Unauthorized webhook attempt', { ip: req.ip });
  return res.status(403).json({ error: 'Forbidden' });
}

router.post('/whatsapp', webhookLimiter, verifyWebhook, async (req, res) => {
  try {
    const parsed = greenApi.parseWebhook(req.body);
    if (!parsed) {
      return res.status(200).json({ success: true });
    }

    const { sender, chatId, senderName, text, isPollUpdate, pollStanzaId, pollVotes } = parsed;

    // Handle poll vote updates (task completion via poll)
    if (isPollUpdate) {
      logger.info('webhook', 'Poll vote received', { sender, pollStanzaId });
      const user = await db.getUser(sender);
      if (user) {
        await handlePollVote(user.id, chatId, pollStanzaId, pollVotes);
      }
      return res.status(200).json({ success: true });
    }

    logger.info('webhook', 'Message received', { sender, senderName });

    // Check if user exists and is active
    const user = await db.getUser(sender);

    if (!user) {
      await greenApi.sendMessage(
        chatId,
        `שלום ${(senderName || '').replace(/<[^>]*>/g, '')} 👋\n\nכדי להשתמש במזכיר צריך להירשם קודם באתר:\nhttps://maztary.com\n\nנתראה שם! 😊`
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
      return res.status(200).json({ success: true });
    }

    // Get conversation history for context
    const history = await db.getRecentMessages(user.id, 4);

    // Process with AI
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
    logger.error('webhook', 'Error processing webhook', { message: error.message });
    return res.status(200).json({ success: true });
  }
});

/**
 * Handle poll vote - mark selected tasks as completed
 */
async function handlePollVote(userId, chatId, pollStanzaId, votes) {
  try {
    const mapping = await db.getPollMapping(userId, pollStanzaId);
    if (!mapping) return;

    const votedOptions = votes
      .filter((v) => v.optionVoters && v.optionVoters.length > 0)
      .map((v) => v.optionName);

    if (votedOptions.length === 0) return;

    let completedCount = 0;
    for (const taskContent of votedOptions) {
      const task = mapping.tasks.find((t) => t.content === taskContent);
      if (task) {
        await db.completeTask(userId, task.id);
        completedCount++;
      }
    }

    if (completedCount > 0) {
      const msg = completedCount === 1
        ? '✅ משימה אחת סומנה כבוצעה!'
        : `✅ ${completedCount} משימות סומנו כבוצעות!`;
      await greenApi.sendMessage(chatId, msg);
    }
  } catch (error) {
    logger.error('webhook', 'Failed to handle poll vote', { error: error.message });
  }
}

/**
 * Execute the action returned by AI
 */
async function executeAction(userId, chatId, aiResponse) {
  const { action, category, content, datetime, location, items, response } = aiResponse;

  try {
    switch (action) {
      case 'add_event':
        if (items && Array.isArray(items) && items.length > 0) {
          for (const item of items) {
            if (!isValidDatetime(item.datetime)) continue; // (#10)
            await db.addEvent(userId, item.content || content, item.datetime, item.location || location);
          }
        } else {
          if (!isValidDatetime(datetime)) break; // (#10)
          await db.addEvent(userId, content, datetime, location);
        }
        break;

      case 'add_task':
        await db.addTask(userId, category || 'כללי', content);
        break;

      case 'add_shopping': {
        const shoppingItems = items && Array.isArray(items) && items.length > 0
          ? items.map((i) => (typeof i === 'string' ? i : i.content).trim()).filter(Boolean)
          : content.split(',').map((i) => i.trim()).filter(Boolean);
        for (const item of shoppingItems) {
          await db.addShoppingItem(userId, item);
        }
        break;
      }

      case 'query_events': {
        const events = await db.getUpcomingEvents(userId);
        const recurring = await db.getUserRecurringEvents(userId);
        let msg = '';

        if (events.length > 0) {
          const formatted = events.map((e) => {
            const f = formatDateHe(e.datetime);
            const loc = e.location ? ` 📍 ${e.location}` : '';
            return `• ${e.title} - ${f.full}${loc}`;
          }).join('\n');
          msg += `📅 אירועים קרובים:\n\n${formatted}`;
        }

        if (recurring.length > 0) {
          const dayNames = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
          const formatted = recurring.map((r) => {
            const days = r.days.split(',').map((d) => dayNames[parseInt(d.trim())] || d.trim()).join(', ');
            const loc = r.location ? ` 📍 ${r.location}` : '';
            return `• ${r.title} - כל יום ${days} ב-${r.time}${loc}`;
          }).join('\n');
          msg += `${msg ? '\n\n' : ''}🔄 אירועים קבועים:\n\n${formatted}`;
        }

        if (!msg) msg = 'אין לך אירועים 📅';
        await greenApi.sendMessage(chatId, msg);
        return msg;
      }

      case 'query_tasks': {
        const tasks = await db.getTasks(userId, category);
        let msg;
        if (tasks.length === 0) {
          const catMsg = category ? ` בקטגוריה "${category}"` : '';
          msg = `אין משימות פתוחות${catMsg} ✅`;
          await greenApi.sendMessage(chatId, msg);
        } else {
          const options = tasks.slice(0, 12).map((t) => t.content);
          const question = category
            ? `📋 משימות - ${category}:`
            : '📋 המשימות שלך (סמן מה בוצע):';
          const pollResult = await greenApi.sendPoll(chatId, question, options);
          if (pollResult?.idMessage) {
            await db.savePollMapping(userId, pollResult.idMessage, tasks.slice(0, 12));
          }
          msg = question;
        }
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

      case 'delete_event': {
        const safeContent = sanitizeForLike(content); // (#6)
        const count = await db.deleteEventByContent(userId, safeContent);
        let msg;
        if (count > 0) {
          msg = `🗑️ ${count === 1 ? 'האירוע נמחק' : `${count} אירועים נמחקו`} בהצלחה!`;
        } else {
          msg = 'לא מצאתי אירוע מתאים למחיקה 🤔';
        }
        await greenApi.sendMessage(chatId, msg);
        return msg;
      }

      case 'delete_all_events': {
        const count = await db.deleteAllEvents(userId);
        let msg;
        if (count > 0) {
          msg = `🗑️ כל ${count} האירועים נמחקו בהצלחה!`;
        } else {
          msg = 'אין אירועים למחיקה 📅';
        }
        await greenApi.sendMessage(chatId, msg);
        return msg;
      }

      case 'delete_task': {
        const safeContent = sanitizeForLike(content); // (#6)
        const deleted = await db.deleteTaskByContent(userId, safeContent);
        let msg;
        if (deleted) {
          msg = `🗑️ המשימה "${deleted.content}" נמחקה!`;
        } else {
          msg = 'לא מצאתי משימה מתאימה למחיקה 🤔';
        }
        await greenApi.sendMessage(chatId, msg);
        return msg;
      }

      case 'add_recurring': {
        const days = aiResponse.days || '';
        const time = aiResponse.time || '';
        if (days && time && /^[\d,\s]+$/.test(days) && /^\d{1,2}:\d{2}$/.test(time)) {
          await db.addRecurringEvent(userId, content, days, time, location);
        }
        break;
      }

      case 'delete_recurring': {
        const safeContent = sanitizeForLike(content); // (#6)
        const deletedRecurring = await db.deleteRecurringEventByContent(userId, safeContent);
        let msg;
        if (deletedRecurring) {
          msg = `🗑️ האירוע החוזר "${deletedRecurring.title}" בוטל!`;
        } else {
          msg = 'לא מצאתי אירוע חוזר מתאים 🤔';
        }
        await greenApi.sendMessage(chatId, msg);
        return msg;
      }

      case 'query_recurring': {
        const recurring = await db.getUserRecurringEvents(userId);
        let msg;
        if (recurring.length === 0) {
          msg = 'אין לך אירועים חוזרים 🔄';
        } else {
          const dayNames = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
          const formatted = recurring.map((r) => {
            const days = r.days.split(',').map((d) => dayNames[parseInt(d.trim())] || d.trim()).join(', ');
            const loc = r.location ? ` 📍 ${r.location}` : '';
            return `• ${r.title} - כל יום ${days} ב-${r.time}${loc}`;
          }).join('\n');
          msg = `🔄 האירועים החוזרים שלך:\n\n${formatted}`;
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
        if (isValidDatetime(datetime)) { // (#10)
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
