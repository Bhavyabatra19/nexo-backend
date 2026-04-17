const { GoogleGenAI } = require('@google/genai');
const stringSimilarity = require('string-similarity');
const crypto = require('crypto');
const AITokenService = require('./aiTokenService');

/**
 * AI Deduplication & Golden Profiling Service
 *
 * Tiered pipeline:
 *   0. Intra-batch dedup  – remove exact duplicates within the incoming list
 *   1. Pre-filter         – discard invalid / incomplete contacts before any matching
 *   2. Rule-based match   – exact email / phone / LinkedIn → definite duplicate (no AI cost)
 *   3. AI match           – only ambiguous cases with a weak-but-real signal reach the LLM
 *   4. Result assembly    – build golden profiles & change-logs
 */
class AIDeduplicationService {
  constructor() {
    this.genAI = null;
    if (process.env.GEMINI_API_KEY) {
      this.genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    }
    // In-memory hash cache: pairHash → AI result (avoids re-processing within a session)
    this._aiCache = new Map();
  }

  // ═══════════════════════════════════════════════════════════════
  // PHASE 0 – INTRA-BATCH DEDUPLICATION
  // Remove obvious duplicates within the incoming list before hitting the DB.
  // ═══════════════════════════════════════════════════════════════

  /**
   * Remove duplicate contacts within the incoming array itself.
   * Priority: email > linkedin > phone > exact name.
   * First occurrence wins; subsequent duplicates are dropped.
   */
  _dedupeIncoming(contacts) {
    const seenEmail    = new Map(); // email → winning contact
    const seenLinkedin = new Map();
    const seenPhone    = new Map();
    const seenName     = new Map();
    const kept = [];

    for (const c of contacts) {
      const email    = this._norm(c.email);
      const linkedin = this._normLinkedin(c.linkedinUrl);
      const phone    = this._normPhone(c.phone);
      const name     = this._norm(c.fullName);

      if (email    && seenEmail.has(email))    continue;
      if (linkedin && seenLinkedin.has(linkedin)) continue;
      if (phone    && phone.length >= 7 && seenPhone.has(phone)) continue;
      if (name     && seenName.has(name))    continue;

      if (email)    seenEmail.set(email, true);
      if (linkedin) seenLinkedin.set(linkedin, true);
      if (phone && phone.length >= 7) seenPhone.set(phone, true);
      if (name)     seenName.set(name, true);

      kept.push(c);
    }

    return kept;
  }

  // ═══════════════════════════════════════════════════════════════
  // PHASE 1 – PRE-FILTER
  // Discard contacts that are garbage, incomplete, or clearly test data.
  // ═══════════════════════════════════════════════════════════════

  /** Returns true if the email address is obviously invalid / test data */
  _isInvalidEmail(email) {
    if (!email) return false;
    const patterns = [
      /^test@/i, /^dummy@/i, /^example@/i, /^noreply@/i,
      /^no-reply@/i, /^placeholder/i, /^fake@/i, /^user@/i,
      /@test\.com$/i, /@example\.com$/i, /@mailinator\.com$/i,
      /@guerrillamail/i, /@yopmail/i,
    ];
    return patterns.some(r => r.test(email));
  }

  /** Returns true if this contact should be discarded before any matching */
  _shouldDiscard(c) {
    const name     = this._norm(c.fullName);
    const email    = this._norm(c.email);
    const phone    = (c.phone || '').trim();
    const linkedin = (c.linkedinUrl || '').trim();

    // Must have at least one real identifying field
    if (!name && !email && !phone && !linkedin) return true;

    // Reject invalid emails
    if (email && this._isInvalidEmail(email)) return true;

    // Reject placeholder names
    if (['test', 'dummy', 'placeholder', 'unknown', 'n/a', 'na', 'tbd'].includes(name)) return true;

    return false;
  }

  // ═══════════════════════════════════════════════════════════════
  // PHASE 2 – RULE-BASED MATCHING
  // Free, instant matching that eliminates the majority of clear-cut duplicates.
  // ═══════════════════════════════════════════════════════════════

  _norm(s)         { return (s || '').toLowerCase().trim(); }
  _normPhone(p)    { return (p || '').replace(/\D/g, ''); }

  /**
   * Compare two phone numbers for equality, tolerating country-code prefix
   * differences.
   *
   * "+91-9876543210" vs "9876543210" → both tail 10 digits match → TRUE
   * "9876543210"     vs "9876543210" → exact match               → TRUE
   * "9876543210"     vs "9876543211" → different                 → FALSE
   *
   * Rules:
   *  - Strip all non-digits first.
   *  - Both must have ≥ 7 digits (avoids matching very short extension-only values).
   *  - If equal after stripping → match.
   *  - Otherwise compare the last 10 digits of each; both tails must be ≥ 8 digits
   *    long to prevent false positives with short local numbers.
   */
  _phonesMatch(a, b) {
    const d1 = (a || '').replace(/\D/g, '');
    const d2 = (b || '').replace(/\D/g, '');
    if (d1.length < 7 || d2.length < 7) return false;
    if (d1 === d2) return true;
    const t1 = d1.length >= 10 ? d1.slice(-10) : d1;
    const t2 = d2.length >= 10 ? d2.slice(-10) : d2;
    return t1.length >= 8 && t1 === t2;
  }

  _normLinkedin(u) {
    if (!u) return '';
    return u.toLowerCase()
      .replace(/^https?:\/\/(www\.)?linkedin\.com\/in\//, '')
      .replace(/\/$/, '');
  }

  /**
   * Classify the incoming contact against all DB records.
   *
   * Returns:
   *   { certainty: 'definite', match, matchReason, confidenceScore }
   *   { certainty: 'probable', candidates: [...], matchReason }
   *   { certainty: 'none' }
   */
  _classifyRuleMatch(incoming, dbRecords) {
    const iEmail    = this._norm(incoming.email);
    const iLinkedin = this._normLinkedin(incoming.linkedinUrl);
    const iName     = this._norm(incoming.fullName);
    const iCompany  = this._norm(incoming.company);

    // ── Pass 1: Definite matches (stop on first hit) ──
    for (const db of dbRecords) {
      const dEmail    = this._norm(db.email);
      const dLinkedin = this._normLinkedin(db.linkedinUrl);

      if (iEmail && dEmail && iEmail === dEmail) {
        return { certainty: 'definite', match: db, matchReason: 'Exact email match', confidenceScore: 100 };
      }
      if (iLinkedin && dLinkedin && iLinkedin === dLinkedin) {
        return { certainty: 'definite', match: db, matchReason: 'Exact LinkedIn URL match', confidenceScore: 100 };
      }
      if (this._phonesMatch(incoming.phone, db.phone)) {
        return { certainty: 'definite', match: db, matchReason: 'Exact phone match', confidenceScore: 95 };
      }
    }

    // ── Pass 1.5: High-confidence combo (corp email domain + company + name) ──
    // Resolves without AI — if they share a corporate email domain, same company,
    // and high name similarity, they are almost certainly the same person.
    if (iEmail) {
      const iDomain = iEmail.split('@')[1];
      const genericDomains = ['gmail.com','yahoo.com','hotmail.com','outlook.com','icloud.com','protonmail.com','live.com','msn.com','ymail.com'];
      const isCorpDomain = iDomain && !genericDomains.includes(iDomain);
      if (isCorpDomain) {
        for (const db of dbRecords) {
          const dEmail   = this._norm(db.email);
          const dName    = this._norm(db.fullName);
          const dCompany = this._norm(db.company);
          const dDomain  = dEmail ? dEmail.split('@')[1] : null;
          if (dDomain === iDomain && iCompany && dCompany && iCompany === dCompany) {
            const nameSim = (iName && dName) ? stringSimilarity.compareTwoStrings(iName, dName) : 0;
            if (nameSim >= 0.75) {
              return { certainty: 'definite', match: db, matchReason: 'Corporate email domain + company + name match', confidenceScore: 92 };
            }
          }
        }
      }
    }

    // ── Pass 2: Collect probable candidates for AI ──
    //
    // COMPOSITE SIGNAL SCORING — a contact only reaches AI when multiple
    // signals combine to a meaningful confidence score.  Single weak signals
    // (e.g. a 0.35 name similarity alone) are NOT enough; they would flood AI
    // with clearly-different people who happen to share a few letters.
    //
    // Signal weights (summed into compositeScore, max meaningful = 100):
    //   nameSim ≥ 0.85 alone            → 90 pts  (near-identical names)
    //   nameSim ≥ 0.70                  → 55 pts
    //   nameSim ≥ 0.55                  → 30 pts
    //   nameSim ≥ 0.40                  →  5 pts  (slight overlap only)
    //   sameCompany                     → 25 pts
    //   sameEmailDomain (corp only)     → 20 pts
    //
    // Thresholds:
    //   compositeScore ≥ 75  → strong  (high-confidence ambiguous case)
    //   compositeScore ≥ 65  → weak    (only when ≥ 2 meaningful signals combined)
    //   compositeScore < 65  → skip    (not worth an AI call)
    //
    // Examples that should NOT reach AI:
    //   "Robert Chen" vs "Rebecca Cheng"  → nameSim ≈ 0.46 → 5 pts → skip
    //   "Alice Wang"  vs "Alan Wright"    → nameSim ≈ 0.38 → 5 pts → skip
    //   sameCompany only, 0 name overlap  → 25 pts alone   → skip
    //   "Li Wei" vs "Wei Li" + sameCompany → nameSim ≈ 0.57 + 25 pts → 55 pts → skip (raised threshold)
    //
    // Examples that SHOULD reach AI:
    //   "Jon Smith" vs "John Smith"        → nameSim ≈ 0.89 → 90 pts → strong
    //   "Mike Johnson" vs "Michael Johnson"→ nameSim ≈ 0.75 + sameCompany → 80 pts → strong
    //   "Li Wei" vs "Wei Li" + sameCompany + sameEmailDomain → 55+25+20=100 pts → strong
    const probable = [];

    const iSource = this._norm(incoming.source);

    for (const db of dbRecords) {
      const dName    = this._norm(db.fullName);
      const dCompany = this._norm(db.company);
      const dEmail   = this._norm(db.email);
      const dSource  = this._norm(db.source);

      // Same-source guard: if both contacts come from the same platform
      // and have the exact same name, they are different people (e.g., two
      // "John Smith" entries both from LinkedIn CSV are two real contacts).
      // Only skip name-only matches — email/phone/LinkedIn matches above
      // are unique identifiers and remain valid regardless of source.
      if (iSource && dSource && iSource === dSource && iName && dName && iName === dName) {
        continue;
      }

      const nameSim         = (iName && dName) ? stringSimilarity.compareTwoStrings(iName, dName) : 0;
      const sameCompany     = !!(iCompany && dCompany && iCompany === dCompany);
      const sameEmailDomain = !!(iEmail && dEmail && (() => {
        const d = iEmail.split('@')[1];
        return d && !['gmail.com','yahoo.com','hotmail.com','outlook.com'].includes(d)
               && d === dEmail.split('@')[1];
      })());

      // Build composite score from weighted independent signals
      let compositeScore = 0;

      if      (nameSim >= 0.85) compositeScore += 90;
      else if (nameSim >= 0.70) compositeScore += 55;
      else if (nameSim >= 0.55) compositeScore += 30;
      else if (nameSim >= 0.40) compositeScore +=  5;
      // nameSim < 0.40 contributes 0 — not a real signal

      if (sameCompany)     compositeScore += 25;
      if (sameEmailDomain) compositeScore += 20;

      // Gate: require compositeScore ≥ 65 AND at least one meaningful name signal
      // (prevents sameCompany + sameEmailDomain alone, with 0 name overlap, reaching AI)
      const hasNameSignal = nameSim >= 0.40;
      const isStrong      = compositeScore >= 75;
      const isWeak        = compositeScore >= 65 && hasNameSignal;

      if (isStrong || isWeak) {
        probable.push({ dbRecord: db, nameSim, compositeScore, sameCompany, isStrong });
      }
    }

    if (probable.length > 0) {
      // Sort by signal strength descending; cap at 5 candidates to keep prompts slim
      probable.sort((a, b) => (b.isStrong - a.isStrong) || (b.nameSim - a.nameSim));
      const matchReason = probable[0].isStrong ? 'Fuzzy name/company match' : 'Weak signal (name similarity)';
      return { certainty: 'probable', candidates: probable.slice(0, 5).map(p => p.dbRecord), matchReason };
    }

    return { certainty: 'none' };
  }

  // ═══════════════════════════════════════════════════════════════
  // PHASE 3 – AI MATCHING (only for ambiguous cases)
  // ═══════════════════════════════════════════════════════════════

  /**
   * Slim representation for AI prompts — only the fields the AI actually needs.
   * Shorter keys reduce token usage.
   */
  _slim(c) {
    return {
      id:  c.id,
      n:   c.fullName  || null,
      e:   c.email     || null,
      p:   c.phone     || null,
      co:  c.company   || null,
      t:   c.jobTitle  || null,
      li:  c.linkedinUrl || null,
    };
  }

  /** MD5 hash of a (incoming, candidates[]) pair for cache key */
  _pairHash(incomingSlim, candidateSlims) {
    const str = JSON.stringify({ i: incomingSlim, c: candidateSlims });
    return crypto.createHash('md5').update(str).digest('hex');
  }

  /**
   * Send a batch of {incoming, candidates[]} pairs to Gemini.
   * Returns an array of AI result objects keyed by incomingId.
   */
  async _runAIBatch(pairs, userId = null) {
    if (!this.genAI) throw new Error('GEMINI_API_KEY missing — cannot run AI deduplication.');

    // Check token limit before making the AI call
    if (userId) {
      const isWithinLimit = await AITokenService.checkLimit(userId);
      if (!isWithinLimit) {
        throw new Error('Retry tomorrow you have consumed your daily ai usage limit');
      }
    }

    const schema = {
      type: 'OBJECT',
      properties: {
        results: {
          type: 'ARRAY',
          items: {
            type: 'OBJECT',
            properties: {
              incomingId:       { type: 'STRING' },
              isDuplicate:      { type: 'BOOLEAN' },
              matchedExistingId:{ type: 'STRING', nullable: true },
              confidenceScore:  { type: 'INTEGER' },
              matchReason:      { type: 'STRING' },
              goldenProfile: {
                type: 'OBJECT',
                properties: {
                  firstName:  { type: 'STRING', nullable: true },
                  lastName:   { type: 'STRING', nullable: true },
                  fullName:   { type: 'STRING', nullable: true },
                  email:      { type: 'STRING', nullable: true },
                  company:    { type: 'STRING', nullable: true },
                  jobTitle:   { type: 'STRING', nullable: true },
                  linkedinUrl:{ type: 'STRING', nullable: true },
                  phone:      { type: 'STRING', nullable: true },
                },
              },
            },
          },
        },
      },
    };

    // Compact system prompt to reduce token cost
    const prompt = `You are a Contact Deduplication AI. For each incoming contact, check if it matches any of its listed candidates.
Use semantic reasoning: detect duplicates despite name variations, abbreviations, initials, and typos.
Only mark isDuplicate=true if you are reasonably confident (score ≥ 60).
When a duplicate is found, create a goldenProfile merging the best non-null data from both. Never invent data.

Pairs:
${JSON.stringify(pairs.map(p => ({ incoming: p.incoming, candidates: p.candidates })), null, 2)}`;

    const response = await this.genAI.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        responseSchema: schema,
        temperature: 0.1,
      },
    });

    // Track token usage
    if (userId && response.usageMetadata) {
      await AITokenService.addTokens(userId, response.usageMetadata.promptTokenCount, response.usageMetadata.candidatesTokenCount);
    }

    const output = JSON.parse(response.text);
    return output?.results || [];
  }

  // ═══════════════════════════════════════════════════════════════
  // GOLDEN PROFILE – Rule-based builder (for definite hits, no AI cost)
  // ═══════════════════════════════════════════════════════════════

  /**
   * Merge two email sources into a unique array of {value, label} objects.
   * Preserves existing array labels; new values get label 'Work'.
   */
  _mergeEmailArrays(existingArr, incomingEmail, existingPrimaryEmail) {
    const result = Array.isArray(existingArr) ? [...existingArr] : [];
    const normVals = () => result.map(e => this._norm(e.value));
    if (existingPrimaryEmail && !normVals().includes(this._norm(existingPrimaryEmail))) {
      result.unshift({ value: existingPrimaryEmail, label: 'Work' });
    }
    if (incomingEmail && !normVals().includes(this._norm(incomingEmail))) {
      result.push({ value: incomingEmail, label: 'Work' });
    }
    return result.filter(e => e && e.value).slice(0, 5);
  }

  /**
   * Merge two phone sources into a unique array of {value, label} objects.
   * Uses _phonesMatch for deduplication to handle country-code differences.
   */
  _mergePhoneArrays(existingArr, incomingPhone, existingPrimaryPhone) {
    const result = Array.isArray(existingArr) ? [...existingArr] : [];
    const alreadyHas = (ph) => !!ph && result.some(p => this._phonesMatch(p.value, ph));
    if (existingPrimaryPhone && !alreadyHas(existingPrimaryPhone)) {
      result.unshift({ value: existingPrimaryPhone, label: 'Mobile' });
    }
    if (incomingPhone && !alreadyHas(incomingPhone)) {
      result.push({ value: incomingPhone, label: 'Mobile' });
    }
    return result.filter(p => p && p.value).slice(0, 5);
  }

  /**
   * Merge two contacts into a golden profile without AI.
   * Strategy: prefer incoming values for contact info (more recent),
   *           fall back to existing if incoming is empty.
   */
  _buildRuleGoldenProfile(existingInfo, incoming) {
    const pick = (a, b) => (a && a.toString().trim()) ? a : (b || null);
    return {
      fullName:   pick(incoming.fullName,    existingInfo.full_name),
      firstName:  pick(incoming.firstName,   existingInfo.first_name),
      lastName:   pick(incoming.lastName,    existingInfo.last_name),
      email:      pick(incoming.email,       existingInfo.email),
      company:    pick(incoming.company,     existingInfo.company),
      jobTitle:   pick(incoming.jobTitle,    existingInfo.job_title),
      linkedinUrl:pick(incoming.linkedinUrl, existingInfo.linkedin_url),
      phone:      pick(incoming.phone,       existingInfo.phone),
      emails:     this._mergeEmailArrays(existingInfo.emails, incoming.email, existingInfo.email),
      phones:     this._mergePhoneArrays(existingInfo.phones, incoming.phone, existingInfo.phone),
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // RESULT ASSEMBLY HELPERS
  // ═══════════════════════════════════════════════════════════════

  _buildDuplicateEntry(duplicates, incoming, existingInfo, gp, matchReason, confidenceScore) {
    const mergedContact = { ...existingInfo };

    if (gp.fullName)    mergedContact.full_name    = gp.fullName;
    if (gp.firstName)   mergedContact.first_name   = gp.firstName;
    if (gp.lastName)    mergedContact.last_name    = gp.lastName;
    if (gp.email)       mergedContact.email        = gp.email;
    if (gp.company)     mergedContact.company      = gp.company;
    if (gp.jobTitle)    mergedContact.job_title    = gp.jobTitle;
    if (gp.linkedinUrl) mergedContact.linkedin_url = gp.linkedinUrl;
    if (gp.phone)       mergedContact.phone        = gp.phone;

    // Always merge arrays — supplement AI golden profiles that don't include array fields
    mergedContact.emails = gp.emails || this._mergeEmailArrays(existingInfo.emails, incoming.email, existingInfo.email);
    mergedContact.phones = gp.phones || this._mergePhoneArrays(existingInfo.phones, incoming.phone, existingInfo.phone);

    mergedContact.source = 'google,linkedin';

    if (incoming.connectedOn) {
      mergedContact.contact_created_date = incoming.connectedOn;
      const connDate = incoming.connectedOn instanceof Date
        ? incoming.connectedOn
        : new Date(incoming.connectedOn);
      const newNote = `LinkedIn connection: ${connDate.toLocaleDateString()}`;
      mergedContact.notes = mergedContact.notes
        ? `${mergedContact.notes}\n${newNote}`
        : newNote;
    }

    const changes = [
      { existingField: 'full_name',    gpField: gp.fullName    },
      { existingField: 'email',        gpField: gp.email       },
      { existingField: 'company',      gpField: gp.company     },
      { existingField: 'job_title',    gpField: gp.jobTitle    },
      { existingField: 'linkedin_url', gpField: gp.linkedinUrl },
      { existingField: 'phone',        gpField: gp.phone       },
    ]
      .filter(f => f.gpField && existingInfo[f.existingField] !== f.gpField)
      .map(f => ({ field: f.existingField, from: existingInfo[f.existingField] || null, to: f.gpField }));

    duplicates.push({
      existing:  existingInfo,
      incoming:  incoming,
      merged:    mergedContact,
      matchType: matchReason,
      similarity:confidenceScore,
      changes,
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // MAIN ENTRY POINT
  // ═══════════════════════════════════════════════════════════════

  /**
   * Run the full tiered deduplication pipeline.
   * @param {Array} existingContacts  – contacts already in the database (DB schema)
   * @param {Array} incomingContacts  – contacts extracted from CSV (camelCase schema)
   * @param {Function} progressCallback – optional ({ phase, current, total }) => void
   * @returns {Object} { total, preFiltered, intraBatchDeduped, ruleDeduped, aiProcessed, duplicates, unique, duplicateDetails, uniqueContacts }
   */
  async findDuplicatesAndProfile(existingContacts, incomingContacts, progressCallback = null, userId = null) {
    // Normalise existing contacts to a consistent shape for matching
    const mapDb = (c) => ({
      id:         c.id,
      fullName:   c.full_name,
      email:      c.email,
      phone:      c.phone     || null,
      company:    c.company,
      jobTitle:   c.job_title,
      linkedinUrl:c.linkedin_url,
    });
    const dbRecords = existingContacts.map(mapDb);

    // Assign temp IDs to incoming contacts
    incomingContacts.forEach((c, idx) => { c.tempId = `inc_${idx}`; });

    const stats = {
      total:            incomingContacts.length,
      preFiltered:      0,
      intraBatchDeduped:0,
      ruleDeduped:      0,
      aiProcessed:      0,
      aiCacheHits:      0,
    };

    // ── Phase 0: Intra-batch dedup ──────────────────────────────
    const afterIntraDedup = this._dedupeIncoming(incomingContacts);
    stats.intraBatchDeduped = incomingContacts.length - afterIntraDedup.length;
    console.log(`[Dedup] Intra-batch: removed ${stats.intraBatchDeduped} duplicates within incoming list`);

    // ── Phase 1: Pre-filter ─────────────────────────────────────
    const afterPreFilter = afterIntraDedup.filter(c => {
      if (this._shouldDiscard({ fullName: c.fullName, email: c.email, phone: c.phone, linkedinUrl: c.linkedinUrl })) {
        stats.preFiltered++;
        return false;
      }
      return true;
    });
    console.log(`[Dedup] Pre-filter: discarded ${stats.preFiltered} invalid/incomplete contacts, ${afterPreFilter.length} remaining`);

    const duplicates = [];
    const unique     = [];
    const needsAI    = []; // { incoming, candidates, matchReason }

    // ── Phase 2: Rule-based matching ────────────────────────────
    for (const incoming of afterPreFilter) {
      const slim = {
        fullName:   incoming.fullName,
        email:      incoming.email,
        phone:      incoming.phone,
        company:    incoming.company,
        jobTitle:   incoming.jobTitle,
        linkedinUrl:incoming.linkedinUrl,
      };

      const rule = this._classifyRuleMatch(slim, dbRecords);

      if (rule.certainty === 'definite') {
        // Resolved without AI
        const existingInfo = existingContacts.find(c => c.id === rule.match.id);
        if (existingInfo) {
          const gp = this._buildRuleGoldenProfile(existingInfo, incoming);
          this._buildDuplicateEntry(duplicates, incoming, existingInfo, gp, `Rule: ${rule.matchReason}`, rule.confidenceScore);
          stats.ruleDeduped++;
          continue;
        }
      } else if (rule.certainty === 'probable') {
        needsAI.push({ incoming, candidates: rule.candidates, matchReason: rule.matchReason });
      } else {
        // No signal → treat as unique without wasting AI budget
        unique.push(incoming);
      }
    }

    console.log(`[Dedup] Rule-based: ${stats.ruleDeduped} definite duplicates, ${needsAI.length} sent to AI, ${unique.length} already unique`);

    // ── Phase 3: AI matching ─────────────────────────────────────
    if (needsAI.length > 0) {
      if (progressCallback) progressCallback({ phase: 'ai_start', current: 0, total: needsAI.length });

      // Separate cached from uncached
      const uncachedItems = [];
      const cachedResultMap = new Map(); // tempId → cached AI result

      for (const item of needsAI) {
        const inSlim   = this._slim({ id: item.incoming.tempId, ...item.incoming });
        const cndSlims = item.candidates.map(c => this._slim(c));
        const key      = this._pairHash(inSlim, cndSlims);
        item._cacheKey = key;

        if (this._aiCache.has(key)) {
          const cached = { ...this._aiCache.get(key), incomingId: item.incoming.tempId };
          cachedResultMap.set(item.incoming.tempId, cached);
          stats.aiCacheHits++;
        } else {
          uncachedItems.push(item);
        }
      }

      // Batch uncached items — 20 pairs per prompt for focused, cheaper calls
      const AI_BATCH = 20;
      const allAIResults = [...cachedResultMap.values()];
      const totalAIBatches = Math.ceil(uncachedItems.length / AI_BATCH);

      for (let i = 0; i < uncachedItems.length; i += AI_BATCH) {
        const batchNum = Math.floor(i / AI_BATCH) + 1;
        if (progressCallback) progressCallback({ phase: 'ai', current: batchNum, total: totalAIBatches });

        const batch = uncachedItems.slice(i, i + AI_BATCH);
        const pairs = batch.map(item => ({
          incoming:   this._slim({ id: item.incoming.tempId, ...item.incoming }),
          candidates: item.candidates.map(c => this._slim(c)),
        }));

        try {
          const results = await this._runAIBatch(pairs, userId);
          stats.aiProcessed += batch.length;

          // Store in cache and accumulate
          results.forEach((r, idx) => {
            if (batch[idx]) this._aiCache.set(batch[idx]._cacheKey, r);
          });
          allAIResults.push(...results);
        } catch (err) {
          console.error('[Dedup] AI batch error:', err.message);
          // Safe fallback: treat as unique to prevent data loss
          batch.forEach(item => {
            allAIResults.push({ incomingId: item.incoming.tempId, isDuplicate: false });
          });
        }
      }

      // Resolve AI results
      for (const item of needsAI) {
        const result = allAIResults.find(r => r.incomingId === item.incoming.tempId);

        if (result?.isDuplicate && result.matchedExistingId) {
          const existingInfo = existingContacts.find(c => c.id === result.matchedExistingId);
          if (existingInfo) {
            const gp = result.goldenProfile || this._buildRuleGoldenProfile(existingInfo, item.incoming);
            this._buildDuplicateEntry(
              duplicates, item.incoming, existingInfo, gp,
              `AI: ${result.matchReason || item.matchReason || 'Semantic match'}`,
              result.confidenceScore || 80,
            );
            continue;
          }
        }

        unique.push(item.incoming);
      }

      console.log(`[Dedup] AI: ${stats.aiProcessed} processed, ${stats.aiCacheHits} cache hits`);
    }

    // ── Phase 4: Final dedup of the unique list (intra-unique pass) ──
    const seenEmails    = new Set();
    const seenLinkedins = new Set();
    const seenNames     = new Set();

    const dedupedUnique = unique.filter(c => {
      const email    = this._norm(c.email);
      const linkedin = this._normLinkedin(c.linkedinUrl);
      const name     = this._norm(c.fullName);

      if (email    && seenEmails.has(email))    return false;
      if (linkedin && seenLinkedins.has(linkedin)) return false;
      if (!email && !linkedin && name && seenNames.has(name)) return false;

      if (email)    seenEmails.add(email);
      if (linkedin) seenLinkedins.add(linkedin);
      if (name)     seenNames.add(name);
      return true;
    });

    console.log(`[Dedup] Final: ${duplicates.length} duplicates, ${dedupedUnique.length} unique`);

    return {
      total:            stats.total,
      preFiltered:      stats.preFiltered,
      intraBatchDeduped:stats.intraBatchDeduped,
      ruleDeduped:      stats.ruleDeduped,
      aiProcessed:      stats.aiProcessed,
      aiCacheHits:      stats.aiCacheHits,
      duplicates:       duplicates.length,
      unique:           dedupedUnique.length,
      duplicateDetails: duplicates,
      uniqueContacts:   dedupedUnique,
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // DRY RUN — diagnostic report, zero AI calls
  // Shows exactly what each contact triggers at each pipeline phase.
  // ═══════════════════════════════════════════════════════════════

  /**
   * Run the full pipeline in diagnostic mode — no AI calls made.
   *
   * @param {Array} existingContacts  – DB contacts (DB schema)
   * @param {Array} incomingContacts  – CSV contacts (camelCase schema)
   * @returns {Object} Detailed diagnostic report
   */
  dryRun(existingContacts, incomingContacts) {
    const mapDb = (c) => ({
      id:         c.id,
      fullName:   c.full_name,
      email:      c.email,
      phone:      c.phone     || null,
      company:    c.company,
      jobTitle:   c.job_title,
      linkedinUrl:c.linkedin_url,
    });
    const dbRecords = existingContacts.map(mapDb);

    // Assign temp IDs
    incomingContacts.forEach((c, idx) => { c.tempId = `inc_${idx}`; });

    const report = {
      summary: {
        totalIncoming:     incomingContacts.length,
        existingInDB:      existingContacts.length,
        intraBatchDeduped: 0,
        preFiltered:       0,
        definiteRuleMatch: 0,
        sentToAI:          0,
        markedUnique:      0,
      },
      phases: {
        intraBatchDeduped: [],   // { contact, duplicatesOf, matchedField, matchedValue }
        preFiltered:       [],   // { contact, reason }
        definiteRuleMatch: [],   // { incoming, matchedDB, matchReason, confidence }
        sentToAI:          [],   // { incoming, topCandidates (with scores), ruleSignal }
        // markedUnique omitted from response body (see summary.markedUnique for count)
      },
      aiPayload: {
        description: 'Exact slim objects that would be batched and sent to Gemini (20 pairs per prompt)',
        totalPairs:   0,
        totalBatches: 0,
        // Full batches omitted by default — pass ?batches=true to include
        batches:     null,
      },
    };

    // ── Phase 0: Intra-batch dedup (with diagnostics) ────────────
    const seenE  = new Map(); // email  → first contact
    const seenLi = new Map(); // linkedin → first contact
    const seenPh = new Map(); // phone  → first contact
    const seenN  = new Map(); // name   → first contact
    const afterIntraDedup = [];

    for (const c of incomingContacts) {
      const email    = this._norm(c.email);
      const linkedin = this._normLinkedin(c.linkedinUrl);
      const phone    = this._normPhone(c.phone);
      const name     = this._norm(c.fullName);

      let dropped = false;
      let matchedField, matchedValue, duplicatesOf;

      if      (email    && seenE.has(email))                       { dropped = true; matchedField = 'email';    matchedValue = email;    duplicatesOf = seenE.get(email); }
      else if (linkedin && seenLi.has(linkedin))                   { dropped = true; matchedField = 'linkedin'; matchedValue = linkedin; duplicatesOf = seenLi.get(linkedin); }
      else if (phone    && phone.length >= 7 && seenPh.has(phone)) { dropped = true; matchedField = 'phone';    matchedValue = phone;    duplicatesOf = seenPh.get(phone); }
      else if (name     && seenN.has(name))                        { dropped = true; matchedField = 'name';     matchedValue = name;     duplicatesOf = seenN.get(name); }

      if (dropped) {
        report.phases.intraBatchDeduped.push({
          contact:      { tempId: c.tempId, fullName: c.fullName, email: c.email, company: c.company },
          duplicatesOf: { tempId: duplicatesOf.tempId, fullName: duplicatesOf.fullName, email: duplicatesOf.email },
          matchedField,
          matchedValue,
        });
        report.summary.intraBatchDeduped++;
        continue;
      }

      if (email)                    seenE.set(email, c);
      if (linkedin)                 seenLi.set(linkedin, c);
      if (phone && phone.length >= 7) seenPh.set(phone, c);
      if (name)                     seenN.set(name, c);
      afterIntraDedup.push(c);
    }

    // ── Phase 1: Pre-filter (with diagnostics) ───────────────────
    const afterPreFilter = [];
    for (const c of afterIntraDedup) {
      let reason = null;

      const name  = this._norm(c.fullName);
      const email = this._norm(c.email);

      if (!name && !email && !(c.phone || '').trim() && !(c.linkedinUrl || '').trim()) {
        reason = 'Missing all identifying fields (name, email, phone, linkedin)';
      } else if (email && this._isInvalidEmail(email)) {
        reason = `Invalid/test email address: ${email}`;
      } else if (['test', 'dummy', 'placeholder', 'unknown', 'n/a', 'na', 'tbd'].includes(name)) {
        reason = `Placeholder name: "${c.fullName}"`;
      }

      if (reason) {
        report.phases.preFiltered.push({
          contact: { tempId: c.tempId, fullName: c.fullName, email: c.email, company: c.company },
          reason,
        });
        report.summary.preFiltered++;
        continue;
      }

      afterPreFilter.push(c);
    }

    // ── Phase 2: Rule-based matching (with diagnostics) ──────────
    const needsAI = [];

    for (const incoming of afterPreFilter) {
      // Compute detailed scores against all DB records for reporting
      const iEmail    = this._norm(incoming.email);
      const iLinkedin = this._normLinkedin(incoming.linkedinUrl);
      const iName     = this._norm(incoming.fullName);
      const iCompany  = this._norm(incoming.company);

      // Check definites first
      let definiteMatch = null;
      for (const db of dbRecords) {
        const dEmail    = this._norm(db.email);
        const dLinkedin = this._normLinkedin(db.linkedinUrl);

        if (iEmail    && dEmail    && iEmail    === dEmail)    { definiteMatch = { db, matchReason: 'Exact email match',       confidence: 100, matchedValue: iEmail };    break; }
        if (iLinkedin && dLinkedin && iLinkedin === dLinkedin) { definiteMatch = { db, matchReason: 'Exact LinkedIn URL match', confidence: 100, matchedValue: iLinkedin }; break; }
        if (this._phonesMatch(incoming.phone, db.phone))       { definiteMatch = { db, matchReason: 'Exact phone match',        confidence: 95,  matchedValue: incoming.phone }; break; }
      }

      if (definiteMatch) {
        report.phases.definiteRuleMatch.push({
          incoming:    { tempId: incoming.tempId, fullName: incoming.fullName, email: incoming.email, phone: incoming.phone, linkedinUrl: incoming.linkedinUrl, company: incoming.company },
          matchedDB:   { id: definiteMatch.db.id, fullName: definiteMatch.db.fullName, email: definiteMatch.db.email, phone: definiteMatch.db.phone, linkedinUrl: definiteMatch.db.linkedinUrl, company: definiteMatch.db.company },
          matchReason: definiteMatch.matchReason,
          matchedValue:definiteMatch.matchedValue,
          confidence:  definiteMatch.confidence,
          aiNeeded:    false,
        });
        report.summary.definiteRuleMatch++;
        continue;
      }

      // Compute fuzzy scores against all DB records
      const scoredCandidates = dbRecords.map(db => {
        const dName    = this._norm(db.fullName);
        const dCompany = this._norm(db.company);
        const dEmail   = this._norm(db.email);

        const nameSim     = (iName && dName) ? parseFloat(stringSimilarity.compareTwoStrings(iName, dName).toFixed(3)) : 0;
        const sameCompany = !!(iCompany && dCompany && iCompany === dCompany);
        const sameEmailDomain = !!(iEmail && dEmail && (() => {
          const d = iEmail.split('@')[1];
          return d && !['gmail.com','yahoo.com','hotmail.com','outlook.com'].includes(d) && d === dEmail.split('@')[1];
        })());

        // Composite signal scoring — mirrors _classifyRuleMatch logic exactly.
        // Single weak signals (low name sim alone) must NOT trigger an AI call.
        let compositeScore = 0;
        if      (nameSim >= 0.85) compositeScore += 90;
        else if (nameSim >= 0.70) compositeScore += 55;
        else if (nameSim >= 0.55) compositeScore += 30;
        else if (nameSim >= 0.40) compositeScore +=  5;
        if (sameCompany)     compositeScore += 25;
        if (sameEmailDomain) compositeScore += 20;

        const hasNameSignal = nameSim >= 0.40;
        const isStrong = compositeScore >= 75;
        const isWeak   = compositeScore >= 50 && hasNameSignal;
        const sendToAI = isStrong || isWeak;

        return {
          id:          db.id,
          fullName:    db.fullName,
          email:       db.email,
          company:     db.company,
          nameSim,
          sameCompany,
          sameEmailDomain,
          compositeScore,
          signal:      isStrong ? 'strong' : isWeak ? 'weak' : 'none',
          sendToAI,
        };
      }).filter(s => s.nameSim > 0 || s.sameCompany || s.sameEmailDomain)  // only show records with any signal
        .sort((a, b) => (b.signal === 'strong') - (a.signal === 'strong') || b.nameSim - a.nameSim);

      const aiCandidates = scoredCandidates.filter(s => s.sendToAI).slice(0, 5);

      if (aiCandidates.length > 0) {
        const signal = aiCandidates[0].signal;
        report.phases.sentToAI.push({
          incoming:      { tempId: incoming.tempId, fullName: incoming.fullName, email: incoming.email, phone: incoming.phone, linkedinUrl: incoming.linkedinUrl, company: incoming.company, jobTitle: incoming.jobTitle },
          ruleSignal:    signal,
          ruleReason:    signal === 'strong' ? 'High name similarity / same company' : 'Weak signal (moderate name similarity or shared company)',
          topCandidates: aiCandidates,  // top 5 DB records that would be sent to AI (with scores)
        });
        needsAI.push({ incoming, candidates: aiCandidates.map(s => dbRecords.find(d => d.id === s.id)) });
        report.summary.sentToAI++;
      } else {
        report.summary.markedUnique++;
      }
    }

    // ── Build the AI payload metadata ────────────────────────────
    const AI_BATCH = 20;
    report.aiPayload.totalPairs   = needsAI.length;
    report.aiPayload.totalBatches = Math.ceil(needsAI.length / AI_BATCH);
    // batches omitted by default to keep response size small

    return report;
  }

  // ═══════════════════════════════════════════════════════════════
  // GLOBAL DEDUP — scan all existing contacts against each other
  // ═══════════════════════════════════════════════════════════════

  /**
   * Find duplicates across all contacts in the database.
   * Processes each pair (i, j) where i < j to avoid duplicate pairs.
   *
   * @param {Array} allContacts  – all contacts in DB format (snake_case)
   * @param {Function} progressCallback – optional ({ phase, current, total }) => void
   * @returns {Object} { total, duplicates, duplicateDetails }
   */
  async findGlobalDuplicates(allContacts, progressCallback = null, userId = null) {
    // Convert all contacts to camelCase for rule matching
    const mapped = allContacts.map(c => ({
      id:         c.id,
      fullName:   c.full_name,
      email:      c.email,
      phone:      c.phone || null,
      company:    c.company,
      jobTitle:   c.job_title,
      linkedinUrl:c.linkedin_url,
      source:     c.source || 'manual',
    }));

    const duplicates = [];
    const needsAI = []; // { incoming, candidates, existingRaw, incomingRaw }
    const seenPairs = new Set(); // prevent processing same pair twice
    const matchedContacts = new Set(); // contacts already in a definite pair — skip from further AI comparisons

    // Rule-based pass: compare each contact against all with higher index
    for (let i = 0; i < mapped.length; i++) {
      if (matchedContacts.has(mapped[i].id)) continue; // already definitively resolved
      const incoming = { ...mapped[i], tempId: `g_${i}` };
      // Filter out contacts already matched to avoid redundant AI calls
      const candidates = mapped.slice(i + 1).filter(c => !matchedContacts.has(c.id));

      const rule = this._classifyRuleMatch(incoming, candidates);

      if (rule.certainty === 'definite') {
        const pairKey = [incoming.id, rule.match.id].sort().join('|');
        if (!seenPairs.has(pairKey)) {
          seenPairs.add(pairKey);
          matchedContacts.add(incoming.id);
          matchedContacts.add(rule.match.id);
          const existingRaw = allContacts.find(c => c.id === rule.match.id);
          const incomingRaw = allContacts.find(c => c.id === incoming.id);
          if (existingRaw && incomingRaw) {
            const incomingCamel = {
              id:          incomingRaw.id,
              fullName:    incomingRaw.full_name,
              firstName:   incomingRaw.first_name,
              lastName:    incomingRaw.last_name,
              email:       incomingRaw.email,
              company:     incomingRaw.company,
              jobTitle:    incomingRaw.job_title,
              linkedinUrl: incomingRaw.linkedin_url,
              phone:       incomingRaw.phone,
              source:      incomingRaw.source || 'manual',
            };
            const gp = this._buildRuleGoldenProfile(existingRaw, incomingCamel);
            this._buildDuplicateEntry(duplicates, incomingCamel, existingRaw, gp, `Rule: ${rule.matchReason}`, rule.confidenceScore);
          }
        }
      } else if (rule.certainty === 'probable') {
        // Guard: only add pairs not already seen
        for (const candidate of rule.candidates) {
          const pairKey = [incoming.id, candidate.id].sort().join('|');
          if (!seenPairs.has(pairKey)) {
            needsAI.push({
              incoming,
              candidates: [candidate],
              existingRaw: allContacts.find(c => c.id === candidate.id),
              incomingRaw: allContacts.find(c => c.id === incoming.id),
            });
            seenPairs.add(pairKey);
          }
        }
      }
    }

    console.log(`[GlobalDedup] Rule pass: ${duplicates.length} definite, ${needsAI.length} sent to AI`);

    // AI pass
    if (needsAI.length > 0) {
      if (progressCallback) progressCallback({ phase: 'ai_start', current: 0, total: needsAI.length });

      // Assign cache keys and separate cached from uncached
      const uncachedItems = [];
      const cachedResults = []; // { item, result }

      for (const item of needsAI) {
        const inSlim   = this._slim({ ...item.incoming, id: item.incoming.tempId });
        const cndSlims = item.candidates.map(c => this._slim(c));
        const key      = this._pairHash(inSlim, cndSlims);
        item._cacheKey = key;

        if (this._aiCache.has(key)) {
          const cached = { ...this._aiCache.get(key), incomingId: item.incoming.tempId };
          cachedResults.push({ item, result: cached });
        } else {
          uncachedItems.push(item);
        }
      }

      if (cachedResults.length > 0) {
        console.log(`[GlobalDedup] AI cache: ${cachedResults.length} pairs resolved from cache`);
      }

      const AI_BATCH = 20;
      const totalBatches = Math.ceil(uncachedItems.length / AI_BATCH);

      const allResults = [...cachedResults];

      for (let i = 0; i < uncachedItems.length; i += AI_BATCH) {
        const batchNum = Math.floor(i / AI_BATCH) + 1;
        if (progressCallback) progressCallback({ phase: 'ai', current: batchNum, total: totalBatches || 1 });

        const batch = uncachedItems.slice(i, i + AI_BATCH);
        const pairs = batch.map(item => ({
          incoming:   this._slim({ ...item.incoming, id: item.incoming.tempId }),
          candidates: item.candidates.map(c => this._slim(c)),
        }));

        try {
          const results = await this._runAIBatch(pairs, userId);

          // Store results in cache
          results.forEach((r, idx) => {
            if (batch[idx]) this._aiCache.set(batch[idx]._cacheKey, r);
          });

          batch.forEach(item => {
            const result = results.find(r => r.incomingId === item.incoming.tempId);
            if (result) allResults.push({ item, result });
          });
        } catch (err) {
          console.error('[GlobalDedup] AI batch error:', err.message);
          // safe fallback: skip ambiguous pairs
        }
      }

      // Resolve all AI results (cached + fresh)
      for (const { item, result } of allResults) {
        if (result?.isDuplicate && result.matchedExistingId) {
          const existingRaw = allContacts.find(c => c.id === result.matchedExistingId)
            ?? item.existingRaw;
          if (existingRaw && item.incomingRaw) {
            const incomingCamel = {
              id:          item.incomingRaw.id,
              fullName:    item.incomingRaw.full_name,
              firstName:   item.incomingRaw.first_name,
              lastName:    item.incomingRaw.last_name,
              email:       item.incomingRaw.email,
              company:     item.incomingRaw.company,
              jobTitle:    item.incomingRaw.job_title,
              linkedinUrl: item.incomingRaw.linkedin_url,
              phone:       item.incomingRaw.phone,
              source:      item.incomingRaw.source || 'manual',
            };
            const gp = result.goldenProfile || this._buildRuleGoldenProfile(existingRaw, incomingCamel);
            this._buildDuplicateEntry(
              duplicates, incomingCamel, existingRaw, gp,
              `AI: ${result.matchReason || 'Semantic match'}`,
              result.confidenceScore || 80,
            );
          }
        }
      }
    }

    console.log(`[GlobalDedup] Final: ${duplicates.length} duplicate pairs found`);

    return {
      total: allContacts.length,
      duplicates: duplicates.length,
      duplicateDetails: duplicates,
    };
  }
}

module.exports = new AIDeduplicationService();