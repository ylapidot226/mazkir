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
      subject: `שלום ${name}, החשבון שלך במזכיר מוכן`,
      html: `
<!DOCTYPE html>
<html dir="rtl" lang="he">
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#ffffff;font-family:Arial,Helvetica,sans-serif;color:#333333;">
  <div style="max-width:500px;margin:0 auto;padding:40px 20px;">

    <h1 style="font-size:22px;margin:0 0 12px;color:#1a1a1a;">שלום ${name},</h1>
    <p style="font-size:15px;margin:0 0 24px;line-height:1.7;color:#555555;">
      תודה שנרשמת למזכיר. העוזר האישי שלך בוואטסאפ מוכן לפעולה.
    </p>

    <p style="font-size:15px;margin:0 0 8px;color:#555555;font-weight:bold;">הצעד הבא:</p>
    <p style="font-size:15px;margin:0 0 24px;line-height:1.7;color:#555555;">
      לחץ על הכפתור למטה כדי לפתוח צ'אט עם המזכיר בוואטסאפ ולשלוח הודעה ראשונה.
    </p>

    <div style="text-align:center;margin:32px 0;">
      <a href="${waLink}" style="display:inline-block;background:#25D366;color:#ffffff;text-decoration:none;padding:14px 32px;border-radius:8px;font-size:16px;font-weight:bold;">
        פתח צ'אט עם המזכיר
      </a>
    </div>

    <p style="font-size:13px;margin:24px 0 0;line-height:1.6;color:#999999;">
      אחרי שתשלח הודעה ראשונה, נאשר את החשבון שלך ותוכל להתחיל להשתמש.
    </p>

    <hr style="border:none;border-top:1px solid #eeeeee;margin:32px 0 16px;">
    <p style="font-size:12px;color:#999999;text-align:center;margin:0;">
      מזכיר - maztary.com
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
