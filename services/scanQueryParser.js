/**
 * scanQueryParser — turns a chat-style ask ("who can intro me to a Series B
 * fintech founder in NYC?") into structured filters the orchestrator can
 * use for retrieval and ranking.
 *
 * Output shape (always returns an object, never throws):
 *   {
 *     role:      string|null,   // "founder", "VP Engineering", ...
 *     industry:  string|null,   // "fintech", "healthtech", ...
 *     stage:     string|null,   // "series_b", "seed", "public", ...
 *     geo:       string|null,   // "NYC", "San Francisco", ...
 *     keywords:  string[],      // free-text terms to bias retrieval
 *     query:     string,        // search string used for the vector query
 *   }
 *
 * If GEMINI_API_KEY is missing or the call fails, falls back to a no-LLM
 * heuristic that just packs the raw text into `query` + `keywords` so the
 * scan still returns something useful.
 */

const { GoogleGenAI } = require('@google/genai');
const logger = require('../logger');

const SYSTEM = `You extract structured filters from a user's natural-language network ask.
Return ONLY valid JSON with these keys (use null for unknowns, never omit keys):
{ "role": string|null, "industry": string|null, "stage": string|null, "geo": string|null, "keywords": string[] }

- role: job title or function the target person holds, normalized to a short phrase
- industry: market vertical (fintech, healthtech, dev tools, climate, etc.)
- stage: company stage if implied (seed, series_a, series_b, growth, public, ...)
- geo: city, region, or country if specified
- keywords: 1-6 extra terms (other than the four above) that bias the search

Do not invent values. If the user did not mention something, use null (or [] for keywords).`;

function fallback(text) {
  const cleaned = (text || '').trim();
  return {
    role:     null,
    industry: null,
    stage:    null,
    geo:      null,
    keywords: cleaned ? cleaned.split(/\s+/).slice(0, 8) : [],
    query:    cleaned,
  };
}

async function parseScanQuery(userText) {
  const text = (userText || '').trim();
  if (!text) return fallback('');

  if (!process.env.GEMINI_API_KEY) {
    logger.warn('[scanQueryParser] GEMINI_API_KEY missing — using fallback parser');
    return fallback(text);
  }

  try {
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const resp = await ai.models.generateContent({
      model: 'gemini-2.0-flash-lite',
      contents: [
        { role: 'user', parts: [{ text: `${SYSTEM}\n\nAsk: ${text}\n\nJSON:` }] },
      ],
      config: { responseMimeType: 'application/json' },
    });

    const raw = resp?.text || resp?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const parsed = JSON.parse(raw);

    const role     = typeof parsed.role     === 'string' ? parsed.role.trim()     || null : null;
    const industry = typeof parsed.industry === 'string' ? parsed.industry.trim() || null : null;
    const stage    = typeof parsed.stage    === 'string' ? parsed.stage.trim()    || null : null;
    const geo      = typeof parsed.geo      === 'string' ? parsed.geo.trim()      || null : null;
    const keywords = Array.isArray(parsed.keywords)
      ? parsed.keywords.filter(k => typeof k === 'string' && k.trim()).slice(0, 8)
      : [];

    const queryParts = [role, industry, stage, geo, ...keywords].filter(Boolean);
    const query = queryParts.length ? queryParts.join(' ') : text;

    return { role, industry, stage, geo, keywords, query };
  } catch (err) {
    logger.error(`[scanQueryParser] LLM parse failed: ${err.message}`);
    return fallback(text);
  }
}

module.exports = { parseScanQuery };
