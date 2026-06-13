import { db, nowMs } from './db.js';
import { audit } from './audit-log.js';
import { loadAgents } from './agent-config.js';
import { runAgent } from './agent.js';

export interface DiscussionThread {
  thread_id: string;
  title: string;
  participants: string[];
  created_at: number;
  last_activity: number;
  meta?: Record<string, unknown> | null;
}

export interface DiscussionTurn {
  id: number;
  thread_id: string;
  turn_index: number;
  agent_id: string | null;
  role: 'user' | 'assistant' | 'system';
  text: string;
  ts: number;
  meta?: Record<string, unknown> | null;
}

function rowToThread(r: Record<string, unknown>): DiscussionThread {
  let participants: string[] = [];
  try { participants = JSON.parse((r.participants_json as string) ?? '[]'); } catch {}
  let meta: Record<string, unknown> | null = null;
  if (r.meta_json) { try { meta = JSON.parse(r.meta_json as string); } catch {} }
  return {
    thread_id: r.thread_id as string,
    title: r.title as string,
    participants,
    created_at: r.created_at as number,
    last_activity: r.last_activity as number,
    meta,
  };
}

function rowToTurn(r: Record<string, unknown>): DiscussionTurn {
  let meta: Record<string, unknown> | null = null;
  if (r.meta_json) { try { meta = JSON.parse(r.meta_json as string); } catch {} }
  return {
    id: r.id as number,
    thread_id: r.thread_id as string,
    turn_index: r.turn_index as number,
    agent_id: (r.agent_id as string) ?? null,
    role: r.role as 'user' | 'assistant' | 'system',
    text: r.text as string,
    ts: r.ts as number,
    meta,
  };
}

export function listDiscussions(limit = 50): DiscussionThread[] {
  const rows = db().prepare(
    `SELECT * FROM team_discussion_threads ORDER BY last_activity DESC LIMIT ?`
  ).all(limit) as Record<string, unknown>[];
  return rows.map(rowToThread);
}

export function getDiscussion(threadId: string): { thread: DiscussionThread; turns: DiscussionTurn[] } | null {
  const t = db().prepare(`SELECT * FROM team_discussion_threads WHERE thread_id = ?`).get(threadId) as Record<string, unknown> | undefined;
  if (!t) return null;
  const turnRows = db().prepare(
    `SELECT * FROM team_discussion_turns WHERE thread_id = ? ORDER BY turn_index ASC, id ASC`
  ).all(threadId) as Record<string, unknown>[];
  return { thread: rowToThread(t), turns: turnRows.map(rowToTurn) };
}

function insertTurn(threadId: string, agentId: string | null, role: 'user' | 'assistant' | 'system', text: string, meta?: Record<string, unknown>): DiscussionTurn {
  const next = db().prepare(`SELECT COALESCE(MAX(turn_index), -1) + 1 AS n FROM team_discussion_turns WHERE thread_id = ?`).get(threadId) as { n: number };
  const ts = nowMs();
  const r = db().prepare(
    `INSERT INTO team_discussion_turns (thread_id, turn_index, agent_id, role, text, ts, meta_json) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(threadId, next.n, agentId, role, text, ts, meta ? JSON.stringify(meta) : null);
  db().prepare(`UPDATE team_discussion_threads SET last_activity = ? WHERE thread_id = ?`).run(ts, threadId);
  return {
    id: Number(r.lastInsertRowid),
    thread_id: threadId,
    turn_index: next.n,
    agent_id: agentId,
    role,
    text,
    ts,
    meta: meta ?? null,
  };
}

function buildHistoryContext(turns: DiscussionTurn[], maxChars = 12_000): string {
  // Render the discussion as a transcript the responding agent can read in
  // its system prompt. Truncates the oldest turns first if the total exceeds
  // maxChars so very long threads don't blow the prompt budget.
  const lines: string[] = [];
  for (const t of turns) {
    const who = t.agent_id ? `@${t.agent_id}` : 'tkiljoy';
    lines.push(`### ${who}\n${t.text}`);
  }
  let block = lines.join('\n\n');
  if (block.length > maxChars) {
    const overflow = block.length - maxChars;
    block = `[...older turns truncated to fit context — ${overflow} chars dropped]\n\n` + block.slice(-maxChars);
  }
  return block;
}

function parseMentions(text: string, validAgents: Set<string>): string[] {
  // Pull @<agentId> mentions from the user's reply. Each mention restricts the
  // turn to that single agent; absence of mentions = all participants speak.
  const out = new Set<string>();
  const re = /@([a-zA-Z0-9_-]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const id = m[1];
    if (validAgents.has(id)) out.add(id);
  }
  return [...out];
}

export interface CreateDiscussionOpts {
  title: string;
  participants: string[];
  openingPrompt: string;
}

export async function createDiscussion(opts: CreateDiscussionOpts): Promise<{ thread: DiscussionThread; turns: DiscussionTurn[] }> {
  const agents = loadAgents();
  const filtered = opts.participants.filter(id => agents.has(id));
  if (filtered.length === 0) {
    throw new Error('at least one valid participant required');
  }
  const threadId = `team-${nowMs()}-${Math.random().toString(36).slice(2, 8)}`;
  db().prepare(
    `INSERT INTO team_discussion_threads (thread_id, title, participants_json) VALUES (?, ?, ?)`
  ).run(threadId, opts.title.slice(0, 200), JSON.stringify(filtered));
  insertTurn(threadId, null, 'user', opts.openingPrompt);
  audit({ actorType: 'user', action: 'team_discussion_created', target: threadId, payload: { participants: filtered, title: opts.title } });
  await fanOut(threadId, filtered);
  return getDiscussion(threadId)!;
}

export interface ReplyOpts {
  threadId: string;
  text: string;
}

export async function replyToDiscussion(opts: ReplyOpts): Promise<{ thread: DiscussionThread; turns: DiscussionTurn[] }> {
  const data = getDiscussion(opts.threadId);
  if (!data) throw new Error(`thread ${opts.threadId} not found`);
  const validAgents = new Set(data.thread.participants);
  insertTurn(opts.threadId, null, 'user', opts.text);
  const mentioned = parseMentions(opts.text, validAgents);
  const targets = mentioned.length > 0 ? mentioned : data.thread.participants;
  await fanOut(opts.threadId, targets);
  return getDiscussion(opts.threadId)!;
}

async function fanOut(threadId: string, targetAgentIds: string[]): Promise<void> {
  const data = getDiscussion(threadId);
  if (!data) return;
  const agents = loadAgents();
  // Run targets in parallel — each agent gets the same transcript snapshot so
  // ordering doesn't change what they see this turn. Cheaper than serial when
  // multiple agents are addressed at once.
  const transcript = buildHistoryContext(data.turns);
  await Promise.all(targetAgentIds.map(async (agentId) => {
    const agent = agents.get(agentId);
    if (!agent) {
      insertTurn(threadId, agentId, 'system', `agent '${agentId}' is not registered`);
      return;
    }
    const userMessage = [
      `# Team discussion`,
      `Title: ${data.thread.title}`,
      `Participants: ${data.thread.participants.map(p => `@${p}`).join(', ')}`,
      `You are: @${agent.id}`,
      ``,
      `## Transcript so far`,
      ``,
      transcript,
      ``,
      `## Your turn`,
      ``,
      `Reply as @${agent.id} to the latest message in the transcript. Stay in your lane (your usual role/expertise). Be concise. If another participant has already covered something, build on it instead of repeating it.`,
    ].join('\n');
    try {
      const result = await runAgent({
        agent,
        userMessage,
        source: 'team-discussion',
        sourceTurn: threadId,
        userTurnRole: 'system',
      });
      insertTurn(threadId, agentId, result.ok ? 'assistant' : 'system', result.text, { kind: 'team_discussion_reply', exitCode: result.exitCode });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      insertTurn(threadId, agentId, 'system', `spawn failed: ${msg}`, { kind: 'team_discussion_error' });
    }
  }));
}
