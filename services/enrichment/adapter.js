/**
 * Enrichment Adapter — swap providers by changing ENRICHMENT_PROVIDER env var.
 * Supports: proxycurl (default), scrapingdog
 * Falls back to secondary provider on failure.
 */

const proxycurl = require('./proxycurl');
const scrapingdog = require('./scrapingdog');
const db = require('../../db');
const logger = require('../../logger');

const providers = { proxycurl, scrapingdog };

async function enrichContact(contactId, linkedinUrl, userId) {
  const primary   = process.env.ENRICHMENT_PROVIDER || 'proxycurl';
  const secondary = primary === 'proxycurl' ? 'scrapingdog' : 'proxycurl';

  let result = null;

  // Try primary
  try {
    result = await providers[primary].enrich(linkedinUrl);
    result._provider = primary;
  } catch (err) {
    logger.warn(`[Enrichment] Primary provider ${primary} failed: ${err.message}. Trying ${secondary}`);
    try {
      result = await providers[secondary].enrich(linkedinUrl);
      result._provider = secondary;
    } catch (err2) {
      logger.error(`[Enrichment] Both providers failed for ${linkedinUrl}: ${err2.message}`);
      await db.query(
        `UPDATE contacts SET enrichment_status = 'failed' WHERE id = $1`,
        [contactId]
      );
      return null;
    }
  }

  if (!result) return null;

  // Persist enriched data
  await db.query(`
    UPDATE contacts SET
      enrichment_status   = 'enriched',
      enriched_at         = NOW(),
      enrichment_provider = $1,
      bio                 = COALESCE($2, bio),
      skills              = COALESCE($3::jsonb, skills),
      experience          = COALESCE($4::jsonb, experience),
      education           = COALESCE($5::jsonb, education),
      photo_url           = COALESCE($6, photo_url),
      job_title           = COALESCE($7, job_title),
      company             = COALESCE($8, company),
      pinecone_indexed    = false
    WHERE id = $9
  `, [
    result._provider,
    result.bio || null,
    result.skills?.length ? JSON.stringify(result.skills) : null,
    result.experiences?.length ? JSON.stringify(result.experiences) : null,
    result.education?.length ? JSON.stringify(result.education) : null,
    result.profile_pic_url || null,
    result.occupation || result.title || null,
    result.company || null,
    contactId,
  ]);

  // Log usage
  await db.query(`
    INSERT INTO enrichment_usage (user_id, contact_id, provider, credits_used)
    VALUES ($1, $2, $3, 1)
  `, [userId, contactId, result._provider]);

  return result;
}

module.exports = { enrichContact };
