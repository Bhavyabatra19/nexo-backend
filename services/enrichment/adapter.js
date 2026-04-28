/**
 * Enrichment Adapter — swap providers by changing ENRICHMENT_PROVIDER env var.
 * Supports: linkdapi (default), scrapingdog
 * Falls back to secondary provider on failure.
 */

const linkdapi    = require('./linkdapi');
const scrapingdog = require('./scrapingdog');
const brightdata  = require('./brightdata');
const db = require('../../db');
const logger = require('../../logger');

// proxycurl.js kept in repo for reference but Proxycurl shut down July 2025.
// Default provider is now linkdapi; scrapingdog is fallback; brightdata for bulk.
const providers = { linkdapi, scrapingdog, brightdata };

async function enrichContact(contactId, linkedinUrl, userId) {
  const primary   = process.env.ENRICHMENT_PROVIDER || 'linkdapi';
  const secondary = primary === 'brightdata' ? 'scrapingdog'
                  : primary === 'linkdapi'   ? 'scrapingdog' : 'linkdapi';

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
      connections_count   = COALESCE($10, connections_count),
      followers_count     = COALESCE($11, followers_count),
      last_post           = COALESCE($12::jsonb, last_post),
      last_post_at        = COALESCE($13::timestamptz, last_post_at),
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
    result.connections_count ?? null,
    result.followers_count ?? null,
    result.last_post ? JSON.stringify(result.last_post) : null,
    result.last_post?.posted_at || null,
  ]);

  // Log usage
  await db.query(`
    INSERT INTO enrichment_usage (user_id, contact_id, provider, credits_used)
    VALUES ($1, $2, $3, 1)
  `, [userId, contactId, result._provider]);

  return result;
}

/**
 * Bulk-enrich a list of {contactId, linkedinUrl} objects via Bright Data.
 * Batches up to 100 URLs per API call. Returns counts: enriched, failed.
 */
async function enrichBulkViaBrightData(items, userId) {
  const BATCH_SIZE = 100;
  let enriched = 0, failed = 0;

  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const batch = items.slice(i, i + BATCH_SIZE);
    const urls  = batch.map(b => b.linkedinUrl);

    let results;
    try {
      results = await brightdata.enrichBatch(urls);
    } catch (err) {
      logger.error(`[Enrichment] Bright Data batch failed: ${err.message}`);
      failed += batch.length;
      continue;
    }

    for (let j = 0; j < batch.length; j++) {
      const { contactId } = batch[j];
      const result = results[j];

      if (!result) {
        await db.query(`UPDATE contacts SET enrichment_status = 'failed' WHERE id = $1`, [contactId]);
        failed++;
        continue;
      }

      await db.query(`
        UPDATE contacts SET
          enrichment_status   = 'enriched',
          enriched_at         = NOW(),
          enrichment_provider = 'brightdata',
          bio                 = COALESCE($1, bio),
          skills              = COALESCE($2::jsonb, skills),
          experience          = COALESCE($3::jsonb, experience),
          education           = COALESCE($4::jsonb, education),
          photo_url           = COALESCE($5, photo_url),
          job_title           = COALESCE($6, job_title),
          company             = COALESCE($7, company),
          connections_count   = COALESCE($9, connections_count),
          followers_count     = COALESCE($10, followers_count),
          last_post           = COALESCE($11::jsonb, last_post),
          last_post_at        = COALESCE($12::timestamptz, last_post_at),
          pinecone_indexed    = false
        WHERE id = $8
      `, [
        result.bio || null,
        result.skills?.length      ? JSON.stringify(result.skills)       : null,
        result.experiences?.length ? JSON.stringify(result.experiences)  : null,
        result.education?.length   ? JSON.stringify(result.education)    : null,
        result.profile_pic_url     || null,
        result.occupation          || null,
        result.company             || null,
        contactId,
        result.connections_count ?? null,
        result.followers_count ?? null,
        result.last_post ? JSON.stringify(result.last_post) : null,
        result.last_post?.posted_at || null,
      ]);

      await db.query(`
        INSERT INTO enrichment_usage (user_id, contact_id, provider, credits_used)
        VALUES ($1, $2, 'brightdata', 1)
      `, [userId, contactId]);

      enriched++;
    }
  }

  return { enriched, failed };
}

module.exports = { enrichContact, enrichBulkViaBrightData };
