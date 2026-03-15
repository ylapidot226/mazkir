const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const greenApi = require('../services/greenApi');
const claude = require('../services/claude');
const db = require('../services/database');
const { generateConnectToken } = require('./calendar');
const { pushEventToCalendars, deleteEventFromCalendars, pushTaskToAll, pushShoppingToAppleReminders, completeTaskInAll } = require('../services/calendarSync');
const config = require('../config');
const logger = require('../utils/logger');

// Hebrew date formatting that works on all platforms
const DAYS_HE = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
const MONTHS_HE = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];

function formatDateHe(isoString, timezone = 'Asia/Jerusalem') {
  const d = new Date(isoString);
  const il = new Date(d.toLocaleString('en-US', { timeZone: timezone }));
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

// Deduplication: track recently processed messages to avoid duplicates
const recentMessages = new Map();
function isDuplicate(idMessage) {
  if (!idMessage) return false;
  if (recentMessages.has(idMessage)) return true;
  recentMessages.set(idMessage, Date.now());
  // Cleanup old entries (older than 5 minutes)
  if (recentMessages.size > 200) {
    const cutoff = Date.now() - 5 * 60 * 1000;
    for (const [k, v] of recentMessages) {
      if (v < cutoff) recentMessages.delete(k);
    }
  }
  return false;
}

// Per-user processing lock to prevent race conditions
const userLocks = new Map();
async function withUserLock(userId, fn) {
  while (userLocks.get(userId)) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  userLocks.set(userId, true);
  try {
    return await fn();
  } finally {
    userLocks.delete(userId);
  }
}

router.post('/whatsapp', webhookLimiter, verifyWebhook, async (req, res) => {
  const idMessage = req.body?.messageData?.idMessage || req.body?.idMessage;
  if (isDuplicate(idMessage)) {
    logger.info('webhook', 'Duplicate message skipped', { idMessage });
    return res.status(200).json({ success: true });
  }
  try {
    await processWebhook(req.body);
  } catch (error) {
    logger.error('webhook', 'Error processing webhook', { message: error.message, stack: error.stack });
  }

  return res.status(200).json({ success: true });
});

async function processWebhook(body) {
  const parsed = greenApi.parseWebhook(body);
  if (!parsed) return;

  const { sender, chatId, senderName, text, isPollUpdate, pollStanzaId, pollVotes, isUnsupportedMedia, mediaType } = parsed;

  // Handle poll vote updates (task completion via poll)
  if (isPollUpdate) {
    logger.info('webhook', 'Poll vote received', { sender, pollStanzaId });
    const user = await db.getUser(sender);
    if (user) {
      await handlePollVote(user.id, chatId, pollStanzaId, pollVotes);
    }
    return;
  }

  // Handle unsupported media messages
  if (isUnsupportedMedia) {
    const user = await db.getUser(sender);
    if (user && user.status === 'active') {
      const mediaLabels = {
        imageMessage: 'תמונות',
        videoMessage: 'סרטונים',
        audioMessage: 'הודעות קוליות',
        documentMessage: 'מסמכים',
        stickerMessage: 'מדבקות',
        contactMessage: 'אנשי קשר',
        locationMessage: 'מיקומים',
      };
      const label = mediaLabels[mediaType] || 'קבצים';
      await greenApi.sendMessage(chatId, `אני עדיין לא יודע לקרוא ${label} 🙈\nבינתיים אפשר לכתוב לי בטקסט ואשמח לעזור!`);
    }
    return;
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
    return;
  }

  if (user.status === 'pending') {
    await greenApi.sendMessage(
      chatId,
      'הבקשה שלך עדיין ממתינה לאישור ⏳\nנעדכן אותך במייל ברגע שתאושר!'
    );
    return;
  }

  if (user.status === 'blocked') return;

  // Process with per-user lock to prevent race conditions
  await withUserLock(user.id, async () => {
    // Get conversation history for context
    const history = await db.getRecentMessages(user.id, 8);

    // First-time user: send welcome message with all features
    if (history.length === 0) {
      const name = user.name || senderName || '';
      const cleanName = name.replace(/<[^>]*>/g, '').trim();
      const welcome = `היי${cleanName ? ` ${cleanName}` : ''}! 👋\nאני המזכיר האישי שלך.\n\nאני יכול לעזור לך לנהל יומן, תזכורות, משימות ורשימות — פשוט על-ידי הודעה קצרה.\n\n📅 *יומן ואירועים*\nכתוב למשל:\nמחר ב-10 פגישה עם דני\nואני אשמור את האירוע ביומן.\n\nרוצה לראות מה מתוכנן?\nכתוב:\nמה יש לי מחר\nואציג לך את כל האירועים.\n\n🔄 *אירועים קבועים*\nאפשר להגדיר אירועים שחוזרים.\nלדוגמה:\nכל יום שני אימון ב-18:00\nואני אוסיף אותו אוטומטית.\n\n🔔 *תזכורות*\nאני שולח סיכום יומי כל ערב ב-21:00,\nותזכורת שעה לפני כל אירוע.\n\nצריך תזכורת מיוחדת?\nכתוב:\nתזכיר לי מחר ב-15:00 להתקשר לרופא.\n\n📋 *משימות ורשימות*\nאפשר להוסיף משימות ורשימות.\nלדוגמה:\nתוסיף לרשימת פסח לקנות מצות.\n\n🛒 *רשימת קניות*\nאפשר גם להוסיף קניות.\nלדוגמה:\nאני צריך חלב, לחם וביצים.\n\n📆 *סנכרון לוח שנה*\nאפשר לחבר ל-Google Calendar\nאו ל-Apple Calendar.\n\nכדי להתחיל, פשוט כתוב:\nחבר לוח שנה.`;

      await greenApi.sendMessage(chatId, welcome);
      await db.saveMessage(user.id, 'user', text);
      await db.saveMessage(user.id, 'assistant', '[הודעת ברוכים הבאים]');
      return;
    }

    // Truncate very long messages to prevent token overflow
    const safeText = text.length > 1000 ? text.substring(0, 1000) + '...' : text;

    // Show typing indicator while AI processes
    greenApi.sendTyping(chatId).catch(() => {});

    // Process with AI
    const aiResponse = await claude.processMessage(safeText, history, null, user.timezone || 'Asia/Jerusalem');
    logger.info('webhook', 'AI response', { action: aiResponse.action, content: aiResponse.content, days: aiResponse.days, time: aiResponse.time, category: aiResponse.category });

    // Save user message
    await db.saveMessage(user.id, 'user', text);

    // Execute the action and get the response that was actually sent
    const sentResponse = await executeAction(user.id, chatId, aiResponse, user.timezone || 'Asia/Jerusalem');

    // Save condensed history for query actions to prevent AI context pollution
    const historyMsg = getCondensedHistory(aiResponse.action, sentResponse);
    if (historyMsg) {
      await db.saveMessage(user.id, 'assistant', historyMsg);
    }
  });
}

/**
 * Return a condensed version of the response for conversation history.
 * Prevents full event/task lists from polluting the AI context.
 */
function getCondensedHistory(action, sentResponse) {
  if (!sentResponse) return null;
  switch (action) {
    case 'query_events':
    case 'query_tasks':
    case 'query_lists':
    case 'query_shopping':
    case 'query_recurring': {
      // Keep the actual response but truncate if too long
      const maxLen = 400;
      if (sentResponse.length > maxLen) {
        return sentResponse.substring(0, maxLen) + '...';
      }
      return sentResponse;
    }
    case 'connect_calendar':
      return '[שלחתי קישור לחיבור לוח שנה]';
    case 'disconnect_calendar':
      return '[ניתקתי לוח שנה]';
    default:
      return sentResponse;
  }
}

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
    for (const itemContent of votedOptions) {
      const item = mapping.tasks.find((t) => t.content === itemContent);
      if (item) {
        if (item.type === 'shopping') {
          await db.markShoppingDoneById(userId, item.id);
        } else {
          await db.completeTask(userId, item.id);
        }
        // Complete in connected providers if synced
        if (item.external_id) {
          completeTaskInAll(userId, item.external_id, item.source).catch(() => {});
        }
        completedCount++;
      }
    }

    if (completedCount > 0) {
      const isShopping = mapping.tasks[0]?.type === 'shopping';
      const msg = isShopping
        ? completedCount === 1 ? '✅ פריט אחד סומן כנקנה!' : `✅ ${completedCount} פריטים סומנו כנקנו!`
        : completedCount === 1 ? '✅ משימה אחת סומנה כבוצעה!' : `✅ ${completedCount} משימות סומנו כבוצעות!`;
      await greenApi.sendMessage(chatId, msg);
    }
  } catch (error) {
    logger.error('webhook', 'Failed to handle poll vote', { error: error.message });
  }
}

/**
 * Execute the action returned by AI
 */
async function executeAction(userId, chatId, aiResponse, timezone = 'Asia/Jerusalem') {
  const { action, category, content, datetime, location, items, response } = aiResponse;

  try {
    switch (action) {
      case 'add_event':
        if (items && Array.isArray(items) && items.length > 0) {
          for (const item of items) {
            if (!isValidDatetime(item.datetime)) continue; // (#10)
            const ev = await db.addEvent(userId, item.content || content, item.datetime, item.location || location);
            if (ev) pushEventToCalendars(userId, ev.id).catch(() => {});
          }
        } else {
          if (!isValidDatetime(datetime)) {
            response = 'לא הצלחתי לזהות תאריך ושעה תקינים. נסה שוב עם פרטים מדויקים יותר 🤔';
            break;
          }
          const ev = await db.addEvent(userId, content, datetime, location);
          if (ev) pushEventToCalendars(userId, ev.id).catch(() => {});
        }
        break;

      case 'add_task': {
        const newTask = await db.addTask(userId, category || 'כללי', content);
        if (newTask) pushTaskToAll(userId, newTask.id).catch(() => {});
        break;
      }

      case 'add_shopping': {
        const shoppingItems = items && Array.isArray(items) && items.length > 0
          ? items.map((i) => (typeof i === 'string' ? i : i.content).trim()).filter(Boolean)
          : content.split(',').map((i) => i.trim()).filter(Boolean);
        for (const item of shoppingItems) {
          const newItem = await db.addShoppingItem(userId, item);
          if (newItem) pushShoppingToAppleReminders(userId, newItem.id).catch(() => {});
        }
        break;
      }

      case 'query_events': {
        const range = aiResponse.range || 'all';
        let startDate = aiResponse.start_date || null;
        const endDate = aiResponse.end_date || null;

        // Use current time as start to avoid showing events that already passed
        if (startDate) {
          const now = new Date();
          const queryStart = new Date(startDate);
          if (now > queryStart) {
            startDate = now.toISOString();
          }
        }

        const events = await db.getUpcomingEventsByDateRange(userId, startDate, endDate);
        const recurring = await db.getUserRecurringEvents(userId);

        let msg = '';

        if (events.length > 0) {
          const formatted = events.map((e) => {
            const f = formatDateHe(e.datetime, timezone);
            const loc = e.location && e.location !== 'Asia/Jerusalem' ? ` 📍 ${e.location}` : '';
            return `• ${e.title} - ${f.full}${loc}`;
          }).join('\n');
          const labels = { today: 'אירועים להיום', tomorrow: 'אירועים למחר', week: 'אירועים לשבוע הקרוב', specific_day: 'אירועים', all: 'אירועים קרובים' };
          msg += `📅 ${labels[range] || 'אירועים'}:\n\n${formatted}`;
        }

        // Show recurring events filtered by the relevant days in the date range
        if (recurring.length > 0 && startDate) {
          const dayNames = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

          const start = new Date(startDate);
          const end = endDate ? new Date(endDate) : new Date(start.getTime() + 24 * 60 * 60 * 1000);

          // Collect all day-of-week numbers in the date range
          // Parse date parts directly from ISO string to avoid UTC conversion issues
          function localDayFromISO(isoStr) {
            const [y, m, d] = isoStr.substring(0, 10).split('-').map(Number);
            return new Date(y, m - 1, d).getDay();
          }
          const daysInRange = new Set();
          // Walk day by day using date-only strings to stay timezone-safe
          const startParts = startDate.substring(0, 10).split('-').map(Number);
          const endISO = endDate || new Date(new Date(startDate).getTime() + 24 * 60 * 60 * 1000).toISOString();
          const endParts = endISO.substring(0, 10).split('-').map(Number);
          const cursor = new Date(startParts[0], startParts[1] - 1, startParts[2]);
          const endLocal = new Date(endParts[0], endParts[1] - 1, endParts[2]);
          while (cursor <= endLocal) {
            daysInRange.add(cursor.getDay().toString());
            cursor.setDate(cursor.getDate() + 1);
          }

          const filteredRecurring = recurring.filter((r) =>
            r.days.split(',').some((d) => daysInRange.has(d.trim()))
          );

          if (filteredRecurring.length > 0) {
            const formatted = filteredRecurring.map((r) => {
              const days = r.days.split(',').map((d) => dayNames[parseInt(d.trim())] || d.trim()).join(', ');
              const loc = r.location ? ` 📍 ${r.location}` : '';
              return `• ${r.title} - כל יום ${days} ב-${r.time}${loc}`;
            }).join('\n');
            msg += `${msg ? '\n\n' : ''}🔄 אירועים קבועים:\n\n${formatted}`;
          }
        } else if (recurring.length > 0 && !startDate) {
          // No date filter - show all recurring
          const dayNames = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
          const formatted = recurring.map((r) => {
            const days = r.days.split(',').map((d) => dayNames[parseInt(d.trim())] || d.trim()).join(', ');
            const loc = r.location ? ` 📍 ${r.location}` : '';
            return `• ${r.title} - כל יום ${days} ב-${r.time}${loc}`;
          }).join('\n');
          msg += `${msg ? '\n\n' : ''}🔄 אירועים קבועים:\n\n${formatted}`;
        }

        if (!msg) {
          const emptyLabels = { today: 'אין לך אירועים היום', tomorrow: 'אין לך אירועים מחר', specific_day: 'אין לך אירועים ביום הזה', week: 'אין לך אירועים השבוע' };
          msg = response || (emptyLabels[range] || 'אין לך אירועים') + ' 📅';
        } else if (response) {
          // Add Claude's contextual response before the event list
          msg = `${response}\n\n${msg}`;
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
          await greenApi.sendMessage(chatId, msg);
        } else if (tasks.length === 1) {
          // Polls need at least 2 options
          msg = `📋 ${category ? `משימות - ${category}` : 'המשימות שלך'}:\n\n• ${tasks[0].content}\n\nכדי לסמן כבוצע כתוב: "ביצעתי ${tasks[0].content}"`;
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

      case 'query_lists': {
        const counts = await db.getCategoriesWithCounts(userId);
        let msg;
        const entries = Object.entries(counts);
        if (entries.length === 0) {
          msg = 'אין לך רשימות פעילות כרגע 📋';
        } else {
          const formatted = entries.map(([cat, count]) => `• ${cat} (${count} משימות)`).join('\n');
          msg = `📋 הרשימות שלך:\n\n${formatted}`;
        }
        await greenApi.sendMessage(chatId, msg);
        return msg;
      }

      case 'delete_list': {
        const listName = category || content;
        if (!listName) {
          const msg = 'איזו רשימה למחוק? 🤔';
          await greenApi.sendMessage(chatId, msg);
          return msg;
        }
        const count = await db.deleteTasksByCategory(userId, listName);
        let msg;
        if (count > 0) {
          msg = `🗑️ הרשימה "${listName}" נמחקה (${count} משימות)!`;
        } else {
          msg = `לא מצאתי רשימה בשם "${listName}" 🤔`;
        }
        await greenApi.sendMessage(chatId, msg);
        return msg;
      }

      case 'query_shopping': {
        const list = await db.getShoppingList(userId);
        let msg;
        if (list.length === 0) {
          msg = 'רשימת הקניות ריקה! 🛒';
          await greenApi.sendMessage(chatId, msg);
        } else if (list.length === 1) {
          msg = `🛒 רשימת הקניות:\n\n• ${list[0].item}\n\nכדי לסמן כנקנה כתוב: "קניתי ${list[0].item}"`;
          await greenApi.sendMessage(chatId, msg);
        } else {
          // Deduplicate items for poll (polls don't allow duplicate option names)
          const seen = new Set();
          const uniqueList = [];
          for (const s of list.slice(0, 12)) {
            if (!seen.has(s.item)) {
              seen.add(s.item);
              uniqueList.push(s);
            }
          }

          if (uniqueList.length < 2) {
            msg = `🛒 רשימת הקניות:\n\n• ${uniqueList[0].item}\n\nכדי לסמן כנקנה כתוב: "קניתי ${uniqueList[0].item}"`;
            await greenApi.sendMessage(chatId, msg);
          } else {
            const options = uniqueList.map((s) => s.item);
            const question = '🛒 רשימת הקניות (סמן מה קנית):';
            const pollResult = await greenApi.sendPoll(chatId, question, options);
            if (pollResult?.idMessage) {
              await db.savePollMapping(userId, pollResult.idMessage,
                uniqueList.map((s) => ({ id: s.id, content: s.item, type: 'shopping' }))
              );
            }
            msg = question;
          }
        }
        return msg;
      }

      case 'delete_event': {
        const safeContent = sanitizeForLike(content); // (#6)
        const deletedEvent = await db.deleteEventByContent(userId, safeContent);
        let msg;
        if (deletedEvent) {
          if (deletedEvent.external_id) {
            deleteEventFromCalendars(userId, deletedEvent.external_id, deletedEvent.source).catch(() => {});
          }
          msg = '🗑️ האירוע נמחק בהצלחה!';
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
        const recurTitle = content || aiResponse.title || '';
        const days = aiResponse.days || '';
        const time = aiResponse.time || '';
        if (recurTitle && days && time && /^[\d,\s]+$/.test(days) && /^\d{1,2}:\d{2}$/.test(time)) {
          await db.addRecurringEvent(userId, recurTitle, days, time, location);
        } else {
          logger.warn('webhook', 'add_recurring missing fields', { content: recurTitle, days, time });
          response = 'לא הצלחתי להבין את הפרטים של האירוע החוזר. נסה שוב 🤔';
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
        } else {
          response = 'לא הצלחתי לזהות תאריך ושעה לתזכורת. נסה שוב 🤔';
        }
        break;

      case 'connect_calendar': {
        const provider = content?.toLowerCase() || '';
        const token = await generateConnectToken(userId);
        const p = provider === 'google' ? 'g' : provider === 'apple' ? 'a' : 'x';
        const shortUrl = `https://maztary.com/c/${token}/${p}`;
        const label = provider === 'apple' ? '🍎 Apple Calendar' : '📗 Google Calendar';
        await greenApi.sendMessage(chatId, `לחץ על הלינק לחיבור ${label}:`);
        await greenApi.sendMessage(chatId, shortUrl);
        return shortUrl;
      }

      case 'disconnect_calendar': {
        const provider = content?.includes('google') ? 'google' : content?.includes('apple') ? 'apple' : null;
        if (provider) {
          await db.deleteCalendarConnection(userId, provider);
          const msg = `✅ לוח השנה של ${provider === 'google' ? 'Google' : 'Apple'} נותק בהצלחה!`;
          await greenApi.sendMessage(chatId, msg);
          return msg;
        }
        const msg = 'איזה לוח שנה לנתק? Google או Apple?';
        await greenApi.sendMessage(chatId, msg);
        return msg;
      }

      case 'chat':
        break;

      default:
        logger.warn('webhook', 'Unknown action', { action });
    }

    // Execute additional actions if present (e.g. task linked to an event)
    if (aiResponse.additional_actions && Array.isArray(aiResponse.additional_actions)) {
      for (const extra of aiResponse.additional_actions) {
        try {
          await executeAction(userId, chatId, { ...extra, response: null }, timezone);
        } catch (err) {
          logger.warn('webhook', 'Failed to execute additional action', { action: extra.action, error: err.message });
        }
      }
    }

    const finalResponse = response || (action !== 'chat' ? 'בוצע! ✅' : null);
    if (finalResponse) {
      await greenApi.sendMessage(chatId, finalResponse);
    }
    return finalResponse || null;
  } catch (error) {
    logger.error('webhook', 'Failed to execute action', { action, content, category, error: error.message, stack: error.stack });
    const errMsg = 'אופס, משהו השתבש 😅 אפשר לנסות שוב?';
    await greenApi.sendMessage(chatId, errMsg);
    return errMsg;
  }
}

module.exports = router;
