const { google } = require('googleapis');

/**
 * Google Contacts Service
 * Uses Google People API v1 to fetch contacts
 */

class GoogleContactsService {
  constructor(authClient) {
    this.people = google.people({ version: 'v1', auth: authClient });
  }

  /**
   * Fetch all contacts from Google
   * @param {Object} options - Fetch options
   * @param {number} options.pageSize - Number of contacts per page (max 1000)
   * @param {boolean} options.fetchAll - Whether to fetch all pages
   * @returns {Promise<Array>} Array of formatted contact objects
   */
  async fetchContacts(options = {}) {
    const { pageSize = 1000, fetchAll = true } = options;
    
    try {
      let allContacts = [];
      let pageToken = null;

      do {
        const response = await this.people.people.connections.list({
          resourceName: 'people/me',
          pageSize: pageSize,
          pageToken: pageToken,
          personFields: 'names,emailAddresses,phoneNumbers,organizations,metadata,photos,birthdays,addresses'
        });

        const connections = response.data.connections || [];
        const formattedContacts = connections.map(contact => this.formatContact(contact));
        allContacts = allContacts.concat(formattedContacts);

        pageToken = response.data.nextPageToken;

        // If fetchAll is false, break after first page
        if (!fetchAll) break;

      } while (pageToken);

      console.log(`Successfully fetched ${allContacts.length} contacts`);
      return allContacts;

    } catch (error) {
      console.error('Error fetching contacts:', error);
      throw new Error('Failed to fetch Google contacts');
    }
  }

  /**
   * Search contacts by query
   * @param {string} query - Search query
   * @returns {Promise<Array>} Array of matching contacts
   */
  async searchContacts(query) {
    try {
      const response = await this.people.people.searchContacts({
        query: query,
        readMask: 'names,emailAddresses,phoneNumbers,organizations'
      });

      const results = response.data.results || [];
      return results.map(result => this.formatContact(result.person));

    } catch (error) {
      console.error('Error searching contacts:', error);
      throw new Error('Failed to search contacts');
    }
  }

  /**
   * Get contact groups (labels)
   * @returns {Promise<Array>} Array of contact groups
   */
  async getContactGroups() {
    try {
      const response = await this.people.contactGroups.list({});
      return response.data.contactGroups || [];
    } catch (error) {
      console.error('Error fetching contact groups:', error);
      throw new Error('Failed to fetch contact groups');
    }
  }

  /**
   * Format raw Google contact into clean object
   * @param {Object} contact - Raw contact from Google API
   * @returns {Object} Formatted contact object
   */
  formatContact(contact) {
    const formatted = {
      id: contact.resourceName,
      name: null,
      firstName: null,
      lastName: null,
      email: null,
      emails: [],
      phone: null,
      phones: [],
      company: null,
      jobTitle: null,
      photoUrl: null,
      birthday: null,
      address: null,
      lastUpdated: null
    };

    // Extract name
    if (contact.names && contact.names.length > 0) {
      const primaryName = contact.names[0];
      formatted.name = primaryName.displayName;
      formatted.firstName = primaryName.givenName || null;
      formatted.lastName = primaryName.familyName || null;
    }

    // Extract emails
    if (contact.emailAddresses && contact.emailAddresses.length > 0) {
      formatted.emails = contact.emailAddresses.map(email => ({
        value: email.value,
        type: email.type || 'other'
      }));
      // Set primary email
      const primaryEmail = contact.emailAddresses.find(e => e.metadata?.primary) 
        || contact.emailAddresses[0];
      formatted.email = primaryEmail.value;
    }

    // Extract phone numbers
    if (contact.phoneNumbers && contact.phoneNumbers.length > 0) {
      formatted.phones = contact.phoneNumbers.map(phone => ({
        value: phone.value,
        type: phone.type || 'other'
      }));
      // Set primary phone
      const primaryPhone = contact.phoneNumbers.find(p => p.metadata?.primary) 
        || contact.phoneNumbers[0];
      formatted.phone = primaryPhone.value;
    }

    // Extract organization info
    if (contact.organizations && contact.organizations.length > 0) {
      const primaryOrg = contact.organizations[0];
      formatted.company = primaryOrg.name || null;
      formatted.jobTitle = primaryOrg.title || null;
    }

    // Extract photo
    if (contact.photos && contact.photos.length > 0) {
      formatted.photoUrl = contact.photos[0].url;
    }

    // Extract birthday
    if (contact.birthdays && contact.birthdays.length > 0) {
      const birthday = contact.birthdays[0].date;
      if (birthday) {
        formatted.birthday = {
          year: birthday.year,
          month: birthday.month,
          day: birthday.day
        };
      }
    }

    // Extract address
    if (contact.addresses && contact.addresses.length > 0) {
      formatted.address = contact.addresses[0].formattedValue || null;
    }

    // Extract metadata
    if (contact.metadata) {
      formatted.lastUpdated = contact.metadata.sources?.[0]?.updateTime || null;
    }

    return formatted;
  }

  /**
   * Get contact statistics
   * @param {Array} contacts - Array of contacts
   * @returns {Object} Statistics object
   */
  getStatistics(contacts) {
    return {
      total: contacts.length,
      withEmail: contacts.filter(c => c.email).length,
      withPhone: contacts.filter(c => c.phone).length,
      withCompany: contacts.filter(c => c.company).length,
      withPhoto: contacts.filter(c => c.photoUrl).length
    };
  }
}

module.exports = GoogleContactsService;
