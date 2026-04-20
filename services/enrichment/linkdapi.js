/**
 * LinkdAPI enrichment provider (replaces dead Proxycurl)
 * Fetches public LinkedIn profile data — no cookies, GDPR compliant.
 * Docs: https://linkdapi.com/docs
 * Auth: X-linkdapi-apikey header
 * Cost: ~$0.005–0.01/profile
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
    headers: { 'X-linkdapi-apikey': process.env.LINKDAPI_KEY },
    timeout: 30000,
  });

  // Response shape: { success, statusCode, data: { ... } }
  if (!response.data?.success) {
    throw new Error(`LinkdAPI error: ${response.data?.message || 'unknown'}`);
  }
  const d = response.data.data;
  if (!d) throw new Error('No data returned from LinkdAPI');

  // fullPositions has full work history; end.year === 0 means current role
  const positions = d.fullPositions || d.position || [];
  const currentPos = positions.find(p => !p.end?.year) || positions[0];

  return {
    bio:             d.summary || null,
    occupation:      d.headline || currentPos?.title || null,
    company:         currentPos?.companyName || null,
    profile_pic_url: d.profilePicture || null,
    skills:          (d.skills || []).map(s => s.name || s).filter(Boolean),
    experiences:     positions.map(p => ({
      title:   p.title,
      company: p.companyName,
      start:   p.start?.year || null,
      end:     p.end?.year || null,
      current: !p.end?.year,
    })),
    education:       (d.educations || []).map(e => ({
      school: e.schoolName,
      degree: e.degree,
      field:  e.fieldOfStudy,
      start:  e.start?.year || null,
      end:    e.end?.year || null,
    })),
    city:        d.geo?.city || null,
    country:     d.geo?.country || null,
    connections: d.connectionsCount || null,
  };
}

function extractUsername(url) {
  const match = (url || '').match(/linkedin\.com\/in\/([^/?#]+)/);
  return match ? match[1].replace(/\/$/, '') : null;
}

module.exports = { enrich };
