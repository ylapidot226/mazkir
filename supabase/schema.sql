-- Mazkir - WhatsApp AI Assistant
-- Run this script in your Supabase SQL Editor

-- Users table
CREATE TABLE users (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  phone_number TEXT UNIQUE NOT NULL,
  name TEXT,
  email TEXT,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'blocked')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Events table
CREATE TABLE events (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  datetime TIMESTAMPTZ NOT NULL,
  location TEXT,
  reminder_sent BOOLEAN DEFAULT FALSE,
  day_reminder_sent BOOLEAN DEFAULT FALSE,
  day_summary_sent BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Tasks table
CREATE TABLE tasks (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  category TEXT NOT NULL DEFAULT 'כללי',
  content TEXT NOT NULL,
  completed BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Shopping list table
CREATE TABLE shopping_list (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  item TEXT NOT NULL,
  done BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Reminders table
CREATE TABLE reminders (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  remind_at TIMESTAMPTZ NOT NULL,
  sent BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Message log for context
CREATE TABLE messages (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Recurring events table
CREATE TABLE recurring_events (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  days TEXT NOT NULL,
  time TEXT NOT NULL,
  location TEXT,
  active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Calendar connections table
CREATE TABLE calendar_connections (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('google', 'apple', 'monday')),
  credentials TEXT NOT NULL,
  calendar_id TEXT DEFAULT 'primary',
  sync_token TEXT,
  last_synced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, provider)
);

-- Add external calendar fields to events table
ALTER TABLE events ADD COLUMN IF NOT EXISTS external_id TEXT;
ALTER TABLE events ADD COLUMN IF NOT EXISTS source TEXT CHECK (source IN ('whatsapp', 'google', 'apple'));

-- Indexes for performance
CREATE INDEX idx_recurring_user ON recurring_events(user_id, active);
CREATE INDEX idx_users_phone ON users(phone_number);
CREATE INDEX idx_events_user ON events(user_id);
CREATE INDEX idx_events_datetime ON events(datetime);
CREATE INDEX idx_events_reminder ON events(reminder_sent, datetime);
CREATE INDEX idx_tasks_user_category ON tasks(user_id, category);
CREATE INDEX idx_shopping_user ON shopping_list(user_id);
CREATE INDEX idx_reminders_remind_at ON reminders(remind_at, sent);
CREATE INDEX idx_messages_user ON messages(user_id, created_at DESC);
CREATE INDEX idx_calendar_connections_user ON calendar_connections(user_id);
CREATE INDEX idx_events_external_id ON events(external_id);
