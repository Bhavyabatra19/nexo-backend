/**
 * Database Schema for NEXO MVP
 * 
 * This migration creates all necessary tables for:
 * - User authentication
 * - Google OAuth tokens
 * - Contacts management
 * - Calendar integration
 * - Tags and notes
 */

const createUsersTable = `
  CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE NOT NULL,
    full_name VARCHAR(255),
    google_id VARCHAR(255) UNIQUE,
    profile_picture TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_login TIMESTAMP,
    is_active BOOLEAN DEFAULT true
  );

  CREATE INDEX idx_users_email ON users(email);
  CREATE INDEX idx_users_google_id ON users(google_id);
`;

const createGoogleTokensTable = `
  CREATE TABLE IF NOT EXISTS google_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    access_token TEXT NOT NULL,
    refresh_token TEXT,
    token_type VARCHAR(50) DEFAULT 'Bearer',
    expires_at TIMESTAMP NOT NULL,
    scope TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id)
  );

  CREATE INDEX idx_google_tokens_user_id ON google_tokens(user_id);
  CREATE INDEX idx_google_tokens_expires_at ON google_tokens(expires_at);
`;

const createContactsTable = `
  CREATE TABLE IF NOT EXISTS contacts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    google_contact_id VARCHAR(255),
    
    -- Basic Info
    full_name VARCHAR(255),
    first_name VARCHAR(255),
    last_name VARCHAR(255),
    email VARCHAR(255),
    phone VARCHAR(50),
    company VARCHAR(255),
    job_title VARCHAR(255),
    
    -- Additional Data
    photo_url TEXT,
    address TEXT,
    birthday DATE,
    
    -- Calendar Integration Data
    last_contacted TIMESTAMP,
    first_contacted TIMESTAMP,
    total_meetings INTEGER DEFAULT 0,
    upcoming_meetings INTEGER DEFAULT 0,
    past_meetings INTEGER DEFAULT 0,
    days_since_last_contact INTEGER,
    
    -- User Notes & Context
    notes TEXT,
    custom_fields JSONB DEFAULT '{}',
    
    -- Metadata
    source VARCHAR(50) DEFAULT 'google', -- 'google', 'linkedin', 'manual'
    is_favorite BOOLEAN DEFAULT false,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_synced TIMESTAMP,
    
    UNIQUE(user_id, google_contact_id)
  );

  CREATE INDEX idx_contacts_user_id ON contacts(user_id);
  CREATE INDEX idx_contacts_email ON contacts(email);
  CREATE INDEX idx_contacts_last_contacted ON contacts(last_contacted);
  CREATE INDEX idx_contacts_company ON contacts(company);
  CREATE INDEX idx_contacts_is_favorite ON contacts(is_favorite);
`;

const createTagsTable = `
  CREATE TABLE IF NOT EXISTS tags (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    color VARCHAR(7) DEFAULT '#3B82F6', -- Hex color code
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, name)
  );

  CREATE INDEX idx_tags_user_id ON tags(user_id);
`;

const createContactTagsTable = `
  CREATE TABLE IF NOT EXISTS contact_tags (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    contact_id UUID REFERENCES contacts(id) ON DELETE CASCADE,
    tag_id UUID REFERENCES tags(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(contact_id, tag_id)
  );

  CREATE INDEX idx_contact_tags_contact_id ON contact_tags(contact_id);
  CREATE INDEX idx_contact_tags_tag_id ON contact_tags(tag_id);
`;

const createListsTable = `
  CREATE TABLE IF NOT EXISTS lists (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, name)
  );

  CREATE INDEX idx_lists_user_id ON lists(user_id);
`;

const createContactListsTable = `
  CREATE TABLE IF NOT EXISTS contact_lists (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    contact_id UUID REFERENCES contacts(id) ON DELETE CASCADE,
    list_id UUID REFERENCES lists(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(contact_id, list_id)
  );

  CREATE INDEX idx_contact_lists_contact_id ON contact_lists(contact_id);
  CREATE INDEX idx_contact_lists_list_id ON contact_lists(list_id);
`;

const createCalendarEventsTable = `
  CREATE TABLE IF NOT EXISTS calendar_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    google_event_id VARCHAR(255),
    
    -- Event Details
    summary VARCHAR(500),
    description TEXT,
    location TEXT,
    status VARCHAR(50), -- confirmed, tentative, cancelled
    
    -- Time
    start_time TIMESTAMP NOT NULL,
    end_time TIMESTAMP NOT NULL,
    is_all_day BOOLEAN DEFAULT false,
    
    -- Meeting Info
    meeting_link TEXT,
    is_recurring BOOLEAN DEFAULT false,
    
    -- Attendees stored as JSONB array
    attendees JSONB DEFAULT '[]',
    
    -- Metadata
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_synced TIMESTAMP,
    
    UNIQUE(user_id, google_event_id)
  );

  CREATE INDEX idx_calendar_events_user_id ON calendar_events(user_id);
  CREATE INDEX idx_calendar_events_start_time ON calendar_events(start_time);
  CREATE INDEX idx_calendar_events_attendees ON calendar_events USING GIN(attendees);
`;

const createSyncHistoryTable = `
  CREATE TABLE IF NOT EXISTS sync_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    sync_type VARCHAR(50) NOT NULL, -- 'contacts', 'calendar', 'complete'
    status VARCHAR(50) NOT NULL, -- 'success', 'failed', 'partial'
    
    -- Statistics
    contacts_synced INTEGER DEFAULT 0,
    events_synced INTEGER DEFAULT 0,
    errors_count INTEGER DEFAULT 0,
    
    -- Timing
    started_at TIMESTAMP NOT NULL,
    completed_at TIMESTAMP,
    duration_ms INTEGER,
    
    -- Error Details
    error_message TEXT,
    error_details JSONB,
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX idx_sync_history_user_id ON sync_history(user_id);
  CREATE INDEX idx_sync_history_created_at ON sync_history(created_at DESC);
`;

const createUpdatedAtTrigger = `
  -- Function to update updated_at timestamp
  CREATE OR REPLACE FUNCTION update_updated_at_column()
  RETURNS TRIGGER AS $$
  BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
  END;
  $$ language 'plpgsql';

  -- Apply trigger to tables
  DROP TRIGGER IF EXISTS update_users_updated_at ON users;
  CREATE TRIGGER update_users_updated_at 
    BEFORE UPDATE ON users 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

  DROP TRIGGER IF EXISTS update_google_tokens_updated_at ON google_tokens;
  CREATE TRIGGER update_google_tokens_updated_at 
    BEFORE UPDATE ON google_tokens 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

  DROP TRIGGER IF EXISTS update_contacts_updated_at ON contacts;
  CREATE TRIGGER update_contacts_updated_at 
    BEFORE UPDATE ON contacts 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

  DROP TRIGGER IF EXISTS update_lists_updated_at ON lists;
  CREATE TRIGGER update_lists_updated_at 
    BEFORE UPDATE ON lists 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

  DROP TRIGGER IF EXISTS update_calendar_events_updated_at ON calendar_events;
  CREATE TRIGGER update_calendar_events_updated_at 
    BEFORE UPDATE ON calendar_events 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
`;

module.exports = {
  up: async (client) => {
    console.log('Running migration: Create tables...');
    
    await client.query(createUsersTable);
    console.log('✓ Created users table');
    
    await client.query(createGoogleTokensTable);
    console.log('✓ Created google_tokens table');
    
    await client.query(createContactsTable);
    console.log('✓ Created contacts table');
    
    await client.query(createTagsTable);
    console.log('✓ Created tags table');
    
    await client.query(createContactTagsTable);
    console.log('✓ Created contact_tags table');
    
    await client.query(createListsTable);
    console.log('✓ Created lists table');
    
    await client.query(createContactListsTable);
    console.log('✓ Created contact_lists table');
    
    await client.query(createCalendarEventsTable);
    console.log('✓ Created calendar_events table');
    
    await client.query(createSyncHistoryTable);
    console.log('✓ Created sync_history table');
    
    await client.query(createUpdatedAtTrigger);
    console.log('✓ Created updated_at triggers');
    
    console.log('✓ Migration completed successfully');
  },

  down: async (client) => {
    console.log('Rolling back migration...');
    
    await client.query('DROP TABLE IF EXISTS sync_history CASCADE');
    await client.query('DROP TABLE IF EXISTS calendar_events CASCADE');
    await client.query('DROP TABLE IF EXISTS contact_lists CASCADE');
    await client.query('DROP TABLE IF EXISTS lists CASCADE');
    await client.query('DROP TABLE IF EXISTS contact_tags CASCADE');
    await client.query('DROP TABLE IF EXISTS tags CASCADE');
    await client.query('DROP TABLE IF EXISTS contacts CASCADE');
    await client.query('DROP TABLE IF EXISTS google_tokens CASCADE');
    await client.query('DROP TABLE IF EXISTS users CASCADE');
    await client.query('DROP FUNCTION IF EXISTS update_updated_at_column CASCADE');
    
    console.log('✓ Rollback completed');
  }
};
