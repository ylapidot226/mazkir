-- Calendar Sync Migration
-- Run this in Supabase SQL Editor

-- 1. Create calendar_connections table
CREATE TABLE IF NOT EXISTS calendar_connections (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('google', 'apple')),
  credentials TEXT NOT NULL,
  calendar_id TEXT DEFAULT 'primary',
  sync_token TEXT,
  last_synced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, provider)
);

-- 2. Add external calendar fields to events table
ALTER TABLE events ADD COLUMN IF NOT EXISTS external_id TEXT;
ALTER TABLE events ADD COLUMN IF NOT EXISTS source TEXT CHECK (source IN ('whatsapp', 'google', 'apple'));

-- 3. Add indexes
CREATE INDEX IF NOT EXISTS idx_calendar_connections_user ON calendar_connections(user_id);
CREATE INDEX IF NOT EXISTS idx_events_external_id ON events(external_id);
CREATE INDEX IF NOT EXISTS idx_events_source ON events(user_id, source);

-- 4. Connect tokens table (for serverless OAuth flow)
CREATE TABLE IF NOT EXISTS connect_tokens (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  token TEXT UNIQUE NOT NULL,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_connect_tokens_token ON connect_tokens(token);
