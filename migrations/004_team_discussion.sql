-- DHS-Hive — team discussion mode.
-- Persistent multi-agent threads (distinct from war room, which is fire-and-forget
-- consensus). Lets Tkiljoy hold a sustained back-and-forth with N agents at once,
-- with full history carried forward each turn. @-mention turn-taking by default
-- to keep token cost predictable.

CREATE TABLE IF NOT EXISTS team_discussion_threads (
  thread_id        TEXT PRIMARY KEY,
  title            TEXT NOT NULL,
  participants_json TEXT NOT NULL,   -- JSON array of agent ids
  created_at       INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
  last_activity    INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
  meta_json        TEXT
);
CREATE INDEX IF NOT EXISTS team_discussion_threads_recent ON team_discussion_threads(last_activity DESC);

CREATE TABLE IF NOT EXISTS team_discussion_turns (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id   TEXT NOT NULL REFERENCES team_discussion_threads(thread_id) ON DELETE CASCADE,
  turn_index  INTEGER NOT NULL,
  agent_id    TEXT,                   -- null = user
  role        TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
  text        TEXT NOT NULL,
  ts          INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
  meta_json   TEXT
);
CREATE INDEX IF NOT EXISTS team_discussion_turns_thread ON team_discussion_turns(thread_id, turn_index);
