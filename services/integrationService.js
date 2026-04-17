const GoogleContactsService = require('./contactsService');
const GoogleCalendarService = require('./calendarService');

/**
 * Main Integration Service
 * Orchestrates Google Contacts and Calendar sync
 */

class GoogleIntegrationService {
  constructor(authClient) {
    this.contactsService = new GoogleContactsService(authClient);
    this.calendarService = new GoogleCalendarService(authClient);
  }

  /**
   * Perform complete sync - contacts + calendar + merge
   * This is the main function for the NEXO MVP onboarding flow
   * @param {Object} options - Sync options
   * @param {number} options.calendarDaysBack - Days back to fetch calendar (default: 90)
   * @param {number} options.calendarDaysAhead - Days ahead to fetch calendar (default: 90)
   * @returns {Promise<Object>} Complete sync result with enriched data
   */
  async performCompleteSync(options = {}) {
    const {
      calendarDaysBack = 90,
      calendarDaysAhead = 90
    } = options;

    console.log('Starting complete Google sync...');
    const startTime = Date.now();

    try {
      // Step 1: Fetch contacts
      console.log('Fetching contacts...');
      const contacts = await this.contactsService.fetchContacts();
      console.log(`✓ Fetched ${contacts.length} contacts`);

      // Step 2: Fetch calendar events
      console.log('Fetching calendar events...');
      const now = new Date();
      const timeMin = new Date(now.getTime() - (calendarDaysBack * 24 * 60 * 60 * 1000));
      const timeMax = new Date(now.getTime() + (calendarDaysAhead * 24 * 60 * 60 * 1000));
      
      const events = await this.calendarService.fetchEvents({ timeMin, timeMax });
      console.log(`✓ Fetched ${events.length} calendar events`);

      // Step 3: Extract attendee interactions
      console.log('Analyzing calendar interactions...');
      const interactions = this.calendarService.extractAttendeeInteractions(events);
      console.log(`✓ Found ${Object.keys(interactions).length} unique contacts from calendar`);

      // Step 4: Merge contacts with calendar data
      console.log('Enriching contacts with calendar data...');
      const enrichedContacts = this.calendarService.mergeContactsWithCalendar(contacts, events);
      
      // Step 5: Calculate statistics
      const contactStats = this.contactsService.getStatistics(contacts);
      const eventStats = this.calendarService.getStatistics(events);

      const enrichedStats = {
        withCalendarData: enrichedContacts.filter(c => c.calendarData.lastContacted).length,
        withoutCalendarData: enrichedContacts.filter(c => !c.calendarData.lastContacted).length,
        averageMeetingsPerContact: enrichedContacts
          .filter(c => c.calendarData.totalMeetings > 0)
          .reduce((sum, c) => sum + c.calendarData.totalMeetings, 0) / 
          enrichedContacts.filter(c => c.calendarData.totalMeetings > 0).length || 0
      };

      const executionTime = Date.now() - startTime;
      console.log(`✓ Sync completed in ${(executionTime / 1000).toFixed(2)}s`);

      return {
        success: true,
        syncedAt: new Date().toISOString(),
        executionTimeMs: executionTime,
        data: {
          contacts: enrichedContacts,
          events: events,
          interactions: Object.values(interactions)
        },
        statistics: {
          contacts: contactStats,
          events: eventStats,
          enrichment: enrichedStats
        }
      };

    } catch (error) {
      console.error('Error during complete sync:', error);
      throw error;
    }
  }

  /**
   * Get contacts that need re-engagement
   * @param {number} daysThreshold - Days since last contact
   * @returns {Promise<Array>} Contacts to re-engage
   */
  async getContactsToReengage(daysThreshold = 30) {
    try {
      // Fetch past events
      const events = await this.calendarService.fetchPastEvents(365); // Last year
      
      // Get stale contacts
      const staleContacts = this.calendarService.getStaleContacts(events, daysThreshold);
      
      // Fetch full contact details for stale contacts
      const contacts = await this.contactsService.fetchContacts();
      
      // Match and enrich
      const enriched = staleContacts.map(stale => {
        const contact = contacts.find(c => 
          c.email && c.email.toLowerCase() === stale.email.toLowerCase()
        );
        
        return {
          ...contact,
          interactionData: stale
        };
      }).filter(c => c.name); // Only include contacts with valid data

      return enriched;

    } catch (error) {
      console.error('Error getting contacts to re-engage:', error);
      throw error;
    }
  }

  /**
   * Get upcoming meetings summary
   * @param {number} daysAhead - Days to look ahead (default: 7)
   * @returns {Promise<Object>} Upcoming meetings summary
   */
  async getUpcomingMeetingsSummary(daysAhead = 7) {
    try {
      const events = await this.calendarService.fetchUpcomingEvents(daysAhead);
      
      // Group by date
      const byDate = {};
      events.forEach(event => {
        const date = new Date(event.start).toDateString();
        if (!byDate[date]) {
          byDate[date] = [];
        }
        byDate[date].push(event);
      });

      // Extract unique attendees
      const uniqueAttendees = new Set();
      events.forEach(event => {
        if (event.attendees) {
          event.attendees.forEach(a => {
            if (!a.self) uniqueAttendees.add(a.email);
          });
        }
      });

      return {
        totalEvents: events.length,
        eventsByDate: byDate,
        uniqueAttendees: Array.from(uniqueAttendees),
        totalUniqueAttendees: uniqueAttendees.size,
        events: events
      };

    } catch (error) {
      console.error('Error getting upcoming meetings:', error);
      throw error;
    }
  }

  /**
   * Search contacts with calendar context
   * @param {string} query - Search query
   * @returns {Promise<Array>} Matching contacts with interaction data
   */
  async searchContactsWithContext(query) {
    try {
      // Search contacts
      const contacts = await this.contactsService.searchContacts(query);
      
      // Fetch recent calendar to enrich
      const events = await this.calendarService.fetchPastEvents(90);
      
      // Enrich with calendar data
      const enriched = this.calendarService.mergeContactsWithCalendar(contacts, events);
      
      return enriched;

    } catch (error) {
      console.error('Error searching contacts:', error);
      throw error;
    }
  }
}

module.exports = GoogleIntegrationService;
