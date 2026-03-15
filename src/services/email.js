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
<head><meta charset="UTF-8"><link href="https://fonts.googleapis.com/css2?family=Heebo:wght@400;600;700&display=swap" rel="stylesheet"></head>
<body style="margin:0;padding:0;background:#ECE5DD;font-family:'Heebo',Arial,Helvetica,sans-serif;color:#111b21;">
  <div style="max-width:500px;margin:0 auto;padding:40px 20px;">

    <div style="text-align:center;margin-bottom:24px;">
      <img src="https://www.maztary.com/logo.png" alt="מזכיר" style="width:64px;height:64px;border-radius:16px;">
    </div>

    <div style="background:rgba(255,255,255,0.9);border-radius:16px;padding:28px;border:1px solid rgba(0,0,0,0.08);">
      <h1 style="font-size:22px;margin:0 0 12px;color:#111b21;">שלום ${name},</h1>
      <p style="font-size:15px;margin:0 0 24px;line-height:1.7;color:#3b4a54;">
        תודה שנרשמת למזכיר. העוזר האישי שלך בוואטסאפ מוכן לפעולה.
      </p>

      <p style="font-size:15px;margin:0 0 8px;color:#3b4a54;font-weight:bold;">הצעד הבא:</p>
      <p style="font-size:15px;margin:0 0 24px;line-height:1.7;color:#3b4a54;">
        לחץ על הכפתור למטה כדי לפתוח צ'אט עם המזכיר בוואטסאפ ולשלוח הודעה ראשונה.
      </p>

      <div style="text-align:center;margin:28px 0;">
        <a href="${waLink}" style="display:inline-block;background:#25D366;color:#ffffff;text-decoration:none;padding:14px 32px;border-radius:100px;font-size:16px;font-weight:bold;box-shadow:0 4px 15px rgba(37,211,102,0.3);">
          פתח צ'אט עם המזכיר
        </a>
      </div>

      <p style="font-size:13px;margin:20px 0 0;line-height:1.6;color:#667781;">
        אחרי שתשלח הודעה ראשונה תוכל להתחיל להשתמש מיד.
      </p>
    </div>

    <p style="font-size:12px;color:#667781;text-align:center;margin:20px 0 0;">
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
