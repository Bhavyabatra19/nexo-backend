const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const CalendarEventModel = require('../models/CalendarEvent');

/**
 * Calendar Events Routes
 * All routes require authentication
 */

/**
 * GET /api/calendar/events
 * Get all calendar events with filtering
 */
router.get('/events', authenticateToken, async (req, res) => {
  try {
    const {
      limit = 100,
      offset = 0,
      startDate,
      endDate,
      sortBy = 'start_time',
      sortOrder = 'DESC'
    } = req.query;

    const events = await CalendarEventModel.getAll(req.userId, {
      limit: parseInt(limit),
      offset: parseInt(offset),
      startDate: startDate ? new Date(startDate) : null,
      endDate: endDate ? new Date(endDate) : null,
      sortBy,
      sortOrder
    });

    // Get total count
    const countResult = await require('../db').query(
      'SELECT COUNT(*) FROM calendar_events WHERE user_id = $1',
      [req.userId]
    );
    const totalCount = parseInt(countResult.rows[0].count);

    res.json({
      success: true,
      events,
      pagination: {
        total: totalCount,
        limit: parseInt(limit),
        offset: parseInt(offset),
        hasMore: parseInt(offset) + events.length < totalCount
      }
    });

  } catch (error) {
    console.error('Error fetching calendar events:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/calendar/upcoming
 * Get upcoming events
 */
router.get('/upcoming', authenticateToken, async (req, res) => {
  try {
    const { days = 7 } = req.query;

    const events = await CalendarEventModel.getUpcoming(req.userId, parseInt(days));

    res.json({
      success: true,
      daysAhead: parseInt(days),
      count: events.length,
      events
    });

  } catch (error) {
    console.error('Error fetching upcoming events:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/calendar/past
 * Get past events
 */
router.get('/past', authenticateToken, async (req, res) => {
  try {
    const { days = 90 } = req.query;

    const events = await CalendarEventModel.getPast(req.userId, parseInt(days));

    res.json({
      success: true,
      daysBack: parseInt(days),
      count: events.length,
      events
    });

  } catch (error) {
    console.error('Error fetching past events:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/calendar/stats
 * Get calendar statistics
 */
router.get('/stats', authenticateToken, async (req, res) => {
  try {
    const stats = await CalendarEventModel.getStats(req.userId);

    res.json({
      success: true,
      statistics: {
        total: parseInt(stats.total),
        upcoming: parseInt(stats.upcoming),
        past: parseInt(stats.past),
        cancelled: parseInt(stats.cancelled),
        recurring: parseInt(stats.recurring),
        uniqueAttendees: parseInt(stats.unique_attendees)
      }
    });

  } catch (error) {
    console.error('Error fetching calendar stats:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/calendar/by-attendee
 * Get events with specific attendee
 */
router.get('/by-attendee', authenticateToken, async (req, res) => {
  try {
    const { email } = req.query;

    if (!email) {
      return res.status(400).json({
        success: false,
        error: 'Email parameter is required'
      });
    }

    const events = await CalendarEventModel.getByAttendee(req.userId, email);

    res.json({
      success: true,
      attendeeEmail: email,
      count: events.length,
      events
    });

  } catch (error) {
    console.error('Error fetching events by attendee:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;