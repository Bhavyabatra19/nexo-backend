const db = require('../db');
const aiDeduplicationService = require('../services/aiDeduplicationService');

/**
 * LinkedIn Import Model
 * Handles CSV parsing, deduplication, and contact merging
 */

class LinkedInImportModel {
  /**
   * Parse LinkedIn CSV data
   * @param {string} csvContent - Raw CSV content
   * @returns {Array} Parsed contacts
   */
  static parseLinkedInCSV(csvContent) {
    const lines = csvContent.split('\n');
    const contacts = [];
    
    // Find header row (skip notes at top)
    let headerIndex = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes('First Name') && lines[i].includes('Last Name')) {
        headerIndex = i;
        break;
      }
    }

    if (headerIndex === -1) {
      throw new Error('Invalid LinkedIn CSV format - header row not found');
    }

    // Parse CSV (handling quoted fields)
    const headers = this.parseCSVLine(lines[headerIndex]);
    
    for (let i = headerIndex + 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      const values = this.parseCSVLine(line);
      if (values.length < headers.length) continue;

      const contact = {};
      headers.forEach((header, index) => {
        contact[header] = values[index] || null;
      });

      // Skip empty rows
      if (!contact['First Name'] && !contact['Last Name']) continue;

      // Format for our system
      const formatted = {
        firstName: contact['First Name']?.trim() || null,
        lastName: contact['Last Name']?.trim() || null,
        fullName: this.buildFullName(contact['First Name'], contact['Last Name']),
        email: contact['Email Address']?.trim().toLowerCase() || null,
        company: contact['Company']?.trim() || null,
        jobTitle: contact['Position']?.trim() || null,
        linkedinUrl: contact['URL']?.trim() || null,
        connectedOn: this.parseLinkedInDate(contact['Connected On']),
        source: 'linkedin'
      };

      contacts.push(formatted);
    }

    return contacts;
  }

  /**
   * Parse CSV line handling quoted fields
   */
  static parseCSVLine(line) {
    const result = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        result.push(current);
        current = '';
      } else {
        current += char;
      }
    }
    
    result.push(current);
    return result.map(v => v.trim());
  }

  /**
   * Build full name from first and last name
   */
  static buildFullName(firstName, lastName) {
    const parts = [firstName, lastName].filter(Boolean);
    return parts.length > 0 ? parts.join(' ') : null;
  }

  /**
   * Parse LinkedIn date format (e.g., "17 Feb 2026")
   */
  static parseLinkedInDate(dateStr) {
    if (!dateStr) return null;
    
    try {
      const date = new Date(dateStr);
      return isNaN(date.getTime()) ? null : date;
    } catch (error) {
      return null;
    }
  }

  /**
   * Find potential duplicates using email and fuzzy name matching
   * @param {string} userId - User ID
   * @param {Array} newContacts - New contacts from CSV
   * @returns {Promise<Object>} Deduplication analysis
   */
  static async findDuplicates(userId, newContacts, progressCallback = null) {
    // Get existing contacts for this user
    const existingResult = await db.query(`
      SELECT id, full_name, first_name, last_name, email, company, job_title,
             phone, photo_url, notes, linkedin_url, is_favorite, contact_created_date,
             emails, phones
      FROM contacts
      WHERE user_id = $1
    `, [userId]);

    const existingContacts = existingResult.rows;

    // Call the new AI Golden Profiling Engine and Semantic Deduplication
    try {
      if (process.env.GEMINI_API_KEY) {
        return await aiDeduplicationService.findDuplicatesAndProfile(existingContacts, newContacts, progressCallback, userId);
      }
    } catch (err) {
      console.warn('AI deduplication failed or skipped, falling back to empty mapping', err);
    }
    
    // In case there is no API key, return everything as unique
    return {
      total: newContacts.length,
      duplicates: 0,
      unique: newContacts.length,
      duplicateDetails: [],
      uniqueContacts: newContacts
    };
  }

  /**
   * Merge two contact records - keep most complete data
   * @param {Object} existing - Existing contact from database
   * @param {Object} incoming - New contact from CSV
   * @returns {Object} Merged contact
   */
  static mergeContacts(existing, incoming) {
    const merged = { ...existing };

    // Helper to check if field has value
    const hasValue = (val) => val !== null && val !== undefined && val !== '';

    // Merge strategy: prefer existing unless it's empty
    if (!hasValue(merged.email) && hasValue(incoming.email)) {
      merged.email = incoming.email;
    }

    if (!hasValue(merged.company) && hasValue(incoming.company)) {
      merged.company = incoming.company;
    }

    if (!hasValue(merged.job_title) && hasValue(incoming.jobTitle)) {
      merged.job_title = incoming.jobTitle;
    }

    if (!hasValue(merged.linkedin_url) && hasValue(incoming.linkedinUrl)) {
      merged.linkedin_url = incoming.linkedinUrl;
    }

    if (!hasValue(merged.contact_created_date) && hasValue(incoming.connectedOn)) {
      merged.contact_created_date = incoming.connectedOn;
    }

    // Append to notes if there's new LinkedIn connection date
    if (incoming.connectedOn && !merged.notes?.includes('LinkedIn connection')) {
      const dateStr = incoming.connectedOn.toLocaleDateString();
      const newNote = `LinkedIn connection: ${dateStr}`;
      merged.notes = merged.notes 
        ? `${merged.notes}\n${newNote}`
        : newNote;
    }

    // Always update source to indicate it's also from LinkedIn
    merged.source = 'google,linkedin'; // Indicates multiple sources

    return merged;
  }

  /**
   * Identify what changed in the merge
   */
  static identifyChanges(original, merged) {
    const changes = [];

    if (original.email !== merged.email) {
      changes.push({
        field: 'email',
        from: original.email,
        to: merged.email
      });
    }

    if (original.company !== merged.company) {
      changes.push({
        field: 'company',
        from: original.company,
        to: merged.company
      });
    }

    if (original.job_title !== merged.job_title) {
      changes.push({
        field: 'job_title',
        from: original.job_title,
        to: merged.job_title
      });
    }

    if (original.linkedin_url !== merged.linkedin_url) {
      changes.push({
        field: 'linkedin_url',
        from: original.linkedin_url,
        to: merged.linkedin_url
      });
    }

    if (original.notes !== merged.notes) {
      changes.push({
        field: 'notes',
        from: original.notes,
        to: merged.notes
      });
    }

    return changes;
  }

  /**
   * Execute import - apply duplicates and add unique contacts
   * @param {string} userId - User ID
   * @param {Object} deduplicationResult - Result from findDuplicates
   * @param {Object} options - Import options
   * @returns {Promise<Object>} Import result
   */
  static async executeImport(userId, deduplicationResult, options = {}) {
    const {
      applyDuplicateMerges = true,
      addUniqueContacts = true
    } = options;

    const client = await db.getClient();
    
    try {
      await client.query('BEGIN');

      const result = {
        duplicatesUpdated: 0,
        uniqueAdded: 0,
        errors: []
      };

      // Update duplicates
      if (applyDuplicateMerges) {
        for (const dup of deduplicationResult.duplicateDetails) {
          try {
            await client.query(`
              UPDATE contacts
              SET
                full_name = COALESCE(NULLIF($1, ''), full_name),
                first_name = COALESCE(NULLIF($2, ''), first_name),
                last_name = COALESCE(NULLIF($3, ''), last_name),
                email = COALESCE(NULLIF($4, ''), email),
                company = COALESCE(NULLIF($5, ''), company),
                job_title = COALESCE(NULLIF($6, ''), job_title),
                linkedin_url = COALESCE(NULLIF($7, ''), linkedin_url),
                phone = COALESCE(NULLIF($8, ''), phone),
                notes = $9,
                source = $10,
                contact_created_date = COALESCE(contact_created_date, $11),
                emails = COALESCE($14::jsonb, emails),
                phones = COALESCE($15::jsonb, phones),
                updated_at = CURRENT_TIMESTAMP
              WHERE id = $12 AND user_id = $13
            `, [
              dup.merged.full_name,
              dup.merged.first_name,
              dup.merged.last_name,
              dup.merged.email,
              dup.merged.company,
              dup.merged.job_title,
              dup.merged.linkedin_url,
              dup.merged.phone,
              dup.merged.notes,
              dup.merged.source,
              dup.merged.contact_created_date ? new Date(dup.merged.contact_created_date) : null,
              dup.existing.id,
              userId,
              dup.merged.emails ? JSON.stringify(dup.merged.emails) : null,
              dup.merged.phones ? JSON.stringify(dup.merged.phones) : null
            ]);

            result.duplicatesUpdated++;
          } catch (error) {
            result.errors.push({
              contact: dup.existing.full_name,
              error: error.message
            });
          }
        }
      }

      // Add unique contacts
      if (addUniqueContacts) {
        for (const contact of deduplicationResult.uniqueContacts) {
          try {
            // Format connected date - handle both Date objects and strings
            let connectedNote = null;
            if (contact.connectedOn) {
              const date = contact.connectedOn instanceof Date 
                ? contact.connectedOn 
                : new Date(contact.connectedOn);
              connectedNote = `LinkedIn connection: ${date.toLocaleDateString()}`;
            }

            await client.query(`
              INSERT INTO contacts (
                user_id, full_name, first_name, last_name, email,
                company, job_title, linkedin_url, source, notes, contact_created_date
              )
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
            `, [
              userId,
              contact.fullName,
              contact.firstName,
              contact.lastName,
              contact.email,
              contact.company,
              contact.jobTitle,
              contact.linkedinUrl,
              contact.source,
              connectedNote,
              contact.connectedOn ? new Date(contact.connectedOn) : null
            ]);

            result.uniqueAdded++;
          } catch (error) {
            result.errors.push({
              contact: contact.fullName,
              error: error.message
            });
          }
        }
      }

      // Log import
      await client.query(`
        INSERT INTO sync_history (
          user_id, sync_type, status, contacts_synced,
          started_at, completed_at
        )
        VALUES ($1, 'linkedin_import', 'success', $2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `, [userId, result.duplicatesUpdated + result.uniqueAdded]);

      await client.query('COMMIT');
      return result;

    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

module.exports = LinkedInImportModel;