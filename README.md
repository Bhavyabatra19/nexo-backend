# NEXO — Personal CRM Backend

> RESTful API powering the NEXO Personal CRM platform.

The NEXO backend is an Express.js API with PostgreSQL that handles Google OAuth authentication, contact & calendar sync via Google APIs, LinkedIn CSV imports, reminders, notes, tags, and automated nightly sync jobs.

---

## ✨ Features

- **Google OAuth 2.0** — Full authentication flow with JWT access/refresh tokens
- **Google Contacts Sync** — Fetch and upsert contacts from Google People API
- **Google Calendar Sync** — Fetch calendar events and extract attendee interaction data
- **LinkedIn CSV Import** — Parse and import LinkedIn connection exports with fuzzy duplicate detection
- **Contact Management** — CRUD with search, pagination, sorting, filtering, favorites, and tags
- **Tag System** — Create, update, delete, and bulk-assign color-coded tags
- **Reminders** — CRUD with contact association, completion toggle, and due date tracking
- **Notes** — Per-contact notes with timestamps
- **Activity Timeline** — Auto-logged activities for key actions (sync, reminders, etc.)
- **Sync History** — Track last 5 sync operations with status, duration, and counts
- **Nightly Cron Job** — Automated scheduled sync at midnight pulling only updated data from Google
- **Database Migrations** — Versioned migration system for schema management

---

## 🛠 Tech Stack

| Category | Technology |
|---|---|
| **Runtime** | Node.js |
| **Framework** | [Express.js 5](https://expressjs.com/) |
| **Database** | PostgreSQL (via [`pg`](https://node-postgres.com/)) |
| **Authentication** | JWT (jsonwebtoken) + Google OAuth 2.0 |
| **Google APIs** | googleapis (People API, Calendar API) |
| **Scheduling** | node-cron |
| **File Uploads** | multer |
| **Fuzzy Matching** | string-similarity |
| **Password Hashing** | bcrypt |

---

## 📁 Project Structure

```
be/
├── server.js                 # Express app entry point, middleware, route mounting
├── package.json              # Dependencies and scripts
├── .env.example              # Environment variable template
│
├── config/
│   └── oauth.js              # Google OAuth2 client configuration
│
├── middleware/
│   └── auth.js               # JWT authentication middleware (authenticateToken)
│
├── routes/
│   ├── auth.js               # Google OAuth flow, login, token refresh, logout
│   ├── contacts.js           # Contact CRUD, search, pagination, favorites, tags
│   ├── sync.js               # Google sync (complete, contacts-only, status)
│   ├── calendar.js           # Calendar events per contact
│   ├── reminders.js          # Reminder CRUD with contact association
│   ├── notes.js              # Per-contact notes CRUD
│   ├── activities.js         # Activity timeline per contact
│   ├── organize.js           # Tags and lists management
│   ├── linkedin.js           # LinkedIn CSV upload, parse, import
│   └── debug.js              # Debug/diagnostic endpoints
│
├── models/
│   ├── User.js               # User account model
│   ├── Token.js              # Google OAuth token storage and refresh
│   ├── Contact.js            # Contact model with bulkUpsert
│   ├── CalendarEvent.js      # Calendar event model with bulkUpsert
│   ├── Reminder.js           # Reminder model (CRUD, contact association)
│   ├── Note.js               # Note model
│   ├── Activity.js           # Activity log model
│   └── LinkedInImport.js     # LinkedIn import with fuzzy duplicate detection
│
├── services/
│   ├── integrationService.js # Orchestrates contacts + calendar sync
│   ├── contactsService.js    # Google People API client
│   └── calendarService.js    # Google Calendar API client + interaction extraction
│
├── cron/
│   └── syncJob.js            # Nightly scheduled sync (midnight, incremental)
│
├── db/
│   └── index.js              # PostgreSQL connection pool
│
└── migrations/
    ├── run-migrations.js     # Migration runner
    ├── 001_create_tables.js  # Core tables (users, contacts, calendar_events, etc.)
    ├── 002_add_linkedin_url.js
    ├── 003_create_notes_table.js
    ├── 004_create_reminders_table.js
    └── 005_create_activities_table.js
```

---

## 🚀 Getting Started

### Prerequisites

- **Node.js** ≥ 18
- **PostgreSQL** ≥ 14
- **Google Cloud Console** project with People API and Calendar API enabled
- A Google OAuth 2.0 Client ID (Web application type)

### Installation

```bash
# Clone the repository
git clone https://github.com/amansingh962000-beep/Nexo-Backend.git
cd Nexo-Backend

# Install dependencies
npm install

# Set up environment variables
cp .env.example .env
# Edit .env with your actual values (see Environment Variables below)
```

### Database Setup

```bash
# Create the PostgreSQL database
createdb nexo_mvp

# Run migrations
npm run migrate
```

### Development

```bash
npm run dev
```

Server runs at **http://localhost:3000** with nodemon auto-reload.

### Production

```bash
npm start
```

---

## ⚙️ Environment Variables

Copy `.env.example` to `.env` and fill in your values:

| Variable | Description | Example |
|---|---|---|
| `PORT` | Server port | `3000` |
| `BASE_URL` | Server base URL | `http://localhost:3000` |
| `DATABASE_URL` | PostgreSQL connection string | `postgresql://user:pass@localhost:5432/nexo_mvp` |
| `GOOGLE_CLIENT_ID` | Google OAuth Client ID | `xxxx.apps.googleusercontent.com` |
| `GOOGLE_CLIENT_SECRET` | Google OAuth Client Secret | `GOCSPX-xxxx` |
| `GOOGLE_REDIRECT_URI` | OAuth callback URL | `http://localhost:3000/api/auth/google/callback` |
| `SESSION_SECRET` | Express session secret | (random string) |
| `JWT_SECRET` | JWT signing secret | (random string) |
| `JWT_EXPIRES_IN` | JWT token expiry | `7d` |
| `FRONTEND_URL` | Frontend URL for CORS | `http://localhost:4000` |

---

## 📡 API Endpoints

### Authentication
| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/auth/google` | Initiate Google OAuth flow |
| `GET` | `/api/auth/google/callback` | OAuth callback (exchanges code for tokens) |
| `POST` | `/api/auth/refresh` | Refresh access token |
| `GET` | `/api/auth/me` | Get current authenticated user |
| `POST` | `/api/auth/logout` | Logout user |
| `DELETE` | `/api/auth/disconnect` | Disconnect Google account |

### Contacts
| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/contacts` | Get contacts (paginated, searchable, sortable) |
| `GET` | `/api/contacts/stats` | Contact statistics |
| `GET` | `/api/contacts/:id` | Get single contact |
| `PATCH` | `/api/contacts/:id/notes` | Update contact notes |
| `POST` | `/api/contacts/:id/favorite` | Toggle favorite |
| `POST` | `/api/contacts/:id/tags` | Add tag to contact |
| `DELETE` | `/api/contacts/:id/tags/:tagId` | Remove tag from contact |
| `POST` | `/api/contacts/bulk/tags` | Bulk add tag |
| `DELETE` | `/api/contacts/bulk/tags` | Bulk remove tag |

### Sync
| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/sync/complete` | Full sync (contacts + calendar) |
| `POST` | `/api/sync/contacts-only` | Contacts-only sync |
| `GET` | `/api/sync/status` | Sync history (last 5) |

### Reminders
| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/reminders` | Get all user reminders |
| `GET` | `/api/reminders/:contactId` | Get reminders for a contact |
| `POST` | `/api/reminders/:contactId` | Create reminder |
| `PUT` | `/api/reminders/:reminderId` | Update reminder (title, date, contact, completion) |
| `DELETE` | `/api/reminders/:reminderId` | Delete reminder |

### Organization
| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/organize/tags` | List all tags |
| `POST` | `/api/organize/tags` | Create tag |
| `PUT` | `/api/organize/tags/:id` | Update tag |
| `DELETE` | `/api/organize/tags/:id` | Delete tag |

### Notes
| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/notes/:contactId` | Get notes for contact |
| `POST` | `/api/notes/:contactId` | Create note |
| `PUT` | `/api/notes/:noteId` | Update note |
| `DELETE` | `/api/notes/:noteId` | Delete note |

### Activities
| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/activities/:contactId` | Get activity timeline for contact |

### Calendar
| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/calendar/:contactId` | Get calendar events for contact |

### LinkedIn Import
| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/linkedin/upload` | Upload LinkedIn CSV |
| `POST` | `/api/linkedin/import` | Import parsed connections |

---

## ⏰ Scheduled Jobs

| Job | Schedule | Description |
|---|---|---|
| Nightly Sync | `0 0 * * *` (midnight) | Syncs Google Contacts & Calendar for all users, pulling only data updated since the last successful sync. Keeps the last 5 sync history records per user. |

---

## 🗄️ Database Schema

Core tables created by migrations:

| Table | Purpose |
|---|---|
| `users` | User accounts (email, name, Google ID) |
| `google_tokens` | Google OAuth tokens (access, refresh, expiry) |
| `contacts` | Synced contacts (name, email, company, phone, etc.) |
| `calendar_events` | Synced Google Calendar events |
| `tags` | User-defined color-coded tags |
| `contact_tags` | Many-to-many contact ↔ tag mapping |
| `notes` | Per-contact notes |
| `reminders` | Reminders with due dates and contact association |
| `activities` | Activity timeline log |
| `sync_history` | Sync operation records (status, duration, counts) |
| `migrations` | Migration tracking |

---

## 📄 License

This project is private and not licensed for public distribution.
