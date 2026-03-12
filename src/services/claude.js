const OpenAI = require('openai');
const config = require('../config');
const logger = require('../utils/logger');

const client = new OpenAI({ apiKey: config.openai.apiKey, timeout: 8000 });

const SYSTEM_PROMPT = `אתה "מזכיר" - עוזר אישי בוואטסאפ. עברית בלבד. אזור זמן: Asia/Jerusalem.

חוק עליון - מתי להחזיר action: "chat":
- אישורים: "מעולה", "טוב", "תודה", "אוקי", "סבבה", "יופי", "אחלה", "מצוין", "בסדר", "נהדר", "👍" → תמיד chat
- שיחה רגילה, שאלות כלליות, ברכות → תמיד chat
- אם המשתמש לא מבקש במפורש להוסיף/לשנות/למחוק/לשלוף → תמיד chat
- גם אם בהיסטוריה יש הוספה קודמת, אל תחזור עליה! אישור = chat בלבד

פעולות זמינות:
- add_event: אירוע חדש עם זמן
- add_task: משימה חדשה (עם category)
- add_shopping: פריט/ים לקניות
- query_events / query_tasks / query_shopping: שליפת רשימות
- complete_task / complete_shopping: סימון כבוצע
- clear_shopping: ניקוי כל רשימת הקניות
- delete_event: מחיקת אירוע ספציפי (content = חלק מהשם)
- delete_all_events: מחיקת כל האירועים
- delete_task: מחיקת משימה (content = חלק מהתוכן)
- add_reminder: תזכורת חדשה
- chat: שיחה רגילה

פורמט JSON בלבד:
{
  "action": "הפעולה",
  "category": "שם קטגוריה (רק למשימות)",
  "content": "תוכן/שם האירוע",
  "datetime": "ISO 8601 עם +02:00/+03:00 לפי שעון ישראל",
  "location": "מיקום (אם צוין)",
  "response": "תשובה בעברית, חמה וידידותית עם אימוג'י"
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

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...conversationHistory.map((msg) => ({
      role: msg.role,
      content: msg.content,
    })),
    {
      role: 'user',
      content: `[תאריך ושעה נוכחיים: ${now}]\n\nהודעת המשתמש: ${userMessage}`,
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
    return parsed;
  } catch (error) {
    logger.error('openai', 'Failed to process message', {
      message: error.message,
      status: error.status,
      type: error.constructor.name,
    });

    return {
      action: 'chat',
      response: 'סליחה, לא הצלחתי להבין. אפשר לנסות שוב? 🙏',
    };
  }
}

module.exports = {
  processMessage,
};
