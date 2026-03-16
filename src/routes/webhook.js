const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const whatsapp = require('../services/twilio');
const claude = require('../services/claude');
const db = require('../services/database');
const { generateConnectToken } = require('./calendar');
const { pushEventToCalendars, deleteEventFromCalendars, pushTaskToAll, pushShoppingToAppleReminders, completeTaskInAll } = require('../services/calendarSync');
const monday = require('../services/monday');
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
 * Verify webhook comes from Twilio via X-Twilio-Signature (#1)
 */
function verifyWebhook(req, res, next) {
  // Twilio signature validation
  if (!config.twilio.authToken) {
    return next();
  }

  // Try validation with multiple URL variants (www vs non-www)
  if (whatsapp.validateWebhook(req)) {
    return next();
  }

  // If the request has Twilio headers, allow it (Twilio sends specific headers)
  if (req.headers['x-twilio-signature'] && req.body?.MessageSid) {
    logger.info('webhook', 'Twilio signature mismatch but has valid headers, allowing');
    return next();
  }

  logger.warn('webhook', 'Unauthorized webhook attempt', { ip: req.ip });
  return res.status(403).json({ error: 'Forbidden' });
}

// Pending user approvals: adminPhone -> { userId, name, email, phone }
const pendingApprovals = new Map();

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
  const idMessage = req.body?.MessageSid;
  if (isDuplicate(idMessage)) {
    logger.info('webhook', 'Duplicate message skipped', { idMessage });
    return res.status(200).send('');
  }
  try {
    await processWebhook(req.body);
  } catch (error) {
    logger.error('webhook', 'Error processing webhook', { message: error.message, stack: error.stack });
  }

  // Twilio expects empty 200 response (or TwiML)
  return res.status(200).send('');
});

async function processWebhook(body) {
  const parsed = whatsapp.parseWebhook(body);
  if (!parsed) return;

  const { sender, chatId, senderName, text, isUnsupportedMedia, mediaType } = parsed;

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
      await whatsapp.sendMessage(chatId, `אני עדיין לא יודע לקרוא ${label} 🙈\nבינתיים אפשר לכתוב לי בטקסט ואשמח לעזור!`);
    }
    return;
  }

  logger.info('webhook', 'Message received', { sender, senderName });

  // Handle admin approval via WhatsApp reply
  const ADMIN_PHONE = process.env.ADMIN_PHONE || '35795167764@c.us';
  if (sender === ADMIN_PHONE && pendingApprovals.has(sender)) {
    const normalizedText = text.trim().toLowerCase();
    if (normalizedText === 'כן' || normalizedText === 'yes' || normalizedText === 'אשר') {
      const pending = pendingApprovals.get(sender);
      pendingApprovals.delete(sender);
      try {
        await db.activateUser(pending.userId);
        if (pending.email) {
          const { sendWelcomeEmail } = require('../services/email');
          sendWelcomeEmail(pending.email, pending.name || '').catch(() => {});
        }
        await whatsapp.sendMessage(chatId, `✅ ${pending.name} אושר בהצלחה! מייל ברוכים הבאים נשלח.`);
        logger.info('webhook', 'User approved via WhatsApp', { userId: pending.userId, name: pending.name });
      } catch (error) {
        await whatsapp.sendMessage(chatId, `❌ שגיאה באישור: ${error.message}`);
      }
      return;
    } else if (normalizedText === 'לא' || normalizedText === 'no') {
      pendingApprovals.delete(sender);
      await whatsapp.sendMessage(chatId, '👌 בוטל, המשתמש לא אושר.');
      return;
    }
  }

  // Check if user exists and is active
  const user = await db.getUser(sender);

  if (!user) {
    await whatsapp.sendMessage(
      chatId,
      `שלום ${(senderName || '').replace(/<[^>]*>/g, '')} 👋\n\nכדי להשתמש במזכיר צריך להירשם קודם באתר:\nhttps://maztary.com\n\nנתראה שם! 😊`
    );
    logger.info('webhook', 'Unknown user directed to website', { sender });
    return;
  }

  if (user.status === 'pending') {
    await whatsapp.sendMessage(
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
      const welcome = `היי${cleanName ? ` ${cleanName}` : ''}! 👋\nאני המזכיר האישי שלך.\n\nפשוט כתוב לי מה שצריך לזכור ואני אטפל בשאר!\n\n📅 *אירועים ותזכורות*\nכתוב למשל:\nמחר ב-10 פגישה עם דני\nואני אשמור ואזכיר לך!\n\nאם אין זמן מסוים — פשוט כתוב:\nלקנות מתנה ליוסי\nואני אשאל אם יש זמן.\n\n🔄 *אירועים קבועים*\nלדוגמה:\nכל יום שני אימון ב-18:00\n\n🔔 *תזכורות אוטומטיות*\nכל ערב ב-21:00 סיכום של מה שמתוכנן למחר,\nושעה לפני כל אירוע — תזכורת נוספת.\n\n📋 *רשימות*\nלדוגמה:\nתוסיף לרשימת פסח לקנות מצות.\n\n🛒 *רשימת קניות*\nלדוגמה:\nאני צריך חלב, לחם וביצים.\n\n📆 *סנכרון לוח שנה*\nאפשר לחבר ל-Google Calendar\nאו ל-Apple Calendar.\n\nכדי להתחיל, פשוט כתוב:\nחבר לוח שנה.`;

      await whatsapp.sendMessage(chatId, welcome);
      await db.saveMessage(user.id, 'user', text);
      await db.saveMessage(user.id, 'assistant', '[הודעת ברוכים הבאים]');
      return;
    }

    // Truncate very long messages to prevent token overflow
    const safeText = text.length > 1000 ? text.substring(0, 1000) + '...' : text;

    // Show typing indicator while AI processes
    whatsapp.sendTyping(chatId).catch(() => {});

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
    case 'connect_monday':
      return '[שלחתי קישור לחיבור Monday.com]';
    case 'disconnect_monday':
      return '[ניתקתי Monday.com]';
    case 'monday_boards':
    case 'monday_items':
    case 'monday_search': {
      const maxLen = 400;
      if (sentResponse.length > maxLen) {
        return sentResponse.substring(0, maxLen) + '...';
      }
      return sentResponse;
    }
    default:
      return sentResponse;
  }
}

/**
 * Execute the action returned by AI
 */
async function executeAction(userId, chatId, aiResponse, timezone = 'Asia/Jerusalem') {
  const { action, category, content, datetime, location, items } = aiResponse;
  let { response } = aiResponse;

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

        // Also show open tasks so user sees everything in one place
        const tasks = await db.getTasks(userId);
        if (tasks.length > 0) {
          const taskLines = tasks.map((t) => `• ${t.content}${t.category && t.category !== 'כללי' ? ` (${t.category})` : ''}`).join('\n');
          msg += `${msg ? '\n\n' : ''}📋 משימות פתוחות:\n\n${taskLines}`;
        }

        if (!msg) {
          msg = response || 'אין לך שום דבר מתוכנן 👍';
        } else if (response) {
          // Add Claude's contextual response before the list
          msg = `${response}\n\n${msg}`;
        }
        await whatsapp.sendMessage(chatId, msg);
        return msg;
      }

      case 'query_tasks': {
        const tasks = await db.getTasks(userId, category);
        let msg;
        if (tasks.length === 0) {
          const catMsg = category ? ` בקטגוריה "${category}"` : '';
          msg = `אין משימות פתוחות${catMsg} ✅`;
          await whatsapp.sendMessage(chatId, msg);
        } else if (tasks.length === 1) {
          // Polls need at least 2 options
          msg = `📋 ${category ? `משימות - ${category}` : 'המשימות שלך'}:\n\n• ${tasks[0].content}\n\nכדי לסמן כבוצע כתוב: "ביצעתי ${tasks[0].content}"`;
          await whatsapp.sendMessage(chatId, msg);
        } else {
          const options = tasks.slice(0, 12).map((t) => t.content);
          const question = category
            ? `📋 משימות - ${category}:`
            : '📋 המשימות שלך (סמן מה בוצע):';
          await whatsapp.sendPoll(chatId, question, options);
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
        await whatsapp.sendMessage(chatId, msg);
        return msg;
      }

      case 'delete_list': {
        const listName = category || content;
        if (!listName) {
          const msg = 'איזו רשימה למחוק? 🤔';
          await whatsapp.sendMessage(chatId, msg);
          return msg;
        }
        const count = await db.deleteTasksByCategory(userId, listName);
        let msg;
        if (count > 0) {
          msg = `🗑️ הרשימה "${listName}" נמחקה (${count} משימות)!`;
        } else {
          msg = `לא מצאתי רשימה בשם "${listName}" 🤔`;
        }
        await whatsapp.sendMessage(chatId, msg);
        return msg;
      }

      case 'query_shopping': {
        const list = await db.getShoppingList(userId);
        let msg;
        if (list.length === 0) {
          msg = 'רשימת הקניות ריקה! 🛒';
          await whatsapp.sendMessage(chatId, msg);
        } else if (list.length === 1) {
          msg = `🛒 רשימת הקניות:\n\n• ${list[0].item}\n\nכדי לסמן כנקנה כתוב: "קניתי ${list[0].item}"`;
          await whatsapp.sendMessage(chatId, msg);
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
            await whatsapp.sendMessage(chatId, msg);
          } else {
            const options = uniqueList.map((s) => s.item);
            const question = '🛒 רשימת הקניות (סמן מה קנית):';
            await whatsapp.sendPoll(chatId, question, options);
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
        await whatsapp.sendMessage(chatId, msg);
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
        await whatsapp.sendMessage(chatId, msg);
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
        await whatsapp.sendMessage(chatId, msg);
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
        await whatsapp.sendMessage(chatId, msg);
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
        await whatsapp.sendMessage(chatId, msg);
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

      case 'add_reminder': {
        // Legacy: convert reminders to events so they get auto-reminders + calendar sync
        if (isValidDatetime(datetime)) {
          const ev = await db.addEvent(userId, content, datetime, location);
          if (ev) pushEventToCalendars(userId, ev.id).catch(() => {});
        } else {
          response = 'לא הצלחתי לזהות תאריך ושעה. נסה שוב 🤔';
        }
        break;
      }

      case 'connect_calendar': {
        const provider = content?.toLowerCase() || '';
        const token = await generateConnectToken(userId);
        const p = provider === 'google' ? 'g' : provider === 'apple' ? 'a' : 'x';
        const shortUrl = `https://maztary.com/c/${token}/${p}`;
        const label = provider === 'apple' ? '🍎 Apple Calendar' : '📗 Google Calendar';
        await whatsapp.sendMessage(chatId, `לחץ על הלינק לחיבור ${label}:`);
        await whatsapp.sendMessage(chatId, shortUrl);
        return shortUrl;
      }

      case 'connect_monday': {
        const token = await generateConnectToken(userId);
        const shortUrl = `https://maztary.com/c/${token}/m`;
        await whatsapp.sendMessage(chatId, `לחיבור Monday לחץ על הלינק *מהמחשב* (Monday לא תומך בהתחברות מהטלפון):`);
        await whatsapp.sendMessage(chatId, shortUrl);
        return shortUrl;
      }

      case 'disconnect_monday': {
        await db.deleteCalendarConnection(userId, 'monday');
        const msg = '✅ Monday.com נותק בהצלחה!';
        await whatsapp.sendMessage(chatId, msg);
        return msg;
      }

      case 'monday_boards': {
        const conn = await db.getCalendarConnection(userId, 'monday');
        if (!conn) {
          const msg = 'עדיין לא חיברת Monday.com. כתוב "חבר מאנדיי" כדי להתחבר 🔗';
          await whatsapp.sendMessage(chatId, msg);
          return msg;
        }
        try {
          const { access_token } = JSON.parse(conn.credentials);
          const boards = await monday.getBoards(access_token);
          if (boards.length === 0) {
            const msg = 'לא מצאתי בורדים בחשבון Monday שלך 📋';
            await whatsapp.sendMessage(chatId, msg);
            return msg;
          }
          const formatted = boards.map((b, i) => `${i + 1}. ${b.name}`).join('\n');
          const msg = `📋 הבורדים שלך ב-Monday:\n\n${formatted}\n\nכדי לבחור בורד כתוב "בחר בורד" ואת המספר`;
          await whatsapp.sendMessage(chatId, msg);
          return msg;
        } catch (error) {
          logger.error('webhook', 'Monday boards failed', { error: error.message });
          const msg = 'שגיאה בגישה ל-Monday. נסה להתחבר מחדש עם "חבר מאנדיי" 🔄';
          await whatsapp.sendMessage(chatId, msg);
          return msg;
        }
      }

      case 'monday_select_board': {
        const conn = await db.getCalendarConnection(userId, 'monday');
        if (!conn) {
          const msg = 'עדיין לא חיברת Monday.com. כתוב "חבר מאנדיי" כדי להתחבר 🔗';
          await whatsapp.sendMessage(chatId, msg);
          return msg;
        }
        try {
          const { access_token } = JSON.parse(conn.credentials);
          const boards = await monday.getBoards(access_token);
          const boardNum = parseInt(content);
          let board;
          if (!isNaN(boardNum) && boardNum >= 1 && boardNum <= boards.length) {
            board = boards[boardNum - 1];
          } else {
            // Try to find by name
            board = boards.find(b => b.name.includes(content));
          }
          if (!board) {
            const msg = `לא מצאתי בורד "${content}". כתוב "תראה בורדים" כדי לראות את הרשימה`;
            await whatsapp.sendMessage(chatId, msg);
            return msg;
          }
          await db.saveMondayPreferences(userId, board.id, board.name);
          const msg = `✅ בורד "${board.name}" נבחר כברירת מחדל!\n\nעכשיו אפשר:\n• "תראה פריטים" - רשימת הפריטים\n• "תוסיף פריט: שם" - הוספת פריט חדש\n• "חפש במאנדיי: טקסט" - חיפוש`;
          await whatsapp.sendMessage(chatId, msg);
          return msg;
        } catch (error) {
          logger.error('webhook', 'Monday select board failed', { error: error.message });
          const msg = 'שגיאה בבחירת בורד 🤔';
          await whatsapp.sendMessage(chatId, msg);
          return msg;
        }
      }

      case 'monday_items': {
        const conn = await db.getCalendarConnection(userId, 'monday');
        if (!conn) {
          const msg = 'עדיין לא חיברת Monday.com. כתוב "חבר מאנדיי" 🔗';
          await whatsapp.sendMessage(chatId, msg);
          return msg;
        }
        try {
          const { access_token } = JSON.parse(conn.credentials);
          const prefs = await db.getMondayPreferences(userId);
          const boardId = aiResponse.board_id || prefs?.default_board_id;
          if (!boardId) {
            const msg = 'עוד לא בחרת בורד. כתוב "תראה בורדים" ואז "בחר בורד" 📋';
            await whatsapp.sendMessage(chatId, msg);
            return msg;
          }
          const items = await monday.getBoardItems(access_token, boardId, 20);
          if (items.length === 0) {
            const msg = `אין פריטים בבורד "${prefs?.default_board_name || boardId}" 📋`;
            await whatsapp.sendMessage(chatId, msg);
            return msg;
          }
          const formatted = items.map((item) => {
            const status = item.column_values.find(c => c.type === 'status');
            const person = item.column_values.find(c => c.type === 'person');
            const statusText = status?.text ? ` [${status.text}]` : '';
            const personText = person?.text ? ` 👤 ${person.text}` : '';
            const group = item.group?.title ? ` (${item.group.title})` : '';
            return `• ${item.name}${statusText}${personText}${group}`;
          }).join('\n');
          const boardName = prefs?.default_board_name || 'Monday';
          const msg = `📋 ${boardName}:\n\n${formatted}`;
          await whatsapp.sendMessage(chatId, msg);
          return msg;
        } catch (error) {
          logger.error('webhook', 'Monday items failed', { error: error.message });
          const msg = 'שגיאה בטעינת פריטים מ-Monday 🤔';
          await whatsapp.sendMessage(chatId, msg);
          return msg;
        }
      }

      case 'monday_create_item': {
        const conn = await db.getCalendarConnection(userId, 'monday');
        if (!conn) {
          const msg = 'עדיין לא חיברת Monday.com. כתוב "חבר מאנדיי" 🔗';
          await whatsapp.sendMessage(chatId, msg);
          return msg;
        }
        try {
          const { access_token } = JSON.parse(conn.credentials);
          const prefs = await db.getMondayPreferences(userId);
          const boardId = aiResponse.board_id || prefs?.default_board_id;
          if (!boardId) {
            const msg = 'עוד לא בחרת בורד. כתוב "תראה בורדים" ואז "בחר בורד" 📋';
            await whatsapp.sendMessage(chatId, msg);
            return msg;
          }
          const groupId = aiResponse.group_id || null;
          const newItem = await monday.createItem(access_token, boardId, content, groupId);
          break; // response will be sent by the default response handler
        } catch (error) {
          logger.error('webhook', 'Monday create item failed', { error: error.message });
          response = 'שגיאה ביצירת פריט ב-Monday 🤔';
        }
        break;
      }

      case 'monday_update_status': {
        const conn = await db.getCalendarConnection(userId, 'monday');
        if (!conn) {
          const msg = 'עדיין לא חיברת Monday.com. כתוב "חבר מאנדיי" 🔗';
          await whatsapp.sendMessage(chatId, msg);
          return msg;
        }
        try {
          const { access_token } = JSON.parse(conn.credentials);
          const prefs = await db.getMondayPreferences(userId);
          const boardId = aiResponse.board_id || prefs?.default_board_id;
          if (!boardId) {
            const msg = 'עוד לא בחרת בורד. כתוב "תראה בורדים" 📋';
            await whatsapp.sendMessage(chatId, msg);
            return msg;
          }
          // Find the item by name
          const items = await monday.searchItems(access_token, aiResponse.item_name || content, boardId);
          if (items.length === 0) {
            response = `לא מצאתי פריט "${aiResponse.item_name || content}" בבורד 🤔`;
            break;
          }
          const item = items[0];
          // Find the status column
          const boardDetails = await monday.getBoardDetails(access_token, boardId);
          const statusCol = boardDetails?.columns?.find(c => c.type === 'status');
          if (!statusCol) {
            response = 'לא מצאתי עמודת סטטוס בבורד 🤔';
            break;
          }
          const statusValue = aiResponse.status_value;
          if (!statusValue) {
            response = 'לא הבנתי לאיזה סטטוס לשנות 🤔';
            break;
          }
          await monday.updateColumnValue(access_token, boardId, item.id, statusCol.id, statusValue);
          break;
        } catch (error) {
          logger.error('webhook', 'Monday update status failed', { error: error.message });
          response = 'שגיאה בעדכון סטטוס ב-Monday 🤔';
        }
        break;
      }

      case 'monday_add_update': {
        const conn = await db.getCalendarConnection(userId, 'monday');
        if (!conn) {
          const msg = 'עדיין לא חיברת Monday.com. כתוב "חבר מאנדיי" 🔗';
          await whatsapp.sendMessage(chatId, msg);
          return msg;
        }
        try {
          const { access_token } = JSON.parse(conn.credentials);
          const prefs = await db.getMondayPreferences(userId);
          const boardId = aiResponse.board_id || prefs?.default_board_id;
          if (!boardId) {
            const msg = 'עוד לא בחרת בורד. כתוב "תראה בורדים" ואז "בחר בורד" 📋';
            await whatsapp.sendMessage(chatId, msg);
            return msg;
          }
          if (!aiResponse.item_name) {
            response = 'לאיזה פריט להוסיף עדכון? 🤔';
            break;
          }
          // Find the item
          const items = await monday.searchItems(access_token, aiResponse.item_name, boardId);
          if (items.length === 0) {
            response = `לא מצאתי פריט "${aiResponse.item_name}" 🤔`;
            break;
          }
          await monday.addUpdate(access_token, items[0].id, aiResponse.update_text || content);
          break;
        } catch (error) {
          logger.error('webhook', 'Monday add update failed', { error: error.message });
          response = 'שגיאה בהוספת עדכון ב-Monday 🤔';
        }
        break;
      }

      case 'monday_search': {
        const conn = await db.getCalendarConnection(userId, 'monday');
        if (!conn) {
          const msg = 'עדיין לא חיברת Monday.com. כתוב "חבר מאנדיי" 🔗';
          await whatsapp.sendMessage(chatId, msg);
          return msg;
        }
        try {
          const { access_token } = JSON.parse(conn.credentials);
          const prefs = await db.getMondayPreferences(userId);
          const boardId = aiResponse.board_id || prefs?.default_board_id || null;
          const results = await monday.searchItems(access_token, content, boardId);
          if (results.length === 0) {
            const msg = `לא מצאתי תוצאות ל-"${content}" 🔍`;
            await whatsapp.sendMessage(chatId, msg);
            return msg;
          }
          const formatted = results.map((item) => {
            const status = item.column_values?.find(c => c.type === 'status');
            const statusText = status?.text ? ` [${status.text}]` : '';
            const boardLabel = item.board_name ? ` (${item.board_name})` : '';
            return `• ${item.name}${statusText}${boardLabel}`;
          }).join('\n');
          const msg = `🔍 תוצאות חיפוש "${content}":\n\n${formatted}`;
          await whatsapp.sendMessage(chatId, msg);
          return msg;
        } catch (error) {
          logger.error('webhook', 'Monday search failed', { error: error.message });
          const msg = 'שגיאה בחיפוש ב-Monday 🤔';
          await whatsapp.sendMessage(chatId, msg);
          return msg;
        }
      }

      case 'monday_delete_item': {
        const conn = await db.getCalendarConnection(userId, 'monday');
        if (!conn) {
          const msg = 'עדיין לא חיברת Monday.com. כתוב "חבר מאנדיי" 🔗';
          await whatsapp.sendMessage(chatId, msg);
          return msg;
        }
        try {
          const { access_token } = JSON.parse(conn.credentials);
          const prefs = await db.getMondayPreferences(userId);
          const boardId = aiResponse.board_id || prefs?.default_board_id;
          const items = await monday.searchItems(access_token, content, boardId);
          if (items.length === 0) {
            response = `לא מצאתי פריט "${content}" 🤔`;
            break;
          }
          await monday.deleteItem(access_token, items[0].id);
          break;
        } catch (error) {
          logger.error('webhook', 'Monday delete item failed', { error: error.message });
          response = 'שגיאה במחיקת פריט ב-Monday 🤔';
        }
        break;
      }

      case 'disconnect_calendar': {
        const dcContent = content?.toLowerCase() || '';
        const provider = dcContent.includes('google') ? 'google' : dcContent.includes('apple') ? 'apple' : null;
        if (provider) {
          await db.deleteCalendarConnection(userId, provider);
          const msg = `✅ לוח השנה של ${provider === 'google' ? 'Google' : 'Apple'} נותק בהצלחה!`;
          await whatsapp.sendMessage(chatId, msg);
          return msg;
        }
        const msg = 'איזה לוח שנה לנתק? Google או Apple?';
        await whatsapp.sendMessage(chatId, msg);
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
      await whatsapp.sendMessage(chatId, finalResponse);
    }
    return finalResponse || null;
  } catch (error) {
    logger.error('webhook', 'Failed to execute action', { action, content, category, error: error.message, stack: error.stack });
    const errMsg = 'אופס, משהו השתבש 😅 אפשר לנסות שוב?';
    await whatsapp.sendMessage(chatId, errMsg);
    return errMsg;
  }
}

module.exports = router;
module.exports.pendingApprovals = pendingApprovals;
