# Nexo — Architecture & Infrastructure Log

Community network intelligence platform. Ingests a user's LinkedIn network, enriches it, embeds it for semantic search, and exposes it via a web app, Chrome extension, and WhatsApp bot.

---

## Repos

| Repo | Purpose | Host |
|---|---|---|
| `nexo-backend` | Express API, workers, cron, queues | VPS `187.127.129.125.nip.io` |
| `nexo-frontend` | Next.js web app + Chrome extension source | Vercel — `nexo-frontend-indol.vercel.app` |

The Chrome extension source lives under the frontend repo's `extension/` subtree and is copied to `nexo-backend/extension/` for reference.

---

## Runtime topology

```
┌─────────────────┐          ┌────────────────────────────┐
│  Chrome ext     │          │  Next.js frontend (Vercel) │
│  (LinkedIn tab) │          │  nexo-frontend-indol        │
└────────┬────────┘          └──────────────┬─────────────┘
         │ credentials: include            │
         │                                 │
         ▼                                 ▼
   ┌──────────────────────────────────────────────┐
   │         nginx (443/80, TLS via nip.io)       │
   │            187.127.129.125.nip.io            │
   └──────────────────────┬───────────────────────┘
                          │ proxy → :3000
                          ▼
   ┌──────────────────────────────────────────────┐
   │  Node 20  ·  Express 5  ·  PM2-managed       │
   │  server.js  (app id: "nexo")                 │
   └───┬──────────┬──────────┬──────────┬─────────┘
       │          │          │          │
       ▼          ▼          ▼          ▼
    Postgres    Redis    Pinecone    external
    (pg 8)    (ioredis   (7.x SDK)    providers
              + BullMQ 5)             (see below)
```

VPS — Ubuntu, 4 vCPU. Node managed by PM2 (single fork, auto-restart). nginx terminates TLS from a `*.nip.io` wildcard cert mapped to the IP.

---

## Backend inventory (`nexo-backend`)

### Tech stack
- Node >= 20, Express 5
- Postgres 14+ via `pg` 8.18 (custom `db/index.js` pool wrapper)
- Redis 6+ via `ioredis` 5.3
- Queues: BullMQ 5.12
- Logging: winston 3 + daily rotate
- Scheduling: `node-cron` 4.2
- AI: `@google/genai` 1.43 (Gemini)
- Vector DB: `@pinecone-database/pinecone` 7.1
- Email: `@sendgrid/mail` 8.1
- Object store: `@aws-sdk/client-s3` 3.x
- Google Workspace: `googleapis` 171.4, `google-auth-library` 10.5
- Auth: JWT via `jsonwebtoken` 9 in `accessToken` + `refreshToken` httpOnly cookies, `bcrypt` 6 for passwords

### Processes
| PM2 name | Cmd | Role |
|---|---|---|
| `nexo` | `node server.js` | HTTP API |
| (*also run as workers*) | `npm run worker` → `node workers/index.js` | BullMQ consumers |

### HTTP routes (`routes/`)
`auth`, `sync`, `contacts`, `organize`, `calendar`, `reminders`, `notes`, `activities`, `ai`, `whatsapp`, `intros`, `groups`, `linkedin`, `settings`, `search`, `dedup`, `debug`, `extension`, `monitors`.

The extension-facing surface (`routes/extension.js`):
- `POST /api/extension/profile` — single profile captured on browse
- `POST /api/extension/batch` — connections-page scroll batch
- `GET /api/extension/contact` — widget hydration per profile
- `GET /api/extension/status` — liveness + stats
- `POST /api/extension/note` — quick-note from the in-page widget

### Services (`services/`)
- `linkedinScraper.js` — normalizes extension DOM captures, upserts `contacts`, queues enrichment/embedding
- `linkedin/voyagerConnections.js` — fallback path using LinkedIn's undocumented Voyager API (used less since scroll-capture landed)
- `enrichment/` — adapter + provider modules
- `pineconeService.js` — per-user namespace (`user_{userId}`), embeds + upserts contact vectors, queries for semantic search
- `confidence.js` — relationship confidence scoring
- `messageParser.js` — LinkedIn messages CSV parser (post-export workflow)
- `nexoAIService.js` — core chat/agent backed by Gemini, shared by REST `/api/ai` and WhatsApp
- `whatsapp.js` / `whatsappSessionService.js` — Meta WhatsApp Business webhook handler + session store
- `networkScan.js` — batched LinkedIn scan orchestration
- `calendarService.js` — Google Calendar sync
- `integrationService.js` — Google Contacts sync
- `notificationService.js` — email/push/WA fan-out
- `aiDeduplicationService.js` — AI-based contact dedup
- `aiTokenService.js` — per-user token accounting for Gemini
- `reminderScheduler.js` — reminder cron

### Workers (`workers/index.js`)
Four BullMQ consumers:
| Queue | Concurrency | Does |
|---|---|---|
| `enrichment` | 5 | Calls enrichment provider, updates contact, chains `embedding` |
| `embedding` | 10 | Builds text, calls Gemini embed, upserts Pinecone |
| `message-parse` | 2 | Parses uploaded LinkedIn message CSV via AI |
| `network-scan` | 1 | Orchestrates scanning a user's full network |

Queue definitions + Redis connection shared via `workers/queues.js`.

### Cron (`cron/`)
- `syncJob.js` — periodic Google sync
- `notificationJob.js` — scheduled notifications
- `profileMonitorJob.js` — re-checks profiles in `profile_monitors` table for changes

### Database (31 migrations)
Notable tables:
- `contacts` — primary record; ~40 columns incl. `enrichment_status`, `enriched_at`, `pinecone_indexed`, `confidence_score`, `connection_tier`
- `linkedin_scrape_log` — raw captures from the extension (source of truth audit)
- `linkedin_messages` — parsed message summaries feeding richer embeddings
- `profile_monitors` — per-profile change watch (`migrations/029_profile_monitors.js`)
- `groups`, `intros`, `network_scan` — higher-level org features
- `user_jobs`, `ai_chat_messages`, `reminders`, `activities`, `notes`, `tags`, `lists`

`linkedin_url` uniqueness enforced (`028_unique_linkedin_url.js`).

### Auth flow
folkX-style session reuse. User signs in at frontend → backend sets httpOnly `accessToken` + `refreshToken` cookies on `187.127.129.125.nip.io`. Both frontend and Chrome extension attach them via `credentials: 'include'`. Extension manifest declares the API host in `host_permissions` so cookies attach cross-origin. Access token: 7 days (HS256 JWT). Refresh token: 30 days.

---

## LinkedIn data pipeline

### 1. In-browser DOM capture (Chrome extension)
- Primary path — no cookie replay, no Voyager API call in the browser
- **Profile pages** (`/in/*`) — extractor pulls name/headline/company/location/profile_pic from DOM, posts to `POST /api/extension/profile`
- **Connections page** (`/mynetwork/invite-connect/connections`) — **Folk-style explicit selection**, opt-in, **not** an auto-scroll scraper:
  1. Widget mounts; detects every `/in/<slug>` anchor on the page via a class-free, link-based sweep (LinkedIn's connections list no longer uses stable class names or `<li>` wrappers).
  2. Each detected card gets a **"Nexo" checkbox badge** injected (default: ticked). `MutationObserver` + 1 s poll keeps new cards covered as LinkedIn lazy-loads on scroll.
  3. Widget shows a live **N Selected** counter + `Select all` / `Clear` / `Rescan` / `Import` controls.
  4. On **Import**, up to **50 contacts/click** are sent as a single `POST /api/extension/batch`. Successful cards flip to "✓ Imported" (green, disabled); remainder stays selected for the next click.
- Both paths also store the raw payload in `linkedin_scrape_log`.

Anchor extraction heuristics (`content_script.js → findProfileAnchors`, `extractFromAnchor`):
- `canonicalLinkedInUrl(href)` accepts absolute OR relative hrefs (LinkedIn returns both depending on layout) and collapses to `https://www.linkedin.com/in/<slug>`.
- Profile sub-paths (`/overlay/`, `/edit/`, `/opportunities/`, `/details/`, `/mutual/`, …) are rejected — they're always internal navigation of the user's own profile shown in the page's top card (would otherwise contribute 50+ self-URL anchors).
- Headline / company / connected-date pulled from `span[aria-hidden="true"]` text + "Connected MMM YYYY" substring scan; class selectors (`.mn-connection-card__occupation` etc.) are kept as legacy fallback only.
- Card container is found by walking up from the anchor until an ancestor with ≥2 children and ≥40 px height is found (`findCardContainer`), since the current DOM is nested obfuscated-class `<div>`s with no `<li>` wrapper.

### 2. Server-side enrichment fallback
For contacts captured without rich data (headline/company/etc. still null after DOM capture), the worker enriches via external providers.

Provider adapter (`services/enrichment/adapter.js`):
| Provider | Module | Status |
|---|---|---|
| **LinkDAPI** | `linkdapi.js` | **Default primary** (was Proxycurl before July 2025 shutdown) |
| **ScrapingDog** | `scrapingdog.js` | Fallback |
| **Brightdata** | `brightdata.js` | Bulk / legacy |
| Proxycurl | `proxycurl.js` | Kept for reference only — vendor dead |

`ENRICHMENT_PROVIDER` env var controls the primary; secondary is picked automatically. Results flow back into `contacts` and flip `enrichment_status` from `queued` → `enriching` → `enriched`.

### 3. Vectorization
After enrichment, an `embedding` job runs:
- Builds rich text from contact + linked message summary
- Calls Gemini embedding model
- Upserts to Pinecone under namespace `user_{userId}` with metadata: `full_name`, `company`, `job_title`, `confidence`, `tier`, `is_private`
- Sets `pinecone_indexed = true`

### 4. Voyager API (legacy/fallback)
`services/linkedin/voyagerConnections.js` — can fetch connections via LinkedIn's internal Voyager API using the user's session cookie. Used less now that DOM scroll-capture exists, kept for recovery scenarios.

---

## Chrome extension inventory (`nexo-extension`)

Manifest V3 — `manifest.json`:
- `content_scripts`: `content_script.js` on `*://*.linkedin.com/*`, `document_idle`, not all_frames
- `background.service_worker`: `background.js` as ES module
- `host_permissions`: `*://*.linkedin.com/*`, `https://187.127.129.125.nip.io/*`, `http://localhost:3000/*`
- `permissions`: `cookies`, `alarms`, `storage`, `notifications`, `scripting`
- Popup at `popup/popup.html`

Component map:
- `content_script.js` — everything that runs on `linkedin.com`:
  - Profile page (`/in/*`): DOM capture → `PROFILE_CAPTURED`, in-page shadow-DOM widget with CRM view + add-note
  - Connections page (`/mynetwork/invite-connect/connections/`): **explicit-selection UI** — per-card checkbox injection + widget counter/import flow (see pipeline §1)
  - SPA navigation watcher keyed on **page-type + pathname** (not full URL) so LinkedIn's query-string shuffles don't tear down an active scan
  - Watchdog remounts the widget if LinkedIn strips the host
- `background.js` — message router (`PROFILE_CAPTURED`, `CONNECTIONS_BATCH`, `API_FETCH`, `SYNC_NOW`, `GET_SYNC_STATE`, `GET_SCAN_STATE`), alarms, `authedFetch` proxy so cookies attach from the extension origin
- `utils/auth.js` — `authedFetch`, `hasSessionCookie`, cookie-change listener
- `popup/` — small dashboard showing sync state and a "Go to connections page" call-to-action

Widget renders into a Shadow DOM host with `all: initial` reset on `:host` only (do not put `all: initial` on `*` — it defeats the UA `display: none` on `<style>` elements and the stylesheet's source text renders visibly; belt-and-suspenders `style { display: none }` rule in the stylesheet too).

---

## External services (credentials live in env)
| Purpose | Service | Key env vars |
|---|---|---|
| Vector DB | Pinecone | `PINECONE_API_KEY`, `PINECONE_INDEX` (default `nexo-contacts`) |
| LLM / embeddings | Google Gemini | `GEMINI_API_KEY` |
| LinkedIn enrichment | LinkDAPI / ScrapingDog / Brightdata | `ENRICHMENT_PROVIDER`, `LINKDAPI_*`, `SCRAPINGDOG_*`, `BRIGHTDATA_*` |
| Email | SendGrid | `SENDGRID_API_KEY` |
| Object storage | AWS S3 | `AWS_*`, `S3_BUCKET` |
| Google sync | Google OAuth + People/Calendar | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` |
| WhatsApp | Meta Business Cloud API | `WHATSAPP_PHONE_ID`, `WHATSAPP_URL`, `WHATSAPP_TOKEN`, webhook secrets |
| Queues/cache | Redis | `REDIS_URL` |
| RDBMS | Postgres | `DATABASE_URL` |

---

## Known constraints / gotchas
- **BullMQ jobIds cannot contain `:`** — use `_` or `-`. Was causing 500s on `/api/extension/profile` (enrich queue fail would propagate up despite DB insert succeeding).
- **pgx type inference** — when a parameter is used multiple times, always cast explicitly (`$13::text`) and type the `NULL` branches (`NULL::timestamptz`), otherwise Postgres throws "inconsistent types deduced for parameter".
- **DOM extraction is class-name-fragile** — LinkedIn renames `.text-body-medium.break-words` etc. on a rolling basis, and the 2024+ connections page uses fully-obfuscated generated class names (`._01df4767._80e7aa20`). Profile-page name falls back to `document.title` (stable). Connections-page extraction is **class-free**: find `/in/<slug>` anchors, canonicalize (accept absolute + relative hrefs — LinkedIn returns both), reject profile sub-paths (`/overlay/`, `/edit/`, `/opportunities/`, `/details/`, `/mutual/`, …), then walk up from the anchor to the first ancestor that's card-sized.
- **SPA-nav false positives** — LinkedIn mutates the URL query/fragment mid-page (modals, overlays). Watching raw `location.href` in an extension remounts the widget and aborts any in-flight scan. The content script compares **page type + pathname** instead.
- **Enrichment provider churn** — Proxycurl shut down July 2025. Any new integration should plug into `services/enrichment/adapter.js`.
- **nip.io TLS** — `187.127.129.125.nip.io` resolves via a wildcard DNS trick; fine for dev and early prod but switch to a real domain before scaling.
- **Extension ↔ backend cookies** — `SameSite=None; Secure` required. Backend must set `credentials: true` in CORS and allow the extension origin.

---

## Directory cheat-sheet
```
nexo-backend/
├── server.js               app entry (HTTP)
├── workers/
│   ├── index.js            worker entry (BullMQ consumers)
│   └── queues.js           queue + Redis connection
├── routes/                 Express routers, one per domain
├── services/               business logic
│   ├── linkedin/           voyager-based fallback
│   └── enrichment/         provider adapter + impls
├── cron/                   node-cron schedulers
├── db/index.js             pg pool wrapper + query helper
├── middleware/             auth, rate-limit, error, …
├── migrations/             numbered .js migrations (31 total)
├── models/                 thin data-access helpers
└── config/

nexo-extension/
├── manifest.json           MV3, run_at document_idle
├── background.js           service worker (API proxy + alarms)
├── content_script.js       IIFE: capture + in-page widget
├── utils/auth.js           authedFetch, cookie check
└── popup/                  small popup UI
```
