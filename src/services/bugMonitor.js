const db = require('./database');
const greenApi = require('./greenApi');
const logger = require('../utils/logger');

const ADMIN_PHONE = process.env.ADMIN_PHONE || '35795167764@c.us';

// Track last report time to prevent duplicates
let lastReportTime = 0;

/**
 * Check if it's time to send the daily usage report (once a day at 22:00 Israel time)
 */
function isBugReportTime() {
  const now = Date.now();
  // Don't send more than once per 20 hours
  if (now - lastReportTime < 20 * 60 * 60 * 1000) return false;

  const ilTime = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }));
  const hour = ilTime.getHours();
  const minute = ilTime.getMinutes();
  if (hour === 22 && minute < 5) {
    lastReportTime = now;
    return true;
  }
  return false;
}

/**
 * Send daily usage report to admin
 */
async function runBugReport() {
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    // Get today's messages
    const { data: messages, error } = await db.supabase
      .from('messages')
      .select('user_id, role, created_at')
      .gte('created_at', since);

    if (error) {
      logger.error('bugMonitor', 'Failed to fetch messages', error);
      return;
    }

    // Get all users
    const { data: allUsers } = await db.supabase
      .from('users')
      .select('id, name, phone_number, status');

    const totalUsers = (allUsers || []).length;
    const activeUsers = (allUsers || []).filter((u) => u.status === 'active').length;
    const pendingUsers = (allUsers || []).filter((u) => u.status === 'pending').length;

    // Count messages per user
    const userMessages = {};
    for (const msg of (messages || [])) {
      if (msg.role === 'user') {
        userMessages[msg.user_id] = (userMessages[msg.user_id] || 0) + 1;
      }
    }

    const activeToday = Object.keys(userMessages).length;
    const totalMessages = (messages || []).filter((m) => m.role === 'user').length;
    const botMessages = (messages || []).filter((m) => m.role === 'assistant').length;

    // Build user names map
    const userMap = {};
    for (const u of (allUsers || [])) userMap[u.id] = u.name || u.phone_number;

    // Top users by messages
    const sortedUsers = Object.entries(userMessages)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);

    // Get new registrations today
    const { data: newUsers } = await db.supabase
      .from('users')
      .select('name, status')
      .gte('created_at', since);

    // Build report
    const ilDate = new Date().toLocaleDateString('he-IL', { timeZone: 'Asia/Jerusalem', day: 'numeric', month: 'long', year: 'numeric' });

    let report = `📊 דוח שימוש יומי - ${ilDate}\n\n`;
    report += `👥 סה"כ משתמשים: ${totalUsers}\n`;
    report += `✅ פעילים: ${activeUsers}\n`;
    report += `⏳ ממתינים: ${pendingUsers}\n\n`;
    report += `📱 פעילים היום: ${activeToday}\n`;
    report += `💬 הודעות משתמשים: ${totalMessages}\n`;
    report += `🤖 תגובות בוט: ${botMessages}\n`;

    if ((newUsers || []).length > 0) {
      report += `\n🆕 נרשמו היום: ${newUsers.length}\n`;
      for (const u of newUsers) {
        report += `  • ${u.name} (${u.status === 'active' ? 'אושר' : 'ממתין'})\n`;
      }
    }

    if (sortedUsers.length > 0) {
      report += `\n🏆 משתמשים פעילים היום:\n`;
      for (const [userId, count] of sortedUsers) {
        const name = userMap[userId] || userId;
        report += `  • ${name}: ${count} הודעות\n`;
      }
    }

    if (activeToday === 0) {
      report += `\n😴 אין פעילות היום`;
    }

    // Send to admin
    await greenApi.sendMessage(ADMIN_PHONE, report);
    logger.info('bugMonitor', 'Daily usage report sent', { activeToday, totalMessages });
  } catch (error) {
    logger.error('bugMonitor', 'Usage report failed', { error: error.message });
  }
}

module.exports = { runBugReport, isBugReportTime };
