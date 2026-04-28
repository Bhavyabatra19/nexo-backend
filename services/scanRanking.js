/**
 * scanRanking — score and order results from the network scan.
 *
 *   total = vector_score × bridge_warmth × stage_match × geo_match × recency_decay
 *
 * Each multiplier sits in [0.5, 1.5] so we never throw away a good vector
 * match because of a single weak signal. Until mig 033 lands `warmth_score`,
 * we approximate bridge warmth from `confidence_score` (mig 023) on the
 * bridge contact + a tier bump for `connection_tier`.
 *
 * Inputs are raw rows from the orchestrator. Output adds `score` and
 * `score_breakdown` so the UI can show *why* a result ranks where it does.
 */

const TIER_WEIGHT = { close: 1.5, acquaintance: 1.15, social: 1.0 };

function bridgeWarmth(bridge) {
  // For 1st-degree results the "bridge" is the contact themselves.
  if (!bridge) return 1.0;
  const conf = typeof bridge.confidence_score === 'number' ? bridge.confidence_score : 0.5;
  const tier = TIER_WEIGHT[bridge.connection_tier] || 1.0;
  // confidence ∈ [0,1] → multiplier ∈ [0.7, 1.3]
  return tier * (0.7 + 0.6 * conf);
}

function stageMatchBoost(target, parsed) {
  if (!parsed?.stage) return 1.0;
  const haystack = [target.company, target.bio, target.job_title].filter(Boolean).join(' ').toLowerCase();
  return haystack.includes(parsed.stage.replace('_', ' ').toLowerCase()) ? 1.2 : 1.0;
}

function geoMatchBoost(target, parsed) {
  if (!parsed?.geo) return 1.0;
  const needle = parsed.geo.toLowerCase();
  const haystack = [target.address, target.bio].filter(Boolean).join(' ').toLowerCase();
  return haystack.includes(needle) ? 1.25 : 1.0;
}

function recencyDecay(target) {
  // Bridge that hasn't been touched in a year drags warmth down a notch.
  const lc = target.last_contacted ? new Date(target.last_contacted).getTime() : null;
  if (!lc) return 0.9;
  const days = Math.max(0, (Date.now() - lc) / (24 * 60 * 60 * 1000));
  if (days < 30) return 1.1;
  if (days < 180) return 1.0;
  if (days < 365) return 0.9;
  return 0.75;
}

function rankResults(results, parsed) {
  const ranked = results.map((r) => {
    const vec     = typeof r.vector_score === 'number' ? r.vector_score : 0.5;
    const bridge  = bridgeWarmth(r.bridge);
    const stage   = stageMatchBoost(r, parsed);
    const geo     = geoMatchBoost(r, parsed);
    const recency = recencyDecay(r.bridge || r);
    const score   = vec * bridge * stage * geo * recency;
    return {
      ...r,
      score,
      score_breakdown: { vector_score: vec, bridge_warmth: bridge, stage_boost: stage, geo_boost: geo, recency_decay: recency },
    };
  });

  ranked.sort((a, b) => b.score - a.score);
  return ranked;
}

module.exports = { rankResults };
