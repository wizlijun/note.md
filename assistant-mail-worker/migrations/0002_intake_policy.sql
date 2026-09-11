CREATE TABLE intake_policy (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  sender_filter_enabled INTEGER NOT NULL CHECK (sender_filter_enabled IN (0, 1)),
  allowed_sender TEXT,
  setup_expires_at TEXT,
  updated_at TEXT NOT NULL
);

INSERT INTO intake_policy
  (singleton, sender_filter_enabled, allowed_sender, setup_expires_at, updated_at)
VALUES (1, 1, NULL, NULL, '1970-01-01T00:00:00.000Z');
