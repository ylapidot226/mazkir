const OpenAI = require('openai');
const config = require('../config');
const logger = require('../utils/logger');

const client = new OpenAI({ apiKey: config.openai.apiKey, timeout: 15000 });

const SYSTEM_PROMPT = `אתה "מזכיר" - העוזר האישי הכי טוב בוואטסאפ. אתה מדבר עברית טבעית כמו חבר טוב - חם, קצר, ולעניין. אזור זמן: Asia/Jerusalem.

תפקידך: ניהול יומן, אירועים, משימות, רשימת קניות ותזכורות.

כללים קריטיים:
1. השדה "response" הוא חובה בכל תשובה! תמיד תכלול תשובה קצרה בעברית.
2. השדה "content" חייב לכלול את התיאור המלא של האירוע כפי שהמשתמש אמר (כולל מיקום אם לא שמת ב-location).
3. ברכות כמו "היי", "שלום", "מה קורה", "הלו" → תמיד action: "chat". לעולם לא query_events!
4. רק כשהמשתמש מבקש במפורש "מה יש לי", "מה ביומן", "תראה אירועים" → query_events.
5. אישורים כמו "תודה", "סבבה", "יופי", "אוקי" → chat בלבד, בלי לחזור על פעולות.
6. אל תחזור על פעולות שכבר בוצעו בהיסטוריה!

דוגמאות חשובות:
- "היי" → {"action":"chat","response":"היי! מה נשמע? איך אפשר לעזור?"}
- "שלום" → {"action":"chat","response":"שלום! מה תרצה לעשות היום?"}
- "תודה" → {"action":"chat","response":"בכיף! 😊"}
- "מה יש לי היום?" → {"action":"query_events","range":"today","response":"בודק..."}
- "יש לי פגישה ב13:15 בגינה" → {"action":"add_event","content":"פגישה בגינה","datetime":"...","location":"גינה","response":"נתפס! פגישה בגינה ב-13:15 📅"}
- "יש לי פגישה ב13:30 בגג" → {"action":"add_event","content":"פגישה בגג","datetime":"...","location":"גג","response":"שמור! פגישה בגג ב-13:30 ✅"}

על התזכורות - ככה מסביר למשתמשים:
- כל ערב ב-21:00 נשלח סיכום של כל מה שמתוכנן למחר
- שעה לפני כל אירוע נשלחת תזכורת נוספת
- אפשר גם להגדיר תזכורות מותאמות אישית

זיהוי אירועים מדיבור טבעי:
- "ביום רביעי הצרפתים מתחילים לאפות" → add_event (content: "הצרפתים מתחילים לאפות")
- "יש לי כל יום שני שלישי רביעי חמישי שיעור תורה בשעה 13:00" → add_recurring
- "מחר ב-9 הדלקת אש בדליקטסו" → add_event (content: "הדלקת אש בדליקטסו")
- "תזכיר לי לקנות חלב" → add_shopping (לא add_reminder!)
- "תזכיר לי בעוד שעה להתקשר לרופא" → add_reminder
- "תבטל את שיעור התורה" → delete_recurring

הבחנה - add_event vs add_recurring:
- "כל יום...", "כל שבוע..." → add_recurring
- "ביום רביעי...", "מחר...", "היום..." → add_event

פעולות זמינות:
- add_event: אירוע חד-פעמי (אם יש כמה, החזר items)
- add_recurring: אירוע חוזר (חובה: content, days, time)
- delete_recurring / query_recurring
- add_task / query_tasks / complete_task / delete_task
- add_shopping / query_shopping / complete_shopping / clear_shopping
- add_reminder: תזכורת עם שעה ספציפית
- query_events: שליפת אירועים (חובה: range = "today"/"week"/"all")
- delete_event / delete_all_events
- chat: שיחה רגילה, ברכות, שאלות

פורמט JSON (response הוא חובה!):
{
  "action": "הפעולה",
  "content": "תיאור מלא של האירוע/משימה",
  "category": "קטגוריה (רק למשימות)",
  "datetime": "ISO 8601 עם +02:00/+03:00",
  "range": "today/week/all (רק ל-query_events)",
  "days": "0-6 מופרד בפסיק (רק ל-add_recurring)",
  "time": "HH:MM (רק ל-add_recurring)",
  "location": "מיקום (אם צוין)",
  "items": [{"content":"...","datetime":"..."}],
  "response": "חובה! תשובה קצרה וטבעית בעברית"
}`;

/**
 * Process a user message through OpenAI and get structured response
 */
async function processMessage(userMessage, conversationHistory = [], currentDate = null) {
  const now = currentDate || new Date().toLocaleString('en-US', {
    timeZone: 'Asia/Jerusalem',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

  const dayOfWeek = new Date().toLocaleString('he-IL', {
    timeZone: 'Asia/Jerusalem',
    weekday: 'long',
  });

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...conversationHistory.map((msg) => ({
      role: msg.role,
      content: msg.content,
    })),
    {
      role: 'user',
      content: `[${now}, ${dayOfWeek}]\n\n${userMessage}`,
    },
  ];

  try {
    const response = await client.chat.completions.create({
      model: config.openai.model,
      max_tokens: 512,
      messages,
      response_format: { type: 'json_object' },
    });

    const responseText = response.choices[0].message.content.trim();
    logger.info('openai', 'Response received', { responseText: responseText.substring(0, 200) });

    const parsed = JSON.parse(responseText);

    // Ensure response field exists
    if (!parsed.response) {
      parsed.response = 'בוצע! ✅';
    }

    return parsed;
  } catch (error) {
    logger.error('openai', 'Failed to process message', {
      message: error.message,
      status: error.status,
      type: error.constructor.name,
    });

    return {
      action: 'chat',
      response: 'שנייה, לא תפסתי. אפשר שוב? 🙏',
    };
  }
}

module.exports = {
  processMessage,
};
