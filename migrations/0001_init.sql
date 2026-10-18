-- Jobber Visit -> Google Calendar sync schema (Cloudflare D1 / SQLite)

-- One row per connected Jobber account. Tokens are AES-GCM encrypted with TOKEN_ENCRYPTION_KEY.
CREATE TABLE IF NOT EXISTS jobber_accounts (
  account_id          TEXT PRIMARY KEY,           -- Jobber Account.id (EncodedId)
  account_name        TEXT,
  access_token_enc    TEXT NOT NULL,
  refresh_token_enc   TEXT NOT NULL,
  access_expires_at   INTEGER NOT NULL,           -- epoch ms
  refresh_lock_until  INTEGER,                    -- epoch ms; single-refresher lock (rotation safety)
  status              TEXT NOT NULL DEFAULT 'active', -- active | reauth_required | disconnected
  connected_at        INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);

-- Short-lived OAuth state + PKCE verifier (10 minute TTL).
CREATE TABLE IF NOT EXISTS oauth_states (
  state         TEXT PRIMARY KEY,
  code_verifier TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);

-- Team-member mapping: Jobber User.id -> Google Calendar ID. Platform IDs only (no names/emails as keys).
CREATE TABLE IF NOT EXISTS user_calendar_map (
  account_id          TEXT NOT NULL,
  jobber_user_id      TEXT NOT NULL,              -- Jobber User.id (EncodedId)
  google_calendar_id  TEXT NOT NULL,              -- e.g. estimator@company.com or xyz@group.calendar.google.com
  label               TEXT,                       -- human note only, never used for matching
  active              INTEGER NOT NULL DEFAULT 1,
  updated_at          INTEGER NOT NULL,
  PRIMARY KEY (account_id, jobber_user_id)
);

-- What we have written to Google. Written BEFORE each Google create so deletes always have the mapping,
-- even after the Visit is gone from Jobber.
CREATE TABLE IF NOT EXISTS visit_events (
  account_id          TEXT NOT NULL,
  visit_id            TEXT NOT NULL,
  jobber_user_id      TEXT NOT NULL,
  job_id              TEXT NOT NULL,
  google_calendar_id  TEXT NOT NULL,
  google_event_id     TEXT NOT NULL,              -- deterministic: "jv" + sha256(account|visit|user)[0..40]
  content_hash        TEXT,                       -- NULL until the Google write is confirmed
  last_synced_at      INTEGER NOT NULL,
  PRIMARY KEY (account_id, visit_id, jobber_user_id)
);
CREATE INDEX IF NOT EXISTS idx_visit_events_job ON visit_events (account_id, job_id);

-- Lightweight audit trail (mirrors the structured console logs; pruned after 30 days).
CREATE TABLE IF NOT EXISTS sync_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          INTEGER NOT NULL,
  topic       TEXT,
  account_id  TEXT,
  item_id     TEXT,
  job_id      TEXT,
  action      TEXT NOT NULL,                      -- created | updated | deleted | noop | skipped | error
  detail      TEXT
);
CREATE INDEX IF NOT EXISTS idx_sync_log_at ON sync_log (at);
