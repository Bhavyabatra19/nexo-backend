/**
 * LinkedIn Scraper Service
 *
 * Handles data received from the Nexo Chrome Extension.
 * The extension reads DOM from LinkedIn pages as users browse normally.
 * This service processes and saves that data.
 *
 * Approach: DOM-reading only (same as Dex, Clay, folkX).
 * No cookie injection, no bulk API calls — stays within ToS gray zone.
 *
 * Two modes:
 * 1. Profile capture: single profile page visited
 * 2. Connections scan: batch from /mynetwork page (user-initiated)
 */

const db = require('../db');
const logger = require('../logger');
const { recomputeConfidence } = require('./confidence');
const { enrichQueue } = require('../workers/queues');

/**
 * Process a single LinkedIn profile captured by the extension.
 * Called on every linkedin.com/in/* page visit.
 */
async function processExtensionProfile(userId, profileData) {
  const {
    linkedin_url, name, headline, company, location,
    connection_degree, profile_pic, captured_at,
    bio, experience, education, skills,
  } = profileData;

  if (!linkedin_url || !name) return null;

  const cleanUrl = normalizeLinkedInUrl(linkedin_url);

  // Log the scrape regardless
  await db.query(`
    INSERT INTO linkedin_scrape_log (user_id, linkedin_url, source, raw_data)
    VALUES ($1, $2, 'extension', $3)
  `, [userId, cleanUrl, JSON.stringify(profileData)]);

  // Check if contact already exists
  const { rows: existing } = await db.query(
    `SELECT id, company, job_title, connection_tier FROM contacts
     WHERE user_id = $1 AND linkedin_url = $2 LIMIT 1`,
    [userId, cleanUrl]
  );

  const hasRichData = (experience?.length > 0) || (education?.length > 0);

  if (existing.length) {
    const contact = existing[0];
    const changes = detectProfileChanges(contact, { company, title: headline });

    // Always update rich data if the extension captured it (browsing a profile page)
    if (changes.length || hasRichData) {
      await db.query(`
        UPDATE contacts SET
          company          = COALESCE($1, company),
          job_title        = COALESCE($2, job_title),
          photo_url        = COALESCE($3, photo_url),
          bio              = COALESCE($4, bio),
          experience       = CASE WHEN $5::jsonb IS NOT NULL THEN $5::jsonb ELSE experience END,
          education        = CASE WHEN $6::jsonb IS NOT NULL THEN $6::jsonb ELSE education END,
          skills           = CASE WHEN $7::jsonb IS NOT NULL THEN $7::jsonb ELSE skills END,
          enrichment_status = CASE WHEN $5::jsonb IS NOT NULL THEN 'enriched' ELSE enrichment_status END,
          enrichment_provider = CASE WHEN $5::jsonb IS NOT NULL THEN 'extension' ELSE enrichment_provider END,
          enriched_at      = CASE WHEN $5::jsonb IS NOT NULL THEN NOW() ELSE enriched_at END,
          custom_fields    = custom_fields || $8::jsonb,
          pinecone_indexed = false
        WHERE id = $9
      `, [
        company, headline, profile_pic,
        bio || null,
        experience?.length ? JSON.stringify(experience) : null,
        education?.length  ? JSON.stringify(education)  : null,
        skills?.length     ? JSON.stringify(skills)     : null,
        JSON.stringify({ last_change_detected: new Date(), changes }),
        contact.id,
      ]);

      if (changes.length) logger.info(`[LinkedInScraper] Updated ${name}: ${changes.join(', ')}`);
    }

    await db.query(
      `UPDATE linkedin_scrape_log SET contact_id = $1, processed = true
       WHERE user_id = $2 AND linkedin_url = $3 AND processed = false`,
      [contact.id, userId, cleanUrl]
    );

    await recomputeConfidence(contact.id);
    return { action: 'updated', contactId: contact.id, changes };
  }

  // New contact from extension
  const names = splitName(name);

  // If we have rich data from the DOM, mark as enriched immediately
  const enrichmentStatus = hasRichData ? 'enriched' : 'queued';

  const { rows: inserted } = await db.query(`
    INSERT INTO contacts
      (user_id, full_name, first_name, last_name, job_title, company,
       linkedin_url, photo_url, bio, experience, education, skills,
       source, enrichment_status, enrichment_provider, enriched_at, pinecone_indexed)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
            $10::jsonb, $11::jsonb, $12::jsonb,
            'chrome_extension', $13,
            CASE WHEN $13 = 'enriched' THEN 'extension' ELSE NULL END,
            CASE WHEN $13 = 'enriched' THEN NOW() ELSE NULL END,
            false)
    ON CONFLICT DO NOTHING
    RETURNING id
  `, [
    userId, name, names.first, names.last, headline, company, cleanUrl, profile_pic,
    bio || null,
    experience?.length ? JSON.stringify(experience) : '[]',
    education?.length  ? JSON.stringify(education)  : '[]',
    skills?.length     ? JSON.stringify(skills)     : '[]',
    enrichmentStatus,
  ]);

  if (!inserted.length) return null;

  const contactId = inserted[0].id;

  await db.query(
    `UPDATE linkedin_scrape_log SET contact_id = $1, processed = true
     WHERE user_id = $2 AND linkedin_url = $3 AND processed = false`,
    [contactId, userId, cleanUrl]
  );

  // Only queue enrichment if we didn't get rich data from the DOM.
  // jobId = contactId ensures the same contact is never double-queued.
  if (!hasRichData) {
    await enrichQueue.add('enrich', { contactId, linkedinUrl: cleanUrl, userId }, {
      jobId:    `enrich:${contactId}`,
      priority: 5,
      attempts: 3,
      backoff:  { type: 'exponential', delay: 2000 },
    });
  }

  await recomputeConfidence(contactId);
  return { action: 'created', contactId, enrichedByExtension: hasRichData };
}

/**
 * Process a batch of connections from the extension's connections scan.
 * Extension scrolls /mynetwork and sends batches of 50.
 */
async function processConnectionsBatch(userId, connections) {
  const results = { created: 0, updated: 0, skipped: 0 };

  for (const conn of connections) {
    try {
      const result = await processExtensionProfile(userId, conn);
      if (!result) { results.skipped++; continue; }
      if (result.action === 'created') results.created++;
      if (result.action === 'updated') results.updated++;
    } catch (err) {
      logger.warn(`[LinkedInScraper] Batch item failed: ${err.message}`);
      results.skipped++;
    }
  }

  return results;
}

function detectProfileChanges(existing, incoming) {
  const changes = [];
  if (incoming.company && incoming.company !== existing.company) {
    changes.push(`company: ${existing.company} → ${incoming.company}`);
  }
  if (incoming.title && incoming.title !== existing.job_title) {
    changes.push(`title: ${existing.job_title} → ${incoming.title}`);
  }
  return changes;
}

function normalizeLinkedInUrl(url) {
  try {
    const u = new URL(url.startsWith('http') ? url : `https://${url}`);
    return `https://www.linkedin.com${u.pathname.replace(/\/$/, '')}`;
  } catch { return url; }
}

function splitName(fullName) {
  const parts = (fullName || '').trim().split(/\s+/);
  return {
    first: parts[0] || '',
    last:  parts.slice(1).join(' ') || '',
  };
}

module.exports = { processExtensionProfile, processConnectionsBatch };
