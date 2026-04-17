const { google } = require('googleapis');

/**
 * Google Calendar Service
 * Uses Google Calendar API v3 to fetch calendar events
 */

class GoogleCalendarService {
  constructor(authClient) {
    this.calendar = google.calendar({ version: 'v3', auth: authClient });
  }

  /**
   * Fetch calendar events for a date range
   * @param {Object} options - Fetch options
   * @param {Date} options.timeMin - Start date (default: 90 days ago)
   * @param {Date} options.timeMax - End date (default: 90 days from now)
   * @param {number} options.maxResults - Maximum results per page
   * @param {boolean} options.fetchAll - Fetch all pages
   * @returns {Promise<Array>} Array of formatted calendar events
   */
  async fetchEvents(options = {}) {
    const now = new Date();
    const defaultTimeMin = new Date(now.getTime() - (90 * 24 * 60 * 60 * 1000)); // 90 days ago
    const defaultTimeMax = new Date(now.getTime() + (90 * 24 * 60 * 60 * 1000)); // 90 days from now

    const {
      timeMin = defaultTimeMin,
      timeMax = defaultTimeMax,
      maxResults = 2500,
      fetchAll = true
    } = options;

    try {
      let allEvents = [];
      let pageToken = null;

      do {
        const response = await this.calendar.events.list({
          calendarId: 'primary',
          timeMin: timeMin.toISOString(),
          timeMax: timeMax.toISOString(),
          maxResults: maxResults,
          singleEvents: true,
          orderBy: 'startTime',
          pageToken: pageToken
        });

        const events = response.data.items || [];
        const formattedEvents = events.map(event => this.formatEvent(event));
        allEvents = allEvents.concat(formattedEvents);

        pageToken = response.data.nextPageToken;

        if (!fetchAll) break;

      } while (pageToken);

      console.log(`Successfully fetched ${allEvents.length} calendar events`);
      return allEvents;

    } catch (error) {
      console.error('Error fetching calendar events:', error);
      throw new Error('Failed to fetch calendar events');
    }
  }

  /**
   * Fetch upcoming events only
   * @param {number} daysAhead - Number of days to look ahead (default: 90)
   * @returns {Promise<Array>} Array of upcoming events
   */
  async fetchUpcomingEvents(daysAhead = 90) {
    const now = new Date();
    const timeMax = new Date(now.getTime() + (daysAhead * 24 * 60 * 60 * 1000));

    return this.fetchEvents({
      timeMin: now,
      timeMax: timeMax
    });
  }

  /**
   * Fetch past events only
   * @param {number} daysBack - Number of days to look back (default: 90)
   * @returns {Promise<Array>} Array of past events
   */
  async fetchPastEvents(daysBack = 90) {
    const now = new Date();
    const timeMin = new Date(now.getTime() - (daysBack * 24 * 60 * 60 * 1000));

    return this.fetchEvents({
      timeMin: timeMin,
      timeMax: now
    });
  }

  /**
   * Extract attendee interactions from calendar events
   * This creates the "Last Interaction Date" mapping
   * @param {Array} events - Calendar events
   * @returns {Object} Map of email -> last interaction data
   */
  extractAttendeeInteractions(events) {
    const interactions = {};

    events.forEach(event => {
      if (!event.attendees || event.attendees.length === 0) return;

      event.attendees.forEach(attendee => {
        const email = attendee.email.toLowerCase();
        
        // Skip if it's the organizer's own email
        if (attendee.self) return;

        const eventDate = new Date(event.start);

        // Initialize or update interaction data
        if (!interactions[email]) {
          interactions[email] = {
            email: attendee.email,
            name: attendee.displayName || attendee.email,
            firstInteraction: eventDate,
            lastInteraction: eventDate,
            totalMeetings: 0,
            upcomingMeetings: 0,
            pastMeetings: 0,
            events: []
          };
        }

        const interaction = interactions[email];
        
        // Update interaction tracking
        interaction.totalMeetings++;
        
        if (eventDate > new Date()) {
          interaction.upcomingMeetings++;
        } else {
          interaction.pastMeetings++;
        }

        // Update first and last interaction dates
        if (eventDate < interaction.firstInteraction) {
          interaction.firstInteraction = eventDate;
        }
        if (eventDate > interaction.lastInteraction) {
          interaction.lastInteraction = eventDate;
        }

        // Add event reference
        interaction.events.push({
          id: event.id,
          summary: event.summary,
          start: event.start,
          end: event.end,
          status: event.status
        });
      });
    });

    return interactions;
  }

  /**
   * Get attendees who haven't been contacted recently
   * @param {Array} events - Calendar events
   * @param {number} daysThreshold - Days since last contact (default: 30)
   * @returns {Array} Attendees needing re-engagement
   */
  getStaleContacts(events, daysThreshold = 30) {
    const interactions = this.extractAttendeeInteractions(events);
    const now = new Date();
    const thresholdDate = new Date(now.getTime() - (daysThreshold * 24 * 60 * 60 * 1000));

    return Object.values(interactions)
      .filter(person => person.lastInteraction < thresholdDate)
      .sort((a, b) => a.lastInteraction - b.lastInteraction); // Oldest first
  }

  /**
   * Format raw calendar event into clean object
   * @param {Object} event - Raw event from Google Calendar API
   * @returns {Object} Formatted event object
   */
  formatEvent(event) {
    const formatted = {
      id: event.id,
      summary: event.summary || 'No Title',
      description: event.description || null,
      location: event.location || null,
      status: event.status, // confirmed, tentative, cancelled
      creator: null,
      organizer: null,
      attendees: [],
      start: null,
      end: null,
      isAllDay: false,
      recurring: !!event.recurringEventId,
      meetingLink: null,
      created: event.created,
      updated: event.updated
    };

    // Extract start/end times
    if (event.start) {
      formatted.start = event.start.dateTime || event.start.date;
      formatted.isAllDay = !!event.start.date;
    }

    if (event.end) {
      formatted.end = event.end.dateTime || event.end.date;
    }

    // Extract creator
    if (event.creator) {
      formatted.creator = {
        email: event.creator.email,
        name: event.creator.displayName || event.creator.email,
        self: event.creator.self || false
      };
    }

    // Extract organizer
    if (event.organizer) {
      formatted.organizer = {
        email: event.organizer.email,
        name: event.organizer.displayName || event.organizer.email,
        self: event.organizer.self || false
      };
    }

    // Extract attendees
    if (event.attendees) {
      formatted.attendees = event.attendees.map(attendee => ({
        email: attendee.email,
        displayName: attendee.displayName || attendee.email,
        responseStatus: attendee.responseStatus, // accepted, declined, tentative, needsAction
        self: attendee.self || false,
        optional: attendee.optional || false,
        organizer: attendee.organizer || false
      }));
    }

    // Extract meeting link (Google Meet, Zoom, etc.)
    if (event.hangoutLink) {
      formatted.meetingLink = event.hangoutLink;
    } else if (event.conferenceData?.entryPoints) {
      const videoEntry = event.conferenceData.entryPoints.find(e => e.entryPointType === 'video');
      if (videoEntry) {
        formatted.meetingLink = videoEntry.uri;
      }
    }

    return formatted;
  }

  /**
   * Get calendar statistics
   * @param {Array} events - Array of events
   * @returns {Object} Statistics object
   */
  getStatistics(events) {
    const now = new Date();
    
    return {
      total: events.length,
      upcoming: events.filter(e => new Date(e.start) > now).length,
      past: events.filter(e => new Date(e.start) <= now).length,
      withAttendees: events.filter(e => e.attendees && e.attendees.length > 0).length,
      withLocation: events.filter(e => e.location).length,
      withMeetingLink: events.filter(e => e.meetingLink).length,
      cancelled: events.filter(e => e.status === 'cancelled').length,
      recurring: events.filter(e => e.recurring).length
    };
  }

  /**
   * Merge contacts with calendar interaction data
   * This is the key function for the MVP - enriches contacts with last interaction dates
   * @param {Array} contacts - Array of contacts from Google Contacts
   * @param {Array} events - Array of events from Google Calendar
   * @returns {Array} Enriched contacts with interaction data
   */
  mergeContactsWithCalendar(contacts, events) {
    const interactions = this.extractAttendeeInteractions(events);

    return contacts.map(contact => {
      const enriched = { ...contact };
      
      // Try to match by email
      const interaction = contact.email 
        ? interactions[contact.email.toLowerCase()]
        : null;

      if (interaction) {
        enriched.calendarData = {
          lastContacted: interaction.lastInteraction,
          firstContacted: interaction.firstInteraction,
          totalMeetings: interaction.totalMeetings,
          upcomingMeetings: interaction.upcomingMeetings,
          pastMeetings: interaction.pastMeetings,
          daysSinceLastContact: Math.floor(
            (new Date() - interaction.lastInteraction) / (1000 * 60 * 60 * 24)
          ),
          recentEvents: interaction.events.slice(-3) // Last 3 events
        };
      } else {
        enriched.calendarData = {
          lastContacted: null,
          firstContacted: null,
          totalMeetings: 0,
          upcomingMeetings: 0,
          pastMeetings: 0,
          daysSinceLastContact: null,
          recentEvents: []
        };
      }

      return enriched;
    });
  }
}

module.exports = GoogleCalendarService;
