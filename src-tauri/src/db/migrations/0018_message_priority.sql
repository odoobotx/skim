ALTER TABLE messages ADD COLUMN priority_override INTEGER;
ALTER TABLE messages ADD COLUMN priority_at INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_messages_pinned ON messages(account_id, date DESC) WHERE is_starred = 1;
