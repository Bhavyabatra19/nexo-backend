/**
 * Scrapingdog enrichment provider (fallback)
 * Uses real-time public scraping — GDPR compliant.
 * Docs: https://www.scrapingdog.com/linkedin-scraper-api
 */

const axios = require('axios');

async function enrich(linkedinUrl) {
  if (!process.env.SCRAPINGDOG_API_KEY) {
    throw new Error('SCRAPINGDOG_API_KEY not configured');
  }

  const response = await axios.get('https://api.scrapingdog.com/linkedin', {
    params: {
      api_key: process.env.SCRAPINGDOG_API_KEY,
      type:    'profile',
      linkId:  extractProfileId(linkedinUrl),
    },
    timeout: 30000,
  });

  const d = Array.isArray(response.data) ? response.data[0] : response.data;
  if (!d) throw new Error('No data returned from Scrapingdog');

  return {
    bio:            d.about || null,
    occupation:     d.title || null,
    company:        d.company || null,
    profile_pic_url:d.profilePic || null,
    skills:         (d.skills || []).map(s => s.name || s),
    experiences:    (d.experience || []).map(e => ({
      title:   e.title,
      company: e.companyName,
      start:   e.date1,
      end:     e.date2,
      current: e.date2?.toLowerCase().includes('present'),
    })),
    education:      (d.education || []).map(e => ({
      school: e.schoolName,
      degree: e.degree,
      field:  e.fieldOfStudy,
    })),
    city:    d.location?.split(',')[0]?.trim() || null,
    country: d.location?.split(',').slice(-1)[0]?.trim() || null,
  };
}

function extractProfileId(url) {
  // linkedin.com/in/username → return username
  const match = url.match(/linkedin\.com\/in\/([^/?#]+)/);
  return match ? match[1] : url;
}

module.exports = { enrich };
