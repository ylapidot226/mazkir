const db = require('./database');
const greenApi = require('./greenApi');
const logger = require('../utils/logger');
const config = require('../config');

const ADMIN_PHONE = process.env.ADMIN_PHONE || '35795167764@c.us';
const HOURS_BACK = 6;

/**
 * Check if it's time to send the bug report (every 6 hours Israel time: 7am, 1pm, 7pm, 1am)
 */
function isBugReportTime() {
  const now = new Date();
  const ilTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }));
  const hour = ilTime.getHours();
  const minute = ilTime.getMinutes();
  return [7, 13, 19, 1].includes(hour) && minute < 5;
}

/**
 * Analyze recent conversations and send a bug report to admin
 */
async function runBugReport() {
  try {
    const since = new Date(Date.now() - HOURS_BACK * 60 * 60 * 1000).toISOString();

    const { data: messages, error } = await db.supabase
      .from('messages')
      .select('user_id, role, content, created_at')
      .gte('created_at', since)
      .order('created_at', { ascending: true });

    if (error || !messages || messages.length === 0) {
      logger.info('bugMonitor', 'No messages to analyze');
      return;
    }

    // Decrypt messages
    const { decrypt } = require('../utils/encryption');
    const decrypted = messages.map((m) => ({
      ...m,
      content: decrypt(m.content),
    }));

    // Get user names
    const userIds = [...new Set(decrypted.map((m) => m.user_id))];
    const { data: users } = await db.supabase
      .from('users')
      .select('id, name, phone_number')
      .in('id', userIds);

    const userMap = {};
    for (const u of users || []) userMap[u.id] = u.name || u.phone_number;

    // Group by user
    const convos = {};
    for (const msg of decrypted) {
      if (!convos[msg.user_id]) convos[msg.user_id] = [];
      convos[msg.user_id].push(msg);
    }

    const issues = [];

    for (const [userId, msgs] of Object.entries(convos)) {
      const userName = userMap[userId] || userId;

      for (let i = 0; i < msgs.length; i++) {
        const msg = msgs[i];
        const prev = i > 0 ? msgs[i - 1] : null;
        const next = i < msgs.length - 1 ? msgs[i + 1] : null;

        // 1. User asked the same question multiple times (frustration)
        if (msg.role === 'user') {
          const sameQuestions = msgs.filter(
            (m) => m.role === 'user' && m.content === msg.content && m.created_at !== msg.created_at
          );
          if (sameQuestions.length >= 2 && !issues.some((is) => is.content === msg.content && is.userId === userId)) {
            issues.push({
              type: 'repeated_question',
              userId,
              userName,
              content: msg.content,
              count: sameQuestions.length + 1,
              desc: `שאל "${msg.content}" ${sameQuestions.length + 1} פעמים`,
            });
          }
        }

        // 2. Bot responded with question marks or confusion
        if (msg.role === 'assistant' && msg.content) {
          if (msg.content.includes('לא ברור') || msg.content.includes('לא הבנתי') || msg.content.includes('לא מצאתי')) {
            issues.push({
              type: 'bot_confused',
              userId,
              userName,
              content: prev?.content || '',
              botResponse: msg.content.substring(0, 100),
              desc: `הבוט לא הבין: "${prev?.content || '?'}"`,
            });
          }
        }

        // 3. User expressed frustration
        if (msg.role === 'user' && msg.content) {
          const frustrated = ['אתה לא יודע', 'לא עובד', 'באג', 'שגיאה', 'לא הבנת', 'לא זה', 'טעות', 'ומה גילית', 'תשתף אותי', 'מה בדקת'];
          if (frustrated.some((f) => msg.content.includes(f))) {
            issues.push({
              type: 'user_frustrated',
              userId,
              userName,
              content: msg.content,
              desc: `${userName} מתוסכל: "${msg.content}"`,
            });
          }
        }

        // 4. Bot gave empty or very short response
        if (msg.role === 'assistant' && msg.content && msg.content.length < 10 && !['בכיף! 😊', 'בוצע! ✅'].includes(msg.content)) {
          issues.push({
            type: 'short_response',
            userId,
            userName,
            content: msg.content,
            userMsg: prev?.content || '',
            desc: `תשובה קצרה מדי: "${msg.content}" לשאלה "${prev?.content || '?'}"`,
          });
        }

        // 5. Same bot response sent multiple times in a row
        if (msg.role === 'assistant' && next && next.role === 'user') {
          const nextBot = msgs[i + 2];
          if (nextBot && nextBot.role === 'assistant' && nextBot.content === msg.content) {
            if (!issues.some((is) => is.type === 'duplicate_response' && is.content === msg.content && is.userId === userId)) {
              issues.push({
                type: 'duplicate_response',
                userId,
                userName,
                content: msg.content?.substring(0, 80),
                desc: `תשובה זהה חוזרת: "${msg.content?.substring(0, 50)}..."`,
              });
            }
          }
        }
      }
    }

    // Build report
    const totalUsers = Object.keys(convos).length;
    const totalMessages = decrypted.length;

    // Deduplicate issues
    const uniqueIssues = [];
    const seen = new Set();
    for (const issue of issues) {
      const key = `${issue.type}:${issue.userId}:${issue.content?.substring(0, 30)}`;
      if (!seen.has(key)) {
        seen.add(key);
        uniqueIssues.push(issue);
      }
    }

    let report = `📊 דוח ניטור (${HOURS_BACK} שעות אחרונות)\n`;
    report += `👥 ${totalUsers} משתמשים | 💬 ${totalMessages} הודעות\n`;

    if (uniqueIssues.length === 0) {
      report += `\n✅ לא נמצאו בעיות!`;
    } else {
      report += `\n⚠️ ${uniqueIssues.length} בעיות:\n`;

      for (const issue of uniqueIssues.slice(0, 10)) {
        report += `\n• ${issue.desc}`;
      }

      if (uniqueIssues.length > 10) {
        report += `\n\n...ועוד ${uniqueIssues.length - 10} בעיות`;
      }
    }

    // Send to admin
    await greenApi.sendMessage(ADMIN_PHONE, report);
    logger.info('bugMonitor', 'Bug report sent', { issues: uniqueIssues.length, messages: totalMessages });
  } catch (error) {
    logger.error('bugMonitor', 'Bug report failed', { error: error.message });
  }
}

module.exports = { runBugReport, isBugReportTime };
