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

מתי להחזיר פעולה שאינה chat:
- add_event: רק אם המשתמש מציין אירוע חדש עם זמן (לא חזרה על אירוע שכבר נוסף)
- add_task: רק אם המשתמש מבקש במפורש להוסיף משימה חדשה
- add_shopping: רק אם המשתמש מציין פריט חדש לקנייה
- query_events/query_tasks/query_shopping: רק אם המשתמש שואל מה יש לו/מה ברשימה
- complete_task/complete_shopping/clear_shopping: רק אם המשתמש מציין שסיים משהו
- add_reminder: רק אם מבקש תזכורת חדשה

פורמט JSON בלבד:
{
  "action": "add_event|add_task|add_shopping|query_events|query_tasks|query_shopping|complete_task|complete_shopping|clear_shopping|add_reminder|chat",
  "category": "שם קטגוריה (רק למשימות)",
  "content": "תוכן",
  "datetime": "ISO 8601 עם +02:00/+03:00 לפי שעון ישראל",
  "location": "מיקום (אם צוין)",
  "response": "תשובה בעברית, חמה וידידותית עם אימוג'י"
}`;

/**
 * Process a user message through OpenAI and get structured response
 */
async function processMessage(userMessage, conversationHistory = [], currentDate = null) {
  const now = currentDate || new Date().toLocaleString('en-IL', { timeZone: 'Asia/Jerusalem' });

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
      max_tokens: 1024,
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
