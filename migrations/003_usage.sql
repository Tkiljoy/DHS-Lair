-- Token + cost tracking. One row per Claude/Gemini call.
-- Aggregates by source and time window for the Settings card.

CREATE TABLE IF NOT EXISTS usage_log (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  ts                  INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
  source              TEXT NOT NULL CHECK (source IN ('claude','gemini')),
  agent_id            TEXT,
  model               TEXT NOT NULL,
  input_tokens        INTEGER NOT NULL DEFAULT 0,
  output_tokens       INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens   INTEGER NOT NULL DEFAULT 0,
  cache_create_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd            REAL NOT NULL DEFAULT 0,
  category            TEXT,        -- 'chat','warroom','mission','memory:consolidate','suggestions:agent_split', etc.
  meta_json           TEXT
);
CREATE INDEX IF NOT EXISTS usage_log_ts ON usage_log(ts DESC);
CREATE INDEX IF NOT EXISTS usage_log_source_ts ON usage_log(source, ts DESC);
