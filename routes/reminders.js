const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const ReminderModel = require('../models/Reminder');
const { scheduleReminder, cancelReminder } = require('../services/reminderScheduler');

// All routes are protected
router.use(authenticateToken);

// Get all reminders for a user
router.get('/', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    const offset = parseInt(req.query.offset) || 0;

    const { reminders, total } = await ReminderModel.getAllByUserId(req.userId, limit, offset);

    res.json({
      success: true,
      reminders,
      pagination: {
        total,
        limit,
        offset,
        hasMore: offset + reminders.length < total
      }
    });
  } catch (error) {
    console.error('Error fetching all user reminders:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get all reminders for a specific contact
router.get('/:contactId', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;

    const { reminders, total } = await ReminderModel.getByContactId(req.params.contactId, req.userId, limit, offset);
    
    res.json({ 
      success: true, 
      reminders,
      pagination: {
        total,
        limit,
        offset,
        hasMore: offset + reminders.length < total
      }
    });
  } catch (error) {
    console.error('Error fetching reminders:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Create a new reminder for a contact
router.post('/:contactId', async (req, res) => {
  try {
    const { title, dueDate, recurrence } = req.body;
    if (!title || !dueDate) {
      return res.status(400).json({ success: false, error: 'Title and due date are required' });
    }
    const reminder = await ReminderModel.create(req.params.contactId, req.userId, title, dueDate, recurrence);

    // Schedule exact-time notification
    scheduleReminder({ id: reminder.id, due_date: dueDate, user_id: req.userId, contact_id: req.params.contactId });

    // Log Activity
    const ActivityModel = require('../models/Activity');
    await ActivityModel.create(
      req.params.contactId, 
      req.userId, 
      'reminder_created', 
      title ? `Set reminder: ${title}` : `Set reminder`
    );

    // Force regeneration of AI summary
    const db = require('../db');
    await db.query(`UPDATE contacts SET ai_summary = NULL WHERE id = $1 AND user_id = $2`, [req.params.contactId, req.userId]);

    res.status(201).json({ success: true, reminder });
  } catch (error) {
    console.error('Error creating reminder:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Update an existing reminder
router.put('/:reminderId', async (req, res) => {
  try {
    const { contactId, title, dueDate, isCompleted, recurrence } = req.body;
    
    // Get original state to know if isCompleted actually changed
    const db = require('../db');
    const oldReminderRow = await db.query('SELECT contact_id, is_completed FROM reminders WHERE id = $1 AND user_id = $2', [req.params.reminderId, req.userId]);
    
    const reminder = await ReminderModel.update(req.params.reminderId, req.userId, contactId, title, dueDate, isCompleted, recurrence);
    if (!reminder) {
      return res.status(404).json({ success: false, error: 'Reminder not found' });
    }

    // Reschedule or cancel the in-memory timer
    if (isCompleted) {
      cancelReminder(req.params.reminderId);
    } else if (dueDate) {
      scheduleReminder({ id: req.params.reminderId, due_date: dueDate, user_id: req.userId, contact_id: contactId || reminder.contactId });
    }
    const ActivityModel = require('../models/Activity');
    
    if (oldReminderRow.rows.length > 0) {
      const oldIsCompleted = oldReminderRow.rows[0].is_completed;
      const targetContactId = oldReminderRow.rows[0].contact_id;
      
      // If isCompleted was provided and is DIFFERENT from what was in the database, log as completion change
      if (isCompleted !== undefined && isCompleted !== oldIsCompleted) {
        await ActivityModel.create(
          targetContactId, 
          req.userId, 
          'reminder_completed', 
          isCompleted ? `Completed task: ${reminder.title}` : `Re-opened task: ${reminder.title}`
        );
      } else {
        // Just an update of other fields
        await ActivityModel.create(
          targetContactId, 
          req.userId, 
          'reminder_updated', 
          `Updated task: ${reminder.title}`
        );
      }
    }

    // Force regeneration of AI summary
    if (contactId) {
      await db.query(`UPDATE contacts SET ai_summary = NULL WHERE id = $1 AND user_id = $2`, [contactId, req.userId]);
    }

    res.json({ success: true, reminder });
  } catch (error) {
    console.error('Error updating reminder:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Delete a reminder
router.delete('/:reminderId', async (req, res) => {
  try {
    // Get reminder details before deleting (for activity cleanup)
    const db = require('../db');
    const reminderRow = await db.query('SELECT contact_id, title FROM reminders WHERE id = $1 AND user_id = $2', [req.params.reminderId, req.userId]);

    await ReminderModel.delete(req.params.reminderId, req.userId);

    // Cancel in-memory scheduled timer
    cancelReminder(req.params.reminderId);

    // Clean up related activities from timeline
    if (reminderRow.rows.length > 0) {
      const { contact_id, title } = reminderRow.rows[0];
      
      const ActivityModel = require('../models/Activity');
      await ActivityModel.create(
        contact_id,
        req.userId,
        'reminder_deleted',
        `Deleted task: ${title}`
      );
      
      // Remove "reminder_created", "reminder_completed", and "reminder_updated" activities for this reminder
      await db.query(
        `DELETE FROM activities 
         WHERE contact_id = $1 AND user_id = $2 
         AND type IN ('reminder_created', 'reminder_completed', 'reminder_updated')
         AND (description LIKE $3 OR description LIKE $4 OR description LIKE $5 OR description LIKE $6)`,
        [contact_id, req.userId, `%${title}%`, `Set reminder: ${title}`, `Completed task: ${title}`, `Updated task: ${title}`]
      );
    }

    // Force regeneration of AI summary
    if (reminderRow.rows.length > 0) {
      await db.query(`UPDATE contacts SET ai_summary = NULL WHERE id = $1 AND user_id = $2`, [reminderRow.rows[0].contact_id, req.userId]);
    }

    res.json({ success: true, message: 'Reminder deleted successfully' });
  } catch (error) {
    console.error('Error deleting reminder:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
