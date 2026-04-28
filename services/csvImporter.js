/**
 * csvImporter — robust CSV parsing + column-mapping suggestions for the
 * community-owner bulk contact upload.
 *
 * Two-step UX:
 *   1. preview() — accepts raw CSV text, returns { columns, rows, suggested,
 *      total_rows }. Frontend shows the user a sample + a dropdown per column
 *      so they can confirm or correct the mapping.
 *   2. buildContactsFromMapping() — given the parsed rows + user-confirmed
 *      mapping, produces normalized contact objects ready for insert.
 *
 * The parser handles: BOM, CRLF/LF/CR endings, quoted fields with commas
 * inside, escaped "" inside quoted fields. It auto-skips a "preamble" of
 * non-tabular lines before the header (LinkedIn's "Notes:" preface, etc.).
 */

const MAX_PREVIEW_ROWS = 5;
const MAX_IMPORT_ROWS  = 5000;

// Canonical fields the contacts table cares about. UI exposes these as
// the only options in the per-column mapping dropdown.
const CANONICAL_FIELDS = [
  'full_name', 'first_name', 'last_name',
  'email', 'phone', 'linkedin_url',
  'company', 'job_title',
];

// Aliases used to auto-suggest mapping. Lowercased + non-alnum stripped on
// both sides before comparison.
const FIELD_ALIASES = {
  full_name:    ['fullname', 'name', 'contactname', 'displayname', 'contact'],
  first_name:   ['firstname', 'givenname', 'first', 'fname'],
  last_name:    ['lastname', 'surname', 'familyname', 'last', 'lname'],
  email:        ['email', 'emailaddress', 'mail', 'primaryemail', 'workemail', 'contactemail'],
  phone:        ['phone', 'mobile', 'cell', 'phonenumber', 'mobilenumber', 'telephone'],
  linkedin_url: ['linkedin', 'linkedinurl', 'linkedinprofile', 'profileurl', 'url'],
  company:      ['company', 'organization', 'organisation', 'employer', 'workplace'],
  job_title:    ['title', 'jobtitle', 'position', 'role', 'designation'],
};

function normalizeKey(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Streaming-style CSV record parser. Returns array of arrays (raw cells).
// Handles quoted fields with embedded commas, newlines, and escaped quotes.
function parseCsvText(text) {
  if (!text) return [];
  // Strip UTF-8 BOM if present.
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);

  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;
  let i = 0;
  const n = text.length;

  while (i < n) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < n && text[i + 1] === '"') { cell += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      cell += ch; i++; continue;
    }

    if (ch === '"') { inQuotes = true; i++; continue; }
    if (ch === ',') { row.push(cell); cell = ''; i++; continue; }
    if (ch === '\r' || ch === '\n') {
      row.push(cell); cell = '';
      // Skip CRLF as a single line break.
      if (ch === '\r' && i + 1 < n && text[i + 1] === '\n') i++;
      // Don't push pure-empty rows (CSVs commonly trail with blank lines).
      if (!(row.length === 1 && row[0] === '')) rows.push(row);
      row = [];
      i++; continue;
    }
    cell += ch; i++;
  }
  // Flush trailing cell/row.
  if (cell !== '' || row.length) {
    row.push(cell);
    if (!(row.length === 1 && row[0] === '')) rows.push(row);
  }
  return rows;
}

// Some CSV exports (LinkedIn, Salesforce) have a non-tabular preamble before
// the actual header. Heuristic: pick the first row whose cell count is the
// mode of subsequent rows AND whose cells look like field names (mostly
// alphabetic, no commas, length < 80). Falls back to row 0 if nothing fits.
function findHeaderIndex(rows) {
  if (!rows.length) return 0;
  const counts = rows.slice(0, 30).map(r => r.length);
  const mode = counts.sort((a, b) => counts.filter(v => v === a).length - counts.filter(v => v === b).length).pop();
  for (let i = 0; i < Math.min(rows.length, 30); i++) {
    const r = rows[i];
    if (r.length !== mode || r.length < 2) continue;
    const looksLikeHeader = r.every(c => {
      const s = String(c || '').trim();
      return s.length > 0 && s.length < 80 && /[A-Za-z]/.test(s);
    });
    if (looksLikeHeader) return i;
  }
  return 0;
}

function suggestMapping(headers) {
  const used = new Set();
  const suggestion = {};
  for (const field of CANONICAL_FIELDS) suggestion[field] = null;

  // For each canonical field, scan headers for the best alias hit.
  for (const field of CANONICAL_FIELDS) {
    const aliases = FIELD_ALIASES[field];
    for (let h = 0; h < headers.length; h++) {
      if (used.has(h)) continue;
      const norm = normalizeKey(headers[h]);
      if (!norm) continue;
      // Exact alias match wins.
      if (aliases.includes(norm)) { suggestion[field] = headers[h]; used.add(h); break; }
    }
  }
  // Second pass: substring contains match for fields we didn't fill.
  for (const field of CANONICAL_FIELDS) {
    if (suggestion[field]) continue;
    const aliases = FIELD_ALIASES[field];
    for (let h = 0; h < headers.length; h++) {
      if (used.has(h)) continue;
      const norm = normalizeKey(headers[h]);
      if (!norm) continue;
      if (aliases.some(a => norm.includes(a) || a.includes(norm))) {
        suggestion[field] = headers[h]; used.add(h); break;
      }
    }
  }
  return suggestion;
}

function parsePreview(csvText) {
  const grid = parseCsvText(csvText);
  if (!grid.length) {
    return { columns: [], rows: [], all_rows: [], suggested: {}, total_rows: 0, header_row_index: 0 };
  }
  const headerIdx = findHeaderIndex(grid);
  const headerCells = grid[headerIdx].map(c => String(c || '').trim());
  const dataRows = grid.slice(headerIdx + 1).filter(r => r.some(c => String(c || '').trim() !== ''));

  const objects = dataRows.map((r) => {
    const o = {};
    for (let c = 0; c < headerCells.length; c++) {
      o[headerCells[c]] = r[c] != null ? String(r[c]).trim() : '';
    }
    return o;
  });

  return {
    columns:           headerCells,
    rows:              objects.slice(0, MAX_PREVIEW_ROWS),
    all_rows:          objects.slice(0, MAX_IMPORT_ROWS),
    truncated:         objects.length > MAX_IMPORT_ROWS,
    total_rows:        objects.length,
    suggested:         suggestMapping(headerCells),
    header_row_index:  headerIdx,
  };
}

function pick(row, key) {
  if (!key) return null;
  const v = row[key];
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s : null;
}

function normalizeEmail(s)  { return s ? s.toLowerCase() : null; }
function normalizeLinkedin(s) {
  if (!s) return null;
  // Tolerate naked vanity slugs and protocol-less URLs.
  let url = s.trim();
  if (!/^https?:\/\//i.test(url)) {
    if (url.startsWith('linkedin.com') || url.startsWith('www.linkedin.com')) url = 'https://' + url;
    else if (/^[A-Za-z0-9-]+$/.test(url)) url = 'https://www.linkedin.com/in/' + url;
  }
  return url.replace(/\/+$/, '').toLowerCase();
}

function buildContactsFromMapping(rows, mapping) {
  const out = [];
  const errors = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];

    let firstName = pick(row, mapping.first_name);
    let lastName  = pick(row, mapping.last_name);
    let fullName  = pick(row, mapping.full_name);
    if (!fullName && (firstName || lastName)) fullName = [firstName, lastName].filter(Boolean).join(' ');
    if (!firstName && !lastName && fullName) {
      const parts = fullName.split(/\s+/);
      firstName = parts[0] || null;
      lastName  = parts.length > 1 ? parts.slice(1).join(' ') : null;
    }

    const email       = normalizeEmail(pick(row, mapping.email));
    const linkedinUrl = normalizeLinkedin(pick(row, mapping.linkedin_url));
    const phone       = pick(row, mapping.phone);
    const company     = pick(row, mapping.company);
    const jobTitle    = pick(row, mapping.job_title);

    // Each contact needs at least one durable identifier.
    if (!fullName && !email && !linkedinUrl) {
      errors.push({ row: i + 1, reason: 'no name, email, or linkedin_url' });
      continue;
    }

    out.push({
      _row:         i + 1,
      full_name:    fullName,
      first_name:   firstName,
      last_name:    lastName,
      email,
      phone,
      linkedin_url: linkedinUrl,
      company,
      job_title:    jobTitle,
    });
  }

  return { contacts: out, errors };
}

module.exports = {
  parsePreview,
  buildContactsFromMapping,
  suggestMapping,
  CANONICAL_FIELDS,
  MAX_IMPORT_ROWS,
  MAX_PREVIEW_ROWS,
};
