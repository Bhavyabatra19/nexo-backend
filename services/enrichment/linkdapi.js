/**
 * LinkdAPI enrichment provider (replaces dead Proxycurl)
 * Fetches public LinkedIn profile data — no cookies, GDPR compliant.
 * Docs: https://linkdapi.com/docs
 * Auth: X-linkdapi-apikey header
 * Cost: ~$0.005–0.01/profile (same ballpark as old Proxycurl)
 */

const axios = require('axios');

async function enrich(linkedinUrl) {
  if (!process.env.LINKDAPI_KEY) {
    throw new Error('LINKDAPI_KEY not configured');
  }

  const username = extractUsername(linkedinUrl);
  if (!username) throw new Error(`Cannot extract LinkedIn username from: ${linkedinUrl}`);

  const response = await axios.get('https://linkdapi.com/api/v1/profile/full', {
    params: { username },
    headers: {
      'X-linkdapi-apikey': process.env.LINKDAPI_KEY,
    },
    timeout: 30000,
  });

  // LinkdAPI wraps data in { success, statusCode, data: { ... } }
  const d = response.data?.data || response.data;
  if (!d) throw new Error('No data returned from LinkdAPI');

  const currentExp = (d.experiences || []).find(e => !e.endDate) || d.experiences?.[0];

  return {
    bio:             d.summary || d.about || null,
    occupation:      d.headline || currentExp?.title || null,
    company:         currentExp?.company || d.company || null,
    profile_pic_url: d.profilePictureURL || d.profilePicUrl || null,
    skills:          (d.skills || []).map(s => s.name || s).filter(Boolean),
    experiences:     (d.experiences || []).map(e => ({
      title:   e.title,
      company: e.company,
      start:   e.startDate,
      end:     e.endDate,
      current: !e.endDate,
    })),
    education:       (d.education || []).map(e => ({
      school: e.school,
      degree: e.degree,
      field:  e.fieldOfStudy,
      start:  e.startDate,
      end:    e.endDate,
    })),
    city:        d.location?.city || d.location?.split?.(',')[0]?.trim() || null,
    country:     d.location?.country || d.location?.split?.(',').slice(-1)[0]?.trim() || null,
    connections: d.connectionsCount || null,
  };
}

function extractUsername(url) {
  const match = (url || '').match(/linkedin\.com\/in\/([^/?#]+)/);
  return match ? match[1].replace(/\/$/, '') : null;
}

module.exports = { enrich };
