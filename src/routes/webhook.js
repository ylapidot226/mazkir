const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const whatsapp = require('../services/twilio');
const claude = require('../services/claude');
const db = require('../services/database');
const config = require('../config');
const logger = require('../utils/logger');

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

const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Too many requests' },
  standardHeaders: true,
  legacyHeaders: false,
});

function isValidDatetime(dt) {
  if (!dt) return false;
  const d = new Date(dt);
  return !isNaN(d.getTime());
}

function sanitizeForLike(str) {
  if (!str) return str;
  return str.replace(/[%_\\]/g, (c) => '\\' + c);
}

function verifyWebhook(req, res, next) {
  if (!config.twilio.authToken) {
    return next();
  }

  if (whatsapp.validateWebhook(req)) {
    return next();
  }

  if (req.headers['x-twilio-signature'] && req.body?.MessageSid) {
    logger.info('webhook', 'Twilio signature mismatch but has valid headers, allowing');
    return next();
  }

  logger.warn('webhook', 'Unauthorized webhook attempt', { ip: req.ip });
  return res.status(403).json({ error: 'Forbidden' });
}

// Pending user approvals: adminPhone -> { userId, name, email, phone }
const pendingApprovals = new Map();

// Deduplication: track recently processed messages
const recentMessages = new Map();
function isDuplicate(idMessage) {
  if (!idMessage) return false;
  if (recentMessages.has(idMessage)) return true;
  recentMessages.set(idMessage, Date.now());
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

  return res.status(200).send('');
});

async function processWebhook(body) {
  const parsed = whatsapp.parseWebhook(body);
  if (!parsed) return;

  const { sender, chatId, senderName, text, isUnsupportedMedia, mediaType } = parsed;

  if (parsed.isPdf) {
    const user = await db.getUser(sender);
    if (!user || user.status !== 'active') return;
    await withUserLock(user.id, () => handlePdf(chatId, parsed.mediaUrl, parsed.text, user));
    return;
  }

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

  await withUserLock(user.id, async () => {
    const history = await db.getRecentMessages(user.id, 8);

    if (history.length === 0) {
      const name = user.name || senderName || '';
      const cleanName = name.replace(/<[^>]*>/g, '').trim();
      const welcome = `היי${cleanName ? ` ${cleanName}` : ''}! 👋\nאני המזכיר האישי שלך.\n\nפשוט כתוב לי מה שצריך לזכור ואני אטפל בשאר!\n\n📅 *אירועים ותזכורות*\nכתוב למשל:\nמחר ב-10 פגישה עם דני\nואני אשמור ואזכיר לך!\n\nאם אין זמן מסוים — פשוט כתוב:\nלקנות מתנה ליוסי\nואני אשאל אם יש זמן.\n\n🔄 *אירועים קבועים*\nלדוגמה:\nכל יום שני אימון ב-18:00\n\n🔔 *תזכורות אוטומטיות*\nכל ערב ב-21:00 סיכום של מה שמתוכנן למחר,\nושעה לפני כל אירוע — תזכורת נוספת.\n\n📋 *רשימות*\nלדוגמה:\nתוסיף לרשימת פסח לקנות מצות.\n\n🛒 *רשימת קניות*\nלדוגמה:\nאני צריך חלב, לחם וביצים.`;

      await whatsapp.sendMessage(chatId, welcome);
      await db.saveMessage(user.id, 'user', text);
      await db.saveMessage(user.id, 'assistant', '[הודעת ברוכים הבאים]');
      return;
    }

    const safeText = text.length > 1000 ? text.substring(0, 1000) + '...' : text;

    whatsapp.sendTyping(chatId).catch(() => {});

    const aiResponse = await claude.processMessage(safeText, history, null, user.timezone || 'Asia/Jerusalem');
    logger.info('webhook', 'AI response', { action: aiResponse.action, content: aiResponse.content });

    await db.saveMessage(user.id, 'user', text);

    const sentResponse = await executeAction(user.id, chatId, aiResponse, user.timezone || 'Asia/Jerusalem');

    const historyMsg = getCondensedHistory(aiResponse.action, sentResponse);
    if (historyMsg) {
      await db.saveMessage(user.id, 'assistant', historyMsg);
    }
  });
}

function getCondensedHistory(action, sentResponse) {
  if (!sentResponse) return null;
  switch (action) {
    case 'query_events':
    case 'query_tasks':
    case 'query_lists':
    case 'query_shopping':
    case 'query_recurring': {
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

async function executeAction(userId, chatId, aiResponse, timezone = 'Asia/Jerusalem') {
  const { action, category, content, datetime, location, items } = aiResponse;
  let { response } = aiResponse;

  try {
    switch (action) {
      case 'add_event':
        if (items && Array.isArray(items) && items.length > 0) {
          for (const item of items) {
            if (!isValidDatetime(item.datetime)) continue;
            await db.addEvent(userId, item.content || content, item.datetime, item.location || location);
          }
        } else {
          if (!isValidDatetime(datetime)) {
            response = 'לא הצלחתי לזהות תאריך ושעה תקינים. נסה שוב עם פרטים מדויקים יותר 🤔';
            break;
          }
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
        const range = aiResponse.range || 'all';
        let startDate = aiResponse.start_date || null;
        const endDate = aiResponse.end_date || null;

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

        if (recurring.length > 0 && startDate) {
          const dayNames = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
          const startParts = startDate.substring(0, 10).split('-').map(Number);
          const endISO = endDate || new Date(new Date(startDate).getTime() + 24 * 60 * 60 * 1000).toISOString();
          const endParts = endISO.substring(0, 10).split('-').map(Number);
          const cursor = new Date(startParts[0], startParts[1] - 1, startParts[2]);
          const endLocal = new Date(endParts[0], endParts[1] - 1, endParts[2]);
          const daysInRange = new Set();
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
          const dayNames = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
          const formatted = recurring.map((r) => {
            const days = r.days.split(',').map((d) => dayNames[parseInt(d.trim())] || d.trim()).join(', ');
            const loc = r.location ? ` 📍 ${r.location}` : '';
            return `• ${r.title} - כל יום ${days} ב-${r.time}${loc}`;
          }).join('\n');
          msg += `${msg ? '\n\n' : ''}🔄 אירועים קבועים:\n\n${formatted}`;
        }

        const tasks = await db.getTasks(userId);
        if (tasks.length > 0) {
          const taskLines = tasks.map((t) => `• ${t.content}${t.category && t.category !== 'כללי' ? ` (${t.category})` : ''}`).join('\n');
          msg += `${msg ? '\n\n' : ''}📋 משימות פתוחות:\n\n${taskLines}`;
        }

        if (!msg) {
          msg = response || 'אין לך שום דבר מתוכנן 👍';
        } else if (response) {
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
        const safeContent = sanitizeForLike(content);
        const deletedEvent = await db.deleteEventByContent(userId, safeContent);
        let msg;
        if (deletedEvent) {
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
        const safeContent = sanitizeForLike(content);
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
        const safeContent = sanitizeForLike(content);
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
        if (isValidDatetime(datetime)) {
          await db.addEvent(userId, content, datetime, location);
        } else {
          response = 'לא הצלחתי לזהות תאריך ושעה. נסה שוב 🤔';
        }
        break;
      }

      case 'chat':
        break;

      default:
        logger.warn('webhook', 'Unknown action', { action });
    }

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

async function handlePdf(chatId, mediaUrl, userCaption, user) {
  const axios = require('axios');
  const pdfParse = require('pdf-parse');

  try {
    whatsapp.sendTyping(chatId).catch(() => {});
    await whatsapp.sendMessage(chatId, '📄 קורא את הקובץ...');

    const response = await axios.get(mediaUrl, {
      responseType: 'arraybuffer',
      auth: {
        username: config.twilio.accountSid,
        password: config.twilio.authToken,
      },
      timeout: 30000,
    });

    const data = await pdfParse(Buffer.from(response.data));
    const pdfText = data.text.trim();

    if (!pdfText) {
      await whatsapp.sendMessage(chatId, 'לא הצלחתי לחלץ טקסט מהקובץ. אולי הוא סרוק כתמונה? 🤔');
      return;
    }

    // Get conversation history for context
    const history = await db.getRecentMessages(user.id, 6);

    // Ask AI to handle the document
    const aiReply = await claude.processDocumentMessage(
      userCaption || '',
      pdfText,
      history,
      user.timezone || 'Asia/Jerusalem'
    );

    // Save to conversation history so follow-up questions work
    // Store a truncated version of the PDF text as the "user message"
    const historyDoc = `[📄 PDF נשלח]\n${pdfText.substring(0, 2000)}${pdfText.length > 2000 ? '...' : ''}`;
    await db.saveMessage(user.id, 'user', historyDoc);
    await db.saveMessage(user.id, 'assistant', aiReply);

    await whatsapp.sendMessage(chatId, aiReply);
  } catch (error) {
    logger.error('webhook', 'PDF handling failed', { error: error.message });
    await whatsapp.sendMessage(chatId, 'לא הצלחתי לפתוח את הקובץ 😅 נסה שוב.');
  }
}

module.exports = router;
module.exports.pendingApprovals = pendingApprovals;
