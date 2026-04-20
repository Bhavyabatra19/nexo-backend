const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const UserModel = require('../models/User');
const db = require('../db');
const pineconeService = require('../services/pineconeService');

/**
 * GET /api/settings
 * Fetch current user settings
 */
router.get('/', authenticateToken, async (req, res) => {
  try {
    const user = await UserModel.findById(req.userId);
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    res.json({
      success: true,
      settings: {
        notificationEmail: user.notification_email,
        notificationWhatsapp: user.notification_whatsapp,
        whatsappNumber: user.whatsapp_number
      }
    });
  } catch (error) {
    console.error('Error fetching settings:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch settings' });
  }
});

/**
 * PUT /api/settings
 * Update user settings
 */
router.put('/', authenticateToken, async (req, res) => {
  try {
    const { notificationEmail, notificationWhatsapp, whatsappNumber } = req.body;
    
    // basic validation
    if (notificationWhatsapp && (!whatsappNumber || whatsappNumber.trim() === '')) {
       return res.status(400).json({ success: false, error: 'WhatsApp number is required if WhatsApp notifications are enabled.' });
    }

    const updatedUser = await UserModel.update(req.userId, {
      notificationEmail,
      notificationWhatsapp,
      whatsappNumber
    });

    res.json({
      success: true,
      settings: {
        notificationEmail: updatedUser.notification_email,
        notificationWhatsapp: updatedUser.notification_whatsapp,
        whatsappNumber: updatedUser.whatsapp_number
      }
    });

  } catch (error) {
    console.error('Error updating settings:', error);
    res.status(500).json({ success: false, error: 'Failed to update settings' });
  }
});

/**
 * POST /api/settings/test-whatsapp
 * Send a test WhatsApp notification to the user's saved number
 */
router.post('/test-whatsapp', authenticateToken, async (req, res) => {
  try {
    const user = await UserModel.findById(req.userId);
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }
    if (!user.whatsapp_number || !user.whatsapp_number.trim()) {
      return res.status(400).json({ success: false, error: 'No WhatsApp number configured.' });
    }

    const notificationService = require('../services/notificationService');
    const sent = await notificationService.sendWhatsappMessage(user.whatsapp_number, {
      userName: user.full_name || 'there',
      reminderTitle: 'Test Notification from NEXO',
      dueLine: new Date().toLocaleString(),
    });

    if (sent) {
      res.json({ success: true, message: 'Test notification sent!' });
    } else {
      res.status(500).json({ success: false, error: 'WhatsApp not configured or send failed.' });
    }
  } catch (error) {
    console.error('Error sending test WhatsApp:', error.response?.data || error.message);
    res.status(500).json({ success: false, error: 'Failed to send test message. Please check your number.' });
  }
});

/**
 * DELETE /api/settings/account
 * Permanently delete the authenticated user and ALL their data.
 * Cascade deletes handle: contacts, tags, lists, notes, reminders,
 * activities, calendar_events, google_tokens, sync_history,
 * whatsapp_sessions, ai_chat_messages, user_jobs.
 */
router.delete('/account', authenticateToken, async (req, res) => {
  try {
    const user = await UserModel.findById(req.userId);
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    // Fetch contact IDs before cascade-deleting the user so we can
    // remove the corresponding Pinecone vectors.
    const { rows: contactRows } = await db.query(
      'SELECT id FROM contacts WHERE user_id = $1',
      [req.userId]
    );
    const contactIds = contactRows.map(r => r.id);

    // Delete Pinecone embeddings (best-effort — don't block account deletion on failure)
    if (contactIds.length > 0) {
      try {
        const deleted = await pineconeService.deleteUserVectors(contactIds);
        console.log(`[AccountDeletion] Removed ${deleted} Pinecone vectors for user ${req.userId}`);
      } catch (pineconeErr) {
        console.error('[AccountDeletion] Pinecone cleanup failed (continuing):', pineconeErr.message);
      }
    }

    // Delete user — ON DELETE CASCADE handles all DB tables
    await UserModel.delete(req.userId);

    res.json({ success: true, message: 'Account and all associated data have been permanently deleted.' });
  } catch (error) {
    console.error('Error deleting account:', error);
    res.status(500).json({ success: false, error: 'Failed to delete account. Please try again.' });
  }
});

/**
 * GET /api/settings/extension-token
 * Returns a long-lived (90-day) JWT for the Chrome extension.
 * User copies this once from nexo.in/settings → Extension Token.
 */
router.get('/extension-token', authenticateToken, (req, res) => {
  const { generateToken } = require('../middleware/auth');
  // Override expiry to 90 days for extension use
  const jwt = require('jsonwebtoken');
  const token = jwt.sign(
    { userId: req.userId },
    process.env.JWT_SECRET,
    { expiresIn: '90d' }
  );
  res.json({ success: true, token, expiresIn: '90 days' });
});

module.exports = router;
