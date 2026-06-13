-- Suggestions system: periodic detectors flag overloaded agents and
-- stale missions. User accepts/dismisses/snoozes; accepted suggestions
-- file a mission_task row.

CREATE TABLE IF NOT EXISTS agent_suggestions (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  ts                    INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
  suggestion_type       TEXT NOT NULL CHECK (suggestion_type IN ('agent_split','stale_mission')),
  target_agent_id       TEXT,
  related_mission_id    INTEGER,
  title                 TEXT NOT NULL,
  rationale             TEXT NOT NULL,
  proposed_action_json  TEXT,
  payload_json          TEXT,
  status                TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','dismissed','snoozed')),
  status_changed_at     INTEGER,
  status_changed_by     TEXT,
  filed_mission_id      INTEGER,
  snooze_until          INTEGER
);
CREATE INDEX IF NOT EXISTS suggestions_status ON agent_suggestions(status, ts DESC);
CREATE INDEX IF NOT EXISTS suggestions_target ON agent_suggestions(target_agent_id, status);
CREATE INDEX IF NOT EXISTS suggestions_mission ON agent_suggestions(related_mission_id, status);

CREATE TABLE IF NOT EXISTS suggestion_runs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ts              INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
  trigger         TEXT NOT NULL,
  total_inserted  INTEGER NOT NULL,
  by_type_json    TEXT,
  duration_ms     INTEGER NOT NULL,
  outcome         TEXT NOT NULL,
  errors_json     TEXT
);
CREATE INDEX IF NOT EXISTS suggestion_runs_ts ON suggestion_runs(ts DESC);
