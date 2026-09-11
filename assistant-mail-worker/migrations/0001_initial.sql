PRAGMA foreign_keys = ON;

CREATE TABLE sources (
  id TEXT PRIMARY KEY,
  message_id TEXT,
  envelope_from TEXT NOT NULL,
  envelope_to TEXT NOT NULL,
  header_from TEXT,
  subject TEXT,
  raw_key TEXT NOT NULL,
  raw_size INTEGER NOT NULL,
  raw_sha256 TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('received_pending', 'ready', 'deleting', 'deleted')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE UNIQUE INDEX idx_sources_message_id
  ON sources(message_id) WHERE message_id IS NOT NULL;
CREATE INDEX idx_sources_sha256 ON sources(raw_sha256);
CREATE INDEX idx_sources_status_created ON sources(status, created_at);

CREATE TABLE deliveries (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  received_at TEXT NOT NULL,
  raw_size INTEGER NOT NULL,
  raw_sha256 TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('received_pending', 'accepted', 'duplicate', 'processing_failed')),
  failure_code TEXT,
  FOREIGN KEY (source_id) REFERENCES sources(id)
);

CREATE INDEX idx_deliveries_source ON deliveries(source_id);
CREATE INDEX idx_deliveries_status_received ON deliveries(status, received_at);

CREATE TABLE changes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  change_type TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_changes_created ON changes(created_at);

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  detail_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_audit_created ON audit_events(created_at);

CREATE TABLE deletion_plans (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('pending', 'executing', 'completed', 'failed', 'expired')),
  target_ids_json TEXT NOT NULL,
  targets_json TEXT NOT NULL,
  impact_json TEXT NOT NULL,
  plan_hash TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  executed_at TEXT,
  completed_at TEXT
);

CREATE INDEX idx_deletion_plans_status_expiry ON deletion_plans(status, expires_at);

CREATE TABLE deletion_jobs (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  target_ids_json TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  FOREIGN KEY (plan_id) REFERENCES deletion_plans(id)
);

CREATE INDEX idx_deletion_jobs_status ON deletion_jobs(status, updated_at);
CREATE UNIQUE INDEX idx_deletion_jobs_plan ON deletion_jobs(plan_id);
