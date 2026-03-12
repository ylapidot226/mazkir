const { Resend } = require('resend');
const config = require('../config');
const logger = require('../utils/logger');

const resend = new Resend(config.resend.apiKey);

/**
 * Send welcome email with WhatsApp link
 */
async function sendWelcomeEmail(email, name) {
  const waLink = `https://wa.me/${config.whatsapp.botNumber}?text=${encodeURIComponent('שלום, נרשמתי למזכיר!')}`;

  try {
    const { data, error } = await resend.emails.send({
      from: `מזכיר <${config.resend.fromEmail}>`,
      to: email,
      subject: 'ברוכים הבאים למזכיר! 🤖',
      html: `
<!DOCTYPE html>
<html dir="rtl" lang="he">
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#080808;font-family:Arial,sans-serif;">
  <div style="max-width:500px;margin:0 auto;padding:40px 20px;">
    <div style="background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:16px;padding:40px;text-align:center;">

      <div style="font-size:48px;margin-bottom:16px;">🤖</div>
      <h1 style="color:#F1F1F1;font-size:24px;margin:0 0 8px;">שלום ${name}!</h1>
      <p style="color:#8B8B8B;font-size:16px;margin:0 0 32px;line-height:1.6;">
        תודה שנרשמת למזכיר — העוזר החכם שלך בוואטסאפ.
      </p>

      <div style="background:rgba(124,58,237,0.1);border:1px solid rgba(124,58,237,0.3);border-radius:12px;padding:24px;margin-bottom:32px;">
        <p style="color:#A78BFA;font-size:14px;margin:0 0 8px;font-weight:bold;">צעד אחד אחרון:</p>
        <p style="color:#F1F1F1;font-size:15px;margin:0;line-height:1.6;">
          לחץ על הכפתור למטה כדי לפתוח צ'אט עם המזכיר בוואטסאפ ולשלוח הודעה ראשונה.
        </p>
      </div>

      <a href="${waLink}" style="display:inline-block;background:#25D366;color:#fff;text-decoration:none;padding:14px 32px;border-radius:12px;font-size:16px;font-weight:bold;">
        💬 פתח צ'אט עם המזכיר
      </a>

      <p style="color:#555;font-size:13px;margin:32px 0 0;line-height:1.6;">
        אחרי שתשלח הודעה ראשונה, נאשר את החשבון שלך<br>ותוכל להתחיל להשתמש בכל הפיצ'רים.
      </p>
    </div>

    <p style="color:#333;font-size:12px;text-align:center;margin-top:24px;">
      מזכיר — נבנה על ידי יצחק לפידות
    </p>
  </div>
</body>
</html>`,
    });

    if (error) {
      logger.error('email', 'Failed to send welcome email', error);
      throw error;
    }

    logger.info('email', 'Welcome email sent', { email, messageId: data?.id });
    return data;
  } catch (error) {
    logger.error('email', 'Failed to send email', error);
    throw error;
  }
}

module.exports = {
  sendWelcomeEmail,
};
