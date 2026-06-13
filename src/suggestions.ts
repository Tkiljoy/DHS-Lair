import { db, nowMs } from './db.js';
import { audit } from './audit-log.js';
import { isGeminiConfigured, generateJSON } from './gemini.js';

export type SuggestionType = 'agent_split' | 'stale_mission';
export type SuggestionStatus = 'pending' | 'accepted' | 'dismissed' | 'snoozed';

export interface Suggestion {
  id: number;
  ts: number;
  suggestion_type: SuggestionType;
  target_agent_id: string | null;
  related_mission_id: number | null;
  title: string;
  rationale: string;
  proposed_action: unknown;
  payload: unknown;
  status: SuggestionStatus;
  status_changed_at: number | null;
  status_changed_by: string | null;
  filed_mission_id: number | null;
  snooze_until: number | null;
}

export interface SuggestionRunResult {
  totalInserted: number;
  byType: { agent_split: number; stale_mission: number };
  durationMs: number;
  errors: string[];
}

const STALE_INSERTIONS_PER_RUN = 5;
// Calibrated for small / fresh systems. Raise these once usage settles into
// a steady weekly rhythm and noisy false-positives become a problem.
const AGENT_OVERLOAD_MIN_TURNS = 10;
// Fraction of the week's user turns this single agent has to handle to be
// flagged as a candidate for splitting. 0.6 = "this agent does 60%+ of all
// agent-facing work right now." Replaces the old `> 2 * median` test, which
// is mathematically near-impossible to hit with only 2-3 active agents.
const AGENT_OVERLOAD_DOMINANCE = 0.6;
const STALE_RUNNING_DAYS = 2;
const STALE_QUEUED_DAYS = 5;
const MIN_SPLIT_FRACTION = 0.25;

function row2suggestion(row: Record<string, unknown>): Suggestion {
  return {
    id: row.id as number,
    ts: row.ts as number,
    suggestion_type: row.suggestion_type as SuggestionType,
    target_agent_id: (row.target_agent_id as string) ?? null,
    related_mission_id: (row.related_mission_id as number) ?? null,
    title: row.title as string,
    rationale: row.rationale as string,
    proposed_action: row.proposed_action_json ? JSON.parse(row.proposed_action_json as string) : null,
    payload: row.payload_json ? JSON.parse(row.payload_json as string) : null,
    status: row.status as SuggestionStatus,
    status_changed_at: (row.status_changed_at as number) ?? null,
    status_changed_by: (row.status_changed_by as string) ?? null,
    filed_mission_id: (row.filed_mission_id as number) ?? null,
    snooze_until: (row.snooze_until as number) ?? null,
  };
}

function suggestionAlreadyOpen(type: SuggestionType, opts: { targetAgentId?: string | null; relatedMissionId?: number }): boolean {
  const conds = ['suggestion_type = ?'];
  const params: unknown[] = [type];
  if (opts.targetAgentId !== undefined) {
    conds.push('target_agent_id IS ?');
    params.push(opts.targetAgentId);
  }
  if (opts.relatedMissionId !== undefined) {
    conds.push('related_mission_id = ?');
    params.push(opts.relatedMissionId);
  }
  const sql = `
    SELECT 1 FROM agent_suggestions
    WHERE ${conds.join(' AND ')}
      AND (status = 'pending' OR (status = 'snoozed' AND (snooze_until IS NULL OR snooze_until > ?)))
    LIMIT 1
  `;
  params.push(nowMs());
  return db().prepare(sql).get(...params) !== undefined;
}

// ─── Detector 1: agent overload ──────────────────────────

interface ClusterResponse {
  is_split_viable: boolean;
  categories?: Array<{ name: string; fraction: number; examples?: string[] }>;
  split_recommendation?: {
    new_agent_id: string;
    new_agent_display_name: string;
    new_agent_description: string;
    fraction_of_current_work: number;
    rationale: string;
  };
  reasoning?: string;
}

async function runAgentSplitClustering(agentId: string, turns: number, median: number): Promise<ClusterResponse | null> {
  const desc = (db().prepare(`SELECT description FROM agents WHERE id = ?`).get(agentId) as { description?: string } | undefined)?.description ?? '(no persona on file)';
  const recent = db().prepare(`
    SELECT text FROM conversation_log
    WHERE agent_id = ? AND role = 'user' AND (source IS NULL OR source != 'warroom')
    ORDER BY id DESC LIMIT 50
  `).all(agentId) as { text: string }[];
  const turnList = recent.map((r, i) => `${i + 1}. ${r.text.replace(/\s+/g, ' ').trim().slice(0, 200)}`).join('\n');

  const prompt = `You are analyzing whether an AI agent's workload should be split into multiple specialized agents.

Agent ID: ${agentId}
Persona summary: ${desc}
Workload signal: ${turns} inbound user turns in the last 7 days vs a median of ${median.toFixed(1)} across other agents.

Recent user turns directed at this agent (most recent first):
${turnList}

Analyze the categories of work this agent handles. Are any categories distinct enough that they'd benefit from being a separate specialized agent?

Return JSON in this exact shape:
{
  "is_split_viable": true | false,
  "categories": [
    { "name": "<category>", "fraction": 0.0-1.0, "examples": ["<turn snippet>"] }
  ],
  "split_recommendation": {
    "new_agent_id": "<lowercase-hyphenated id>",
    "new_agent_display_name": "<title case>",
    "new_agent_description": "<one-sentence persona summary>",
    "fraction_of_current_work": 0.0-1.0,
    "rationale": "<2-3 sentences why splitting is worth it>"
  },
  "reasoning": "<2-3 sentences overall>"
}

DO NOT recommend splits unless the new agent would handle >=${Math.round(MIN_SPLIT_FRACTION * 100)}% of work AND >=3 distinct turns clearly cluster into the new category. If no clean split exists, set is_split_viable=false and omit split_recommendation.`;

  try {
    return await generateJSON<ClusterResponse>({ prompt, category: 'suggestions:agent_split' });
  } catch (err) {
    console.error(`[suggestions] agent_split clustering failed for ${agentId}:`, err);
    return null;
  }
}

async function detectAgentOverload(): Promise<number> {
  const sevenDaysAgoMs = nowMs() - 7 * 24 * 60 * 60 * 1000;
  const rows = db().prepare(`
    SELECT agent_id AS agentId, COUNT(*) AS turns
    FROM conversation_log
    WHERE ts > ?
      AND role = 'user'
      AND (source IS NULL OR source != 'warroom')
      AND agent_id IS NOT NULL
    GROUP BY agent_id
    ORDER BY turns DESC
  `).all(sevenDaysAgoMs) as { agentId: string; turns: number }[];

  if (rows.length === 0) return 0;

  const total = rows.reduce((s, r) => s + r.turns, 0);
  // Median is computed but used only as informational context in the
  // clustering prompt — the trigger condition is dominance-based, not
  // median-ratio (which fails for small N).
  const sorted = [...rows].sort((a, b) => a.turns - b.turns);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0
    ? (sorted[mid - 1].turns + sorted[mid].turns) / 2
    : sorted[mid].turns;

  let inserted = 0;
  for (const r of rows) {
    if (r.turns < AGENT_OVERLOAD_MIN_TURNS) continue;
    const dominance = total > 0 ? r.turns / total : 0;
    if (dominance < AGENT_OVERLOAD_DOMINANCE) continue;
    if (suggestionAlreadyOpen('agent_split', { targetAgentId: r.agentId })) continue;
    if (!isGeminiConfigured()) {
      console.warn('[suggestions] GEMINI_API_KEY missing — skipping agent_split clustering');
      break;
    }
    const cluster = await runAgentSplitClustering(r.agentId, r.turns, median);
    if (!cluster?.is_split_viable || !cluster.split_recommendation) continue;
    const rec = cluster.split_recommendation;
    if (typeof rec.fraction_of_current_work !== 'number' || rec.fraction_of_current_work < MIN_SPLIT_FRACTION) continue;

    const title = `Split ${r.agentId}: spawn '${rec.new_agent_id}' (~${Math.round(rec.fraction_of_current_work * 100)}% of work)`;
    const rationale = `${r.agentId} ran ${r.turns} user turns in 7 days (${Math.round(dominance * 100)}% of all agent-facing work). ${rec.rationale}`;
    const proposed = {
      kind: 'spawn_agent',
      new_agent_id: rec.new_agent_id,
      new_agent_display_name: rec.new_agent_display_name,
      new_agent_description: rec.new_agent_description,
      fraction_of_current_work: rec.fraction_of_current_work,
      from_agent_id: r.agentId,
    };

    const info = db().prepare(`
      INSERT INTO agent_suggestions (suggestion_type, target_agent_id, related_mission_id, title, rationale, proposed_action_json, payload_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('agent_split', r.agentId, null, title, rationale,
      JSON.stringify(proposed),
      JSON.stringify({ turns: r.turns, median, cluster }));
    inserted++;
    audit({ actorType: 'system', action: 'suggestion_inserted', target: String(info.lastInsertRowid), payload: { type: 'agent_split', target_agent: r.agentId, turns: r.turns, median } });
  }
  return inserted;
}

// ─── Detector 2: stale missions ──────────────────────────

function detectStaleMissions(): number {
  const now = nowMs();
  const runningCutoff = now - STALE_RUNNING_DAYS * 86400000;
  const queuedCutoff = now - STALE_QUEUED_DAYS * 86400000;
  const rows = db().prepare(`
    SELECT id, status, agent_id, prompt, created_at, started_at,
      CASE WHEN status='running' THEN (?-COALESCE(started_at, created_at))/86400000
           ELSE (?-created_at)/86400000 END AS daysOpen
    FROM mission_tasks
    WHERE
      (status = 'running' AND COALESCE(started_at, created_at) < ?)
      OR (status = 'queued' AND created_at < ?)
    ORDER BY daysOpen DESC
    LIMIT ?
  `).all(now, now, runningCutoff, queuedCutoff, STALE_INSERTIONS_PER_RUN) as Array<{
    id: number; status: string; agent_id: string; prompt: string;
    created_at: number; started_at: number | null; daysOpen: number;
  }>;

  let inserted = 0;
  for (const m of rows) {
    if (suggestionAlreadyOpen('stale_mission', { relatedMissionId: m.id })) continue;
    const promptSnippet = m.prompt.replace(/\s+/g, ' ').trim().slice(0, 80);
    const days = Math.max(1, Math.floor(m.daysOpen));

    let title: string;
    let rationale: string;
    let proposed: object;
    if (m.status === 'running') {
      title = `Mission #${m.id} stalled for ${days} days`;
      rationale = `"${promptSnippet}" has been in 'running' status for ${days} days. Either complete it, mark as failed with a reason, or cancel.`;
      proposed = { kind: 'file_check_in', check_in_for: 'running', target_mission_id: m.id, suggested_assignee: m.agent_id };
    } else {
      title = `Mission #${m.id} never started (${days} days queued)`;
      rationale = `"${promptSnippet}" was queued ${days} days ago and never moved to 'running'. Either start, reassign, or cancel.`;
      proposed = { kind: 'file_check_in', check_in_for: 'queued', target_mission_id: m.id, suggested_assignee: 'nox' };
    }

    const info = db().prepare(`
      INSERT INTO agent_suggestions (suggestion_type, target_agent_id, related_mission_id, title, rationale, proposed_action_json, payload_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('stale_mission', m.agent_id, m.id, title, rationale,
      JSON.stringify(proposed),
      JSON.stringify({ daysOpen: days, missionStatus: m.status }));
    inserted++;
    audit({ actorType: 'system', action: 'suggestion_inserted', target: String(info.lastInsertRowid), payload: { type: 'stale_mission', mission_id: m.id, days_open: days } });
  }
  return inserted;
}

// ─── Run orchestrator ────────────────────────────────────

export async function runSuggestionsJob(opts: { trigger?: 'scheduled' | 'manual' } = {}): Promise<SuggestionRunResult> {
  const trigger = opts.trigger ?? 'manual';
  const start = Date.now();
  const errors: string[] = [];
  const counts = { agent_split: 0, stale_mission: 0 };

  try { counts.agent_split = await detectAgentOverload(); }
  catch (e) { errors.push(`agent_split: ${e instanceof Error ? e.message : String(e)}`); }

  try { counts.stale_mission = detectStaleMissions(); }
  catch (e) { errors.push(`stale_mission: ${e instanceof Error ? e.message : String(e)}`); }

  const totalInserted = counts.agent_split + counts.stale_mission;
  const durationMs = Date.now() - start;
  const outcome = errors.length === 0 ? 'success' : (totalInserted > 0 ? 'partial' : 'error');

  db().prepare(`INSERT INTO suggestion_runs (trigger, total_inserted, by_type_json, duration_ms, outcome, errors_json) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(trigger, totalInserted, JSON.stringify(counts), durationMs, outcome, errors.length ? JSON.stringify(errors) : null);
  audit({ actorType: 'system', action: 'suggestions_run', payload: { trigger, totalInserted, byType: counts, durationMs, errors } });

  return { totalInserted, byType: counts, durationMs, errors };
}

// ─── Queries ─────────────────────────────────────────────

export function listSuggestions(opts: { includeResolved?: boolean; limit?: number } = {}): Suggestion[] {
  const limit = opts.limit ?? 100;
  const where = opts.includeResolved
    ? ''
    : `WHERE status = 'pending' OR (status = 'snoozed' AND (snooze_until IS NULL OR snooze_until <= ?))`;
  const params: unknown[] = opts.includeResolved ? [] : [nowMs()];
  params.push(limit);
  const rows = db().prepare(`SELECT * FROM agent_suggestions ${where} ORDER BY id DESC LIMIT ?`).all(...params) as Record<string, unknown>[];
  return rows.map(row2suggestion);
}

export function pendingCount(): number {
  const r = db().prepare(`
    SELECT COUNT(*) AS n FROM agent_suggestions
    WHERE status = 'pending' OR (status = 'snoozed' AND snooze_until IS NOT NULL AND snooze_until <= ?)
  `).get(nowMs()) as { n: number };
  return r.n;
}

export function getSuggestion(id: number): Suggestion | null {
  const row = db().prepare(`SELECT * FROM agent_suggestions WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  return row ? row2suggestion(row) : null;
}

export function lastRun(): { ts: number; trigger: string; total_inserted: number; by_type_json: string; duration_ms: number; outcome: string } | null {
  return db().prepare(`SELECT * FROM suggestion_runs ORDER BY id DESC LIMIT 1`).get() as { ts: number; trigger: string; total_inserted: number; by_type_json: string; duration_ms: number; outcome: string } | null;
}

// ─── Lifecycle ────────────────────────────────────────────

export function acceptSuggestion(opts: { id: number; by: string }): { suggestionId: number; filedMissionId: number } {
  const s = getSuggestion(opts.id);
  if (!s) throw new Error(`suggestion ${opts.id} not found`);
  const isActionable = s.status === 'pending' || (s.status === 'snoozed' && (!s.snooze_until || s.snooze_until <= nowMs()));
  if (!isActionable) throw new Error(`suggestion ${opts.id} is in '${s.status}' state and not actionable`);

  const action = s.proposed_action as { kind: string; [k: string]: unknown };
  let prompt: string;
  let agentId: string;

  if (action.kind === 'spawn_agent') {
    agentId = 'nox';
    prompt = [
      `Suggestion #${s.id}: spawn a new specialist agent to take ~${Math.round(((action.fraction_of_current_work as number) ?? 0) * 100)}% of ${action.from_agent_id}'s workload.`,
      ``,
      `New agent id: \`${action.new_agent_id}\``,
      `Display name: ${action.new_agent_display_name}`,
      `Persona: ${action.new_agent_description}`,
      ``,
      `Rationale: ${s.rationale}`,
      ``,
      `Steps Tkiljoy will take: 1) create \`agents/${action.new_agent_id}/agent.yaml\` and \`CLAUDE.md\` (copy from \`agents/_template/\`), 2) restart the server (auto-discovery picks the new agent up), 3) optionally migrate or copy memories from ${action.from_agent_id}.`,
    ].join('\n');
  } else if (action.kind === 'file_check_in') {
    agentId = (action.suggested_assignee as string) ?? 'nox';
    prompt = [
      `Suggestion #${s.id}: check in on stalled mission #${action.target_mission_id}.`,
      ``,
      `${s.rationale}`,
      ``,
      `Action: review the underlying mission, then either complete it (PATCH status='done'), mark failed with a reason, or cancel.`,
    ].join('\n');
  } else {
    throw new Error(`unknown proposed action kind: ${action.kind}`);
  }

  const r = db().prepare(`INSERT INTO mission_tasks (agent_id, prompt, meta_json) VALUES (?, ?, ?)`)
    .run(agentId, prompt, JSON.stringify({ from_suggestion: s.id }));
  const filedMissionId = Number(r.lastInsertRowid);

  db().prepare(`UPDATE agent_suggestions SET status='accepted', status_changed_at=?, status_changed_by=?, filed_mission_id=? WHERE id=?`)
    .run(nowMs(), opts.by, filedMissionId, opts.id);

  audit({ actorType: opts.by.startsWith('agent:') ? 'agent' : 'user', actorId: opts.by, action: 'suggestion_accepted', target: String(opts.id), payload: { filedMissionId, suggestionType: s.suggestion_type } });
  return { suggestionId: opts.id, filedMissionId };
}

export function dismissSuggestion(opts: { id: number; by: string }): void {
  const s = getSuggestion(opts.id);
  if (!s) throw new Error(`suggestion ${opts.id} not found`);
  db().prepare(`UPDATE agent_suggestions SET status='dismissed', status_changed_at=?, status_changed_by=? WHERE id=?`)
    .run(nowMs(), opts.by, opts.id);
  audit({ actorType: opts.by.startsWith('agent:') ? 'agent' : 'user', actorId: opts.by, action: 'suggestion_dismissed', target: String(opts.id), payload: { suggestionType: s.suggestion_type } });
}

export function snoozeSuggestion(opts: { id: number; by: string; days: number }): void {
  const s = getSuggestion(opts.id);
  if (!s) throw new Error(`suggestion ${opts.id} not found`);
  const days = Math.max(1, Math.min(60, Math.round(opts.days)));
  const until = nowMs() + days * 86400000;
  db().prepare(`UPDATE agent_suggestions SET status='snoozed', status_changed_at=?, status_changed_by=?, snooze_until=? WHERE id=?`)
    .run(nowMs(), opts.by, until, opts.id);
  audit({ actorType: opts.by.startsWith('agent:') ? 'agent' : 'user', actorId: opts.by, action: 'suggestion_snoozed', target: String(opts.id), payload: { suggestionType: s.suggestion_type, days, until } });
}
