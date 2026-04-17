const sgMail = require('@sendgrid/mail');
const { sendTextMessage, sendTemplateMessage } = require('./whatsapp');
require('dotenv').config();

class NotificationService {
  constructor() {
    this.isSendGridConfigured = false;
    this.isWhatsappConfigured = false;

    // Required ENV variables:
    // Email:    SENDGRID_API_KEY, SENDGRID_FROM_EMAIL
    // WhatsApp: WHATSAPP_TOKEN, WHATSAPP_PHONE_ID, WHATSAPP_URL

    if (process.env.SENDGRID_API_KEY && process.env.SENDGRID_FROM_EMAIL) {
      sgMail.setApiKey(process.env.SENDGRID_API_KEY);
      this.isSendGridConfigured = true;
    }

    if (process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_ID && process.env.WHATSAPP_URL) {
      this.isWhatsappConfigured = true;
    }
  }

  /**
   * Send a WhatsApp reminder notification.
   * Tries plain text first (works reliably), falls back to template if text fails.
   *
   * @param {string} toPhone   - Recipient phone (any format; non-digits stripped)
   * @param {object} params    - { userName, reminderTitle, dueLine }
   */
  async sendWhatsappMessage(toPhone, { userName, reminderTitle, dueLine }) {
    if (!this.isWhatsappConfigured) {
      console.warn('[Notification] WhatsApp not configured. Skipping.', { toPhone });
      return false;
    }

    const cleanPhone = toPhone.replace(/\D/g, '');
    const textBody = `Hi ${userName || 'there'},\n\nYou have a reminder: *${reminderTitle}*\nDue: ${dueLine}\n\n— NEXO`;

    // 1. Try plain text message first
    try {
      await sendTextMessage(textBody, cleanPhone);
      console.log(`[Notification] WhatsApp text sent to ${cleanPhone}`);
      return true;
    } catch (textErr) {
      console.warn(`[Notification] WhatsApp text failed (${textErr.response?.data?.error?.code || textErr.message}), trying template...`);
    }

    // 2. Fall back to template (for outside 24h window)
    try {
      const templateName = process.env.WHATSAPP_REMINDER_TEMPLATE || 'reminder_notification';
      const templateLang = process.env.WHATSAPP_TEMPLATE_LANG || 'en';
      const components = [
        {
          type: 'body',
          parameters: [
            { type: 'text', text: userName || 'there' },
            { type: 'text', text: reminderTitle },
            { type: 'text', text: dueLine },
          ],
        },
      ];
      await sendTemplateMessage(cleanPhone, templateName, templateLang, components);
      console.log(`[Notification] WhatsApp template sent to ${cleanPhone}`);
      return true;
    } catch (templateErr) {
      console.error('[Notification] WhatsApp send failed (both text & template):', templateErr.response?.data || templateErr.message);
      return false;
    }
  }

  /**
   * Send an email via SendGrid.
   */
  async sendEmail(toEmail, subject, textBody, htmlBody) {
    if (!this.isSendGridConfigured) {
      console.warn('[Notification] SendGrid not configured. Skipping email.', { toEmail, subject });
      return false;
    }
    try {
      const msg = {
        to: toEmail,
        from: process.env.SENDGRID_FROM_EMAIL,
        subject,
        text: textBody,
        ...(htmlBody && { html: htmlBody }),
      };
      await sgMail.send(msg);
      console.log(`[Notification] Email sent to ${toEmail}`);
      return true;
    } catch (error) {
      console.error('[Notification] SendGrid email failed:', error.response?.body || error.message);
      return false;
    }
  }

  /**
   * Centralized method to send a notification based on user preferences.
   * Assumes user object contains notification_email, notification_whatsapp, email, and whatsapp_number fields
   */
  async notifyUser(user, { subject, textMessage, htmlMessage, whatsappParams = null }) {
    const results = {
      emailSent: false,
      whatsappSent: false
    };

    // 1. Check if user wants email notifications
    if (user.notification_email && user.email) {
       results.emailSent = await this.sendEmail(user.email, subject, textMessage, htmlMessage || textMessage);
    }

    // 2. Check if user wants whatsapp notifications
    if (user.notification_whatsapp && user.whatsapp_number && whatsappParams) {
      results.whatsappSent = await this.sendWhatsappMessage(user.whatsapp_number, whatsappParams);
    }

    return results;
  }
}

module.exports = new NotificationService();
