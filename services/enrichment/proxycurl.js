/**
 * Proxycurl enrichment provider
 * Fetches public LinkedIn profile data — GDPR compliant, no cookies used.
 * Docs: https://nubela.co/proxycurl/docs
 */

const axios = require('axios');

async function enrich(linkedinUrl) {
  if (!process.env.PROXYCURL_API_KEY) {
    throw new Error('PROXYCURL_API_KEY not configured');
  }

  const cleanUrl = normalizeLinkedInUrl(linkedinUrl);

  const response = await axios.get('https://nubela.co/proxycurl/api/v2/linkedin', {
    params: {
      url: cleanUrl,
      skills: 'include',
      use_cache: 'if-present',
      fallback_to_cache: 'on-error',
    },
    headers: {
      'Authorization': `Bearer ${process.env.PROXYCURL_API_KEY}`,
    },
    timeout: 30000,
  });

  const d = response.data;

  return {
    bio:            d.summary || null,
    occupation:     d.occupation || null,
    company:        d.experiences?.[0]?.company || null,
    profile_pic_url:d.profile_pic_url || null,
    skills:         (d.skills || []).map(s => s.name || s),
    experiences:    (d.experiences || []).map(e => ({
      title:   e.title,
      company: e.company,
      start:   e.starts_at,
      end:     e.ends_at,
      current: !e.ends_at,
    })),
    education:      (d.education || []).map(e => ({
      school:  e.school,
      degree:  e.degree_name,
      field:   e.field_of_study,
      start:   e.starts_at?.year,
      end:     e.ends_at?.year,
    })),
    city:           d.city || null,
    country:        d.country_full_name || null,
    connections:    d.connections || null,
  };
}

function normalizeLinkedInUrl(url) {
  // Ensure it's the canonical profile URL without trailing params
  try {
    const u = new URL(url.startsWith('http') ? url : `https://${url}`);
    return `https://www.linkedin.com${u.pathname.replace(/\/$/, '')}`;
  } catch {
    return url;
  }
}

module.exports = { enrich };
