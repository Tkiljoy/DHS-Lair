import { db, nowMs } from './db.js';
import { audit } from './audit-log.js';
import { isGeminiConfigured, generateJSON } from './gemini.js';

export interface MemoryRow {
  id: number;
  agent_id: string | null;
  text: string;
  kind: string | null;
  importance: number;
  salience: number;
  pinned: number;
  created_at: number;
  last_used_at: number | null;
}

export function logTurn(agentId: string, role: 'user' | 'assistant' | 'system', text: string, opts: { source?: string; sourceTurn?: string; meta?: unknown } = {}): number {
  const stmt = db().prepare(`
    INSERT INTO conversation_log (ts, agent_id, role, text, source, source_turn, meta_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const r = stmt.run(nowMs(), agentId, role, text, opts.source ?? 'dashboard', opts.sourceTurn ?? null, opts.meta ? JSON.stringify(opts.meta) : null);
  return Number(r.lastInsertRowid);
}

export function recentTurns(agentId: string, limit = 10): { role: string; text: string; ts: number }[] {
  const rows = db()
    .prepare(`SELECT role, text, ts FROM conversation_log WHERE agent_id = ? ORDER BY ts DESC LIMIT ?`)
    .all(agentId, limit) as { role: string; text: string; ts: number }[];
  return rows.reverse();
}

function ftsQuery(text: string): string {
  // Quote tokens to keep FTS5 syntax happy with arbitrary user input.
  return text
    .split(/\s+/)
    .filter(Boolean)
    .filter(w => /[a-z0-9]/i.test(w))
    .slice(0, 10)
    .map(w => `"${w.replace(/"/g, '""')}"`)
    .join(' OR ');
}

export function relevantMemories(agentId: string, queryText: string, limit = 8): MemoryRow[] {
  const q = ftsQuery(queryText);
  const rows: MemoryRow[] = [];
  if (q) {
    const ftsRows = db().prepare(`
      SELECT m.*
      FROM memory_fts f
      JOIN memory m ON m.id = f.rowid
      WHERE memory_fts MATCH ?
        AND m.decayed = 0
        AND (m.agent_id = ? OR m.agent_id IS NULL)
      ORDER BY (m.importance * 0.4 + m.salience * 0.4 + (m.pinned * 0.2)) DESC
      LIMIT ?
    `).all(q, agentId, limit) as MemoryRow[];
    rows.push(...ftsRows);
  }
  // Always include pinned memories for this agent.
  const pinned = db().prepare(`
    SELECT * FROM memory
    WHERE pinned = 1 AND decayed = 0 AND (agent_id = ? OR agent_id IS NULL)
    ORDER BY importance DESC LIMIT ?
  `).all(agentId, limit) as MemoryRow[];
  const seen = new Set<number>();
  const merged: MemoryRow[] = [];
  for (const r of [...pinned, ...rows]) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    merged.push(r);
    if (merged.length >= limit) break;
  }
  return merged;
}

export function buildMemoryBlock(agentId: string, queryText: string): string {
  const mems = relevantMemories(agentId, queryText);
  if (mems.length === 0) return '';
  const lines = ['## Relevant memories', ''];
  for (const m of mems) {
    const tag = m.pinned ? '[PINNED]' : `[${(m.kind ?? 'fact')}]`;
    lines.push(`- ${tag} ${m.text}`);
  }
  return lines.join('\n');
}

export function markMemoryUsed(ids: number[]): void {
  if (ids.length === 0) return;
  const ts = nowMs();
  const stmt = db().prepare(`UPDATE memory SET salience = MIN(1.0, salience + 0.05), last_used_at = ? WHERE id = ?`);
  const tx = db().transaction((ids: number[]) => {
    for (const id of ids) stmt.run(ts, id);
  });
  tx(ids);
}

export function decayMemoryStep(): void {
  // Halve salience monthly for memories not used recently. Mark decayed=1 once below 0.05.
  const cutoff = nowMs() - 30 * 24 * 60 * 60 * 1000;
  db().prepare(`
    UPDATE memory
    SET salience = salience * 0.85
    WHERE pinned = 0 AND decayed = 0 AND (last_used_at IS NULL OR last_used_at < ?)
  `).run(cutoff);
  db().prepare(`UPDATE memory SET decayed = 1 WHERE pinned = 0 AND salience < 0.05`).run();
}

// ─── Tier 2 extraction job ───────────────────────────────────────

interface ExtractedFact {
  text: string;
  kind?: string;
  importance?: number;
  agent_id?: string | null;
}

export async function consolidateMemory(opts: { sinceMs?: number } = {}): Promise<{ examined: number; inserted: number; ok: boolean; error?: string }> {
  const since = opts.sinceMs ?? nowMs() - 60 * 60 * 1000; // last hour by default
  const rows = db().prepare(`
    SELECT id, ts, agent_id, role, text FROM conversation_log
    WHERE ts > ? AND role IN ('user','assistant')
    ORDER BY ts ASC
  `).all(since) as { id: number; ts: number; agent_id: string; role: string; text: string }[];

  if (rows.length === 0) {
    db().prepare(`INSERT INTO memory_consolidations (last_run_at, rows_examined, rows_inserted, ok) VALUES (?, ?, ?, ?)`)
      .run(nowMs(), 0, 0, 1);
    return { examined: 0, inserted: 0, ok: true };
  }

  if (!isGeminiConfigured()) {
    db().prepare(`INSERT INTO memory_consolidations (last_run_at, rows_examined, rows_inserted, ok, error) VALUES (?, ?, ?, ?, ?)`)
      .run(nowMs(), rows.length, 0, 0, 'GEMINI_API_KEY missing');
    return { examined: rows.length, inserted: 0, ok: false, error: 'GEMINI_API_KEY missing' };
  }

  const transcript = rows.map(r => `[${r.role} → ${r.agent_id}] ${r.text}`).join('\n');
  const prompt = `You extract durable facts from a recent conversation transcript so a multi-agent system can recall them later. Return ONLY a JSON array (no prose, no code fences) of objects: {text, kind, importance, agent_id}.

Rules:
- text: a single durable fact, preference, project state, or reference. One sentence. No transient task chatter.
- kind: one of "fact","preference","project","reference".
- importance: 0..1. Higher = more durable / more user-stated.
- agent_id: agent this fact relates to (if scoped) or null for global.
- Return [] if nothing in the transcript is worth remembering.

Transcript:
${transcript.slice(0, 16000)}`;

  let extracted: ExtractedFact[] = [];
  try {
    const result = await generateJSON<ExtractedFact[] | unknown>({ prompt, category: 'memory:consolidate' });
    extracted = Array.isArray(result) ? (result as ExtractedFact[]) : [];
  } catch (err) {
    db().prepare(`INSERT INTO memory_consolidations (last_run_at, rows_examined, rows_inserted, ok, error) VALUES (?, ?, ?, ?, ?)`)
      .run(nowMs(), rows.length, 0, 0, String(err));
    return { examined: rows.length, inserted: 0, ok: false, error: String(err) };
  }

  const insertStmt = db().prepare(`
    INSERT INTO memory (agent_id, text, kind, importance, salience, source_log)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const tx = db().transaction((items: ExtractedFact[]) => {
    let inserted = 0;
    for (const f of items) {
      if (!f?.text) continue;
      const dup = db().prepare(`SELECT id FROM memory WHERE text = ? AND (agent_id IS ? OR agent_id = ?)`).get(f.text, f.agent_id ?? null, f.agent_id ?? null);
      if (dup) continue;
      const importance = Math.max(0, Math.min(1, Number(f.importance ?? 0.5)));
      insertStmt.run(f.agent_id ?? null, f.text, f.kind ?? 'fact', importance, importance, rows[rows.length - 1].id);
      inserted++;
    }
    return inserted;
  });
  const inserted = tx(extracted);

  db().prepare(`INSERT INTO memory_consolidations (last_run_at, rows_examined, rows_inserted, ok) VALUES (?, ?, ?, ?)`)
    .run(nowMs(), rows.length, inserted, 1);

  audit({ actorType: 'system', action: 'memory_consolidation', payload: { examined: rows.length, inserted } });

  return { examined: rows.length, inserted, ok: true };
}
