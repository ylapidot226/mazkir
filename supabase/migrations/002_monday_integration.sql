-- Add Monday.com as a valid provider for calendar_connections table
-- Monday.com tokens never expire, so we reuse the same credentials/connection pattern

-- Drop the existing CHECK constraint and add Monday.com
ALTER TABLE calendar_connections DROP CONSTRAINT IF EXISTS calendar_connections_provider_check;
ALTER TABLE calendar_connections ADD CONSTRAINT calendar_connections_provider_check CHECK (provider IN ('google', 'apple', 'monday'));

-- Monday.com board preferences per user (which board to use by default)
CREATE TABLE IF NOT EXISTS monday_preferences (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  default_board_id TEXT,
  default_board_name TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id)
);
