import { db, nowMs } from './db.js';
import { getEnv } from './kill-switches.js';

export type AuditAction =
  | 'agent_spawn'
  | 'agent_response'
  | 'tool_call'
  | 'kill_switch_flip'
  | 'kill_switch_refusal'
  | 'exfil_block'
  | 'message_in'
  | 'message_out'
  | 'warroom_meeting'
  | 'memory_consolidation'
  | 'suggestion_inserted'
  | 'suggestion_accepted'
  | 'suggestion_dismissed'
  | 'suggestion_snoozed'
  | 'suggestions_run'
  | 'team_discussion_created'
  | 'startup'
  | 'shutdown';

export interface AuditEntry {
  actorType: 'system' | 'agent' | 'user' | 'scheduler';
  actorId?: string;
  action: AuditAction;
  target?: string;
  payload?: unknown;
}

export function audit(entry: AuditEntry): void {
  const stmt = db().prepare(`
    INSERT INTO audit_log (ts, actor_type, actor_id, action, target, payload_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    nowMs(),
    entry.actorType,
    entry.actorId ?? null,
    entry.action,
    entry.target ?? null,
    entry.payload === undefined ? null : JSON.stringify(entry.payload)
  );
}

export function recentAudit(limit = 100): unknown[] {
  return db()
    .prepare(`SELECT * FROM audit_log ORDER BY ts DESC LIMIT ?`)
    .all(limit);
}

export function pruneAudit(): void {
  const days = parseInt(getEnv('AUDIT_LOG_RETENTION_DAYS', '90') ?? '90', 10);
  const cutoff = nowMs() - days * 24 * 60 * 60 * 1000;
  db().prepare(`DELETE FROM audit_log WHERE ts < ?`).run(cutoff);
}
