-- DHS-Hive initial schema. Tier 2 memory (no embeddings table).
-- Idempotent: every CREATE uses IF NOT EXISTS.

PRAGMA journal_mode=WAL;
PRAGMA busy_timeout=5000;

-- ─── Agent registry (mirrored from agents/*/agent.yaml on boot) ───
CREATE TABLE IF NOT EXISTS agents (
  id            TEXT PRIMARY KEY,
  display_name  TEXT NOT NULL,
  description   TEXT,
  model         TEXT,
  cwd           TEXT,
  tools_json    TEXT,
  registered_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
  last_seen_at  INTEGER
);

-- ─── Conversation log (every user/agent turn) ─────────────────────
CREATE TABLE IF NOT EXISTS conversation_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
  agent_id    TEXT NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
  text        TEXT NOT NULL,
  source      TEXT,        -- dashboard, warroom, scheduled, etc.
  source_turn TEXT,        -- groups multi-agent responses (e.g. /standup)
  meta_json   TEXT
);
CREATE INDEX IF NOT EXISTS conversation_log_agent_ts ON conversation_log(agent_id, ts DESC);
CREATE INDEX IF NOT EXISTS conversation_log_source_turn ON conversation_log(source_turn);

-- ─── Long-lived facts (Tier 2 memory) ─────────────────────────────
CREATE TABLE IF NOT EXISTS memory (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id     TEXT,           -- nullable = global / shared
  text         TEXT NOT NULL,
  kind         TEXT,           -- 'fact','preference','project','reference'
  source_log   INTEGER,        -- conversation_log.id this was extracted from
  importance   REAL NOT NULL DEFAULT 0.5,    -- 0..1
  salience     REAL NOT NULL DEFAULT 0.5,    -- learned weight, decays + boosts
  pinned       INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
  last_used_at INTEGER,
  decayed      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS memory_agent ON memory(agent_id, decayed);
CREATE INDEX IF NOT EXISTS memory_importance ON memory(importance DESC);

-- FTS5 virtual table for keyword retrieval over memory.text.
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  text,
  content='memory',
  content_rowid='id',
  tokenize='porter unicode61'
);

-- Keep FTS in sync with memory.
CREATE TRIGGER IF NOT EXISTS memory_ai AFTER INSERT ON memory BEGIN
  INSERT INTO memory_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS memory_ad AFTER DELETE ON memory BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, text) VALUES('delete', old.id, old.text);
END;
CREATE TRIGGER IF NOT EXISTS memory_au AFTER UPDATE ON memory BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, text) VALUES('delete', old.id, old.text);
  INSERT INTO memory_fts(rowid, text) VALUES (new.id, new.text);
END;

-- ─── Hive Mind shared activity log (cross-agent visibility) ───────
CREATE TABLE IF NOT EXISTS hive_mind_log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
  agent_id  TEXT NOT NULL,
  event     TEXT NOT NULL,    -- 'spawned','tool_call','message','war_room_entry'
  summary   TEXT,
  meta_json TEXT
);
CREATE INDEX IF NOT EXISTS hive_mind_log_ts ON hive_mind_log(ts DESC);
CREATE INDEX IF NOT EXISTS hive_mind_log_agent ON hive_mind_log(agent_id, ts DESC);

-- ─── Mission queue (tasks routed to agents) ───────────────────────
CREATE TABLE IF NOT EXISTS mission_tasks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
  agent_id    TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed','cancelled')),
  prompt      TEXT NOT NULL,
  result      TEXT,
  started_at  INTEGER,
  finished_at INTEGER,
  meta_json   TEXT
);
CREATE INDEX IF NOT EXISTS mission_tasks_agent_status ON mission_tasks(agent_id, status);

-- ─── Cron entries ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS scheduled_tasks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id    TEXT NOT NULL,
  cron        TEXT NOT NULL,
  prompt      TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,
  last_run_at INTEGER,
  next_run_at INTEGER,
  created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
);

-- ─── Audit log (append-only) ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
  actor_type   TEXT NOT NULL,   -- 'system','agent','user','scheduler'
  actor_id     TEXT,
  action       TEXT NOT NULL,   -- 'agent_spawn','tool_call','kill_switch_flip','exfil_block','message_in','message_out'
  target       TEXT,
  payload_json TEXT
);
CREATE INDEX IF NOT EXISTS audit_log_ts ON audit_log(ts DESC);
CREATE INDEX IF NOT EXISTS audit_log_action ON audit_log(action, ts DESC);

-- ─── War room transcripts ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS warroom_transcript (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
  meeting_id    TEXT NOT NULL,
  command       TEXT NOT NULL,   -- 'standup','discuss'
  agent_id      TEXT,             -- null = consolidator/system entries
  role          TEXT NOT NULL CHECK (role IN ('prompt','response','consolidator')),
  text          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS warroom_meeting ON warroom_transcript(meeting_id, ts);

-- ─── Memory consolidation tracker ─────────────────────────────────
CREATE TABLE IF NOT EXISTS memory_consolidations (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  last_run_at   INTEGER NOT NULL,
  rows_examined INTEGER NOT NULL,
  rows_inserted INTEGER NOT NULL,
  ok            INTEGER NOT NULL,
  error         TEXT
);
