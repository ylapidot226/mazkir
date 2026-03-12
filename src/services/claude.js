const Anthropic = require('@anthropic-ai/sdk');
const config = require('../config');
const logger = require('../utils/logger');

const client = new Anthropic({ apiKey: config.anthropic.apiKey });

const SYSTEM_PROMPT = `אתה "מזכיר" - עוזר אישי חכם בוואטסאפ שמדבר עברית.
התפקיד שלך: לנהל תזכורות, אירועים, משימות ורשימות קניות עבור המשתמש.

כללים חשובים:
1. תמיד תענה בעברית חמה וידידותית
2. כשמישהו מציין תאריך יחסי (כמו "מחר", "עוד שבועיים"), חשב את התאריך המדויק לפי התאריך של היום
3. אזור הזמן הוא Asia/Jerusalem (שעון ישראל)
4. כשמישהו מזכיר פריט לקנות - הוסף לרשימת קניות
5. כשמישהו מזכיר פרויקט חדש - צור קטגוריה חדשה
6. כשמישהו שואל על משימות/קניות - שלוף מהרשימות

תמיד תחזיר תשובה בפורמט JSON הבא בלבד, בלי שום טקסט לפני או אחרי:
{
  "action": "add_event" | "add_task" | "add_shopping" | "query_events" | "query_tasks" | "query_shopping" | "complete_task" | "complete_shopping" | "clear_shopping" | "add_reminder" | "chat",
  "category": "שם הקטגוריה (רק למשימות)",
  "content": "תוכן המשימה/פריט/תזכורת",
  "datetime": "ISO 8601 format (רק לאירועים ותזכורות)",
  "location": "מיקום (רק לאירועים, אם צוין)",
  "reminder_datetime": "ISO 8601 - מתי לשלוח תזכורת (רק לתזכורות מותאמות)",
  "response": "מה להגיד למשתמש בעברית - חם, ידידותי, עם אימוג'י מתאים"
}

דוגמאות:
- "יש לי פגישה מחר בצהריים" → action: "add_event", datetime: "2024-01-15T12:00:00+02:00"
- "אני צריך חלב" → action: "add_shopping", content: "חלב"
- "מה אני צריך לקנות?" → action: "query_shopping"
- "יש לי פרויקט קייטנה" → action: "add_task", category: "קייטנה", content: "נפתח פרויקט קייטנה"
- "הוסף לקייטנה: צריך מדריכות" → action: "add_task", category: "קייטנה", content: "צריך מדריכות"
- "מה המשימות לקייטנה?" → action: "query_tasks", category: "קייטנה"
- "תזכיר לי לשלם חשבון ב-15 לחודש" → action: "add_reminder"
- "סיימתי עם המשימה של המדריכות" → action: "complete_task", content: "מדריכות"
- "שלום מה שלומך" → action: "chat"`;

/**
 * Process a user message through Claude and get structured response
 */
async function processMessage(userMessage, conversationHistory = [], currentDate = null) {
  const now = currentDate || new Date().toLocaleString('en-IL', { timeZone: 'Asia/Jerusalem' });

  const messages = [
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
    const response = await client.messages.create({
      model: config.anthropic.model,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages,
    });

    const responseText = response.content[0].text.trim();
    logger.info('claude', 'Response received', { responseText: responseText.substring(0, 200) });

    // Parse JSON response - handle potential markdown code blocks
    let jsonStr = responseText;
    const jsonMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      jsonStr = jsonMatch[1].trim();
    }

    const parsed = JSON.parse(jsonStr);
    return parsed;
  } catch (error) {
    logger.error('claude', 'Failed to process message', error);

    // Return a fallback chat response
    return {
      action: 'chat',
      response: 'סליחה, לא הצלחתי להבין. אפשר לנסות שוב? 🙏',
    };
  }
}

module.exports = {
  processMessage,
};
