ALTER TABLE messages ADD COLUMN local_move INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN list_id TEXT;
ALTER TABLE messages ADD COLUMN auto_submitted TEXT;
ALTER TABLE messages ADD COLUMN precedence TEXT;
CREATE TABLE cached_moves (
  message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  origin_folder INTEGER NOT NULL,
  origin_uid INTEGER NOT NULL,
  origin_validity INTEGER,
  expected_folder INTEGER NOT NULL,
  desired_folder INTEGER NOT NULL,
  confirmed INTEGER NOT NULL DEFAULT 0,
  read_override INTEGER,
  star_override INTEGER
);
CREATE INDEX idx_messages_local_move ON messages(local_move, account_id, message_id);
