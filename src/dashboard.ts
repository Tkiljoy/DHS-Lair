import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadAgents } from './agent-config.js';
import { dispatchMessage } from './orchestrator.js';
import { recentAudit } from './audit-log.js';
import { db } from './db.js';
import { snapshotSwitches, getEnv, requireSwitch, SwitchName } from './kill-switches.js';
import { flipSwitch } from './env-writer.js';
import {
  listSuggestions, pendingCount, runSuggestionsJob,
  acceptSuggestion, dismissSuggestion, snoozeSuggestion, lastRun,
} from './suggestions.js';
import { usageReport } from './usage.js';
import {
  listDiscussions, getDiscussion, createDiscussion, replyToDiscussion,
} from './discussions.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');
const ATTACHMENTS_DIR = path.resolve(__dirname, '..', 'store', 'attachments');

const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
};

function saveAttachments(turnId: string, images: Array<{ mimeType: string; data: string; name?: string }>): string[] {
  if (!images || images.length === 0) return [];
  const dir = path.join(ATTACHMENTS_DIR, turnId);
  fs.mkdirSync(dir, { recursive: true });
  const paths: string[] = [];
  images.forEach((img, i) => {
    if (!img?.data || !img?.mimeType) return;
    const ext = MIME_EXT[img.mimeType.toLowerCase()] || 'bin';
    const filename = `${i}.${ext}`;
    const full = path.join(dir, filename);
    fs.writeFileSync(full, Buffer.from(img.data, 'base64'));
    paths.push(full);
  });
  return paths;
}

export async function startDashboard(): Promise<{ port: number; close: () => Promise<void> }> {
  // 32 MiB body limit so chat messages can carry a few base64-encoded
  // screenshots without 413ing. Fastify default is 1 MiB.
  const app = Fastify({ logger: false, bodyLimit: 32 * 1024 * 1024 });
  await app.register(fastifyStatic, { root: PUBLIC_DIR, prefix: '/' });
  // Serve the ogl WebGL library from node_modules so nox-eye.js can `import { Renderer, ... } from '/vendor/ogl/index.js'`.
  const oglSrc = path.resolve(__dirname, '..', 'node_modules', 'ogl', 'src');
  await app.register(fastifyStatic, { root: oglSrc, prefix: '/vendor/ogl/', decorateReply: false });
  // Serve user-uploaded chat attachments so the dashboard can render thumbnails inline.
  fs.mkdirSync(ATTACHMENTS_DIR, { recursive: true });
  await app.register(fastifyStatic, { root: ATTACHMENTS_DIR, prefix: '/attachments/', decorateReply: false });

  app.get('/api/health', async () => ({ ok: true, ts: Date.now(), switches: snapshotSwitches() }));

  // Resolved deployment paths so the dashboard's Settings view can render
  // them without hardcoding env-specific strings on the client.
  app.get('/api/config', async () => ({
    workingDir: process.cwd(),
    dhsVaultPath: process.env.DHS_VAULT_PATH ?? '',
    dhsResourcesPath: process.env.DHS_RESOURCES_PATH ?? '',
    dbPath: process.env.SQLITE_PATH ?? 'store/dhs.db',
  }));

  app.get('/api/usage', async () => usageReport());

  // Manually trigger a memory consolidation pass. Useful after fixing a key
  // or swapping the model — refreshes the Memory Tier health indicator
  // without waiting for the 30-min scheduled run.
  app.post('/api/memory/consolidate', async (req, reply) => {
    try { requireSwitch('DASHBOARD_MUTATIONS_ENABLED'); }
    catch (e: unknown) { reply.code(503); return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
    const { consolidateMemory } = await import('./memory.js');
    const r = await consolidateMemory();
    return { ok: r.ok, result: r };
  });

  // Surface the most recent Gemini call status so the Settings UI can show
  // failed-quota / API-not-enabled errors instead of silently shipping nothing.
  app.get('/api/gemini/health', async () => {
    const memRow = db().prepare(`
      SELECT last_run_at AS ts, ok, error, rows_examined AS rows, rows_inserted AS inserted
      FROM memory_consolidations ORDER BY id DESC LIMIT 1
    `).get() as { ts: number; ok: number; error: string | null; rows: number; inserted: number } | undefined;
    const sugRow = db().prepare(`
      SELECT ts, outcome, errors_json AS errors
      FROM suggestion_runs ORDER BY id DESC LIMIT 1
    `).get() as { ts: number; outcome: string; errors: string | null } | undefined;
    // Recent successful Gemini call across ALL categories (memory consolidation,
    // suggestion clustering, future ones). If one happened in the last hour we
    // can confidently report healthy even if the per-category tracker is stale.
    const recentOk = db().prepare(`
      SELECT ts, model, category FROM usage_log
      WHERE source = 'gemini' AND ts > ?
      ORDER BY ts DESC LIMIT 1
    `).get(Date.now() - 60 * 60 * 1000) as { ts: number; model: string; category: string | null } | undefined;
    return {
      configured: !!getEnv('GEMINI_API_KEY'),
      model: getEnv('GEMINI_MODEL', 'gemini-2.5-flash-lite'),
      recentOk: recentOk ? { ts: recentOk.ts, model: recentOk.model, category: recentOk.category } : null,
      lastConsolidation: memRow ? {
        ts: memRow.ts,
        ok: !!memRow.ok,
        error: memRow.error ? memRow.error.slice(0, 600) : null,
        rowsExamined: memRow.rows,
        rowsInserted: memRow.inserted,
      } : null,
      lastSuggestionRun: sugRow ? {
        ts: sugRow.ts,
        outcome: sugRow.outcome,
        errors: sugRow.errors ? (() => { try { return JSON.parse(sugRow.errors!); } catch { return [sugRow.errors!.slice(0,600)]; } })() : [],
      } : null,
    };
  });

  // ─── Models ─────────────────────────────────────────────
  const CLAUDE_MODELS = [
    { id: 'claude-opus-4-7',           label: 'Opus 4.7',   note: 'Highest reasoning. Slower, more expensive.' },
    { id: 'claude-sonnet-4-6',         label: 'Sonnet 4.6', note: 'Balanced. Fast and cost-effective.' },
    { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5',  note: 'Fastest, cheapest. Good for simple turns.' },
  ];
  const GEMINI_MODELS = [
    { id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash-Lite', note: '$0.10/$0.40 per Mtok. Recommended default — works on AI Studio free tier where 2.0 family has limit=0.' },
    { id: 'gemini-2.5-flash',      label: 'Gemini 2.5 Flash',      note: '$0.30/$2.50 per Mtok. Smarter than Flash-Lite.' },
    { id: 'gemini-2.5-pro',        label: 'Gemini 2.5 Pro',        note: '$1.25/$5.00 per Mtok. Most capable.' },
    { id: 'gemini-2.0-flash',      label: 'Gemini 2.0 Flash',      note: '$0.10/$0.40 per Mtok. May be quota=0 on free tier.' },
    { id: 'gemini-2.0-flash-lite', label: 'Gemini 2.0 Flash-Lite', note: '$0.075/$0.30 per Mtok. May be quota=0 on free tier.' },
    { id: 'gemini-1.5-flash',      label: 'Gemini 1.5 Flash',      note: 'Legacy. $0.075/$0.30 per Mtok.' },
    { id: 'gemini-1.5-pro',        label: 'Gemini 1.5 Pro',        note: 'Legacy. $1.25/$5.00 per Mtok.' },
  ];

  app.get('/api/models', async () => {
    const agents = [...loadAgents().values()].map(a => ({
      id: a.id,
      display_name: a.display_name,
      configuredModel: a.cwd ? null : null, // (placeholder, see below)
    }));
    // Re-compute "configuredModel" properly: the resolveCwd-cached agents
    // already have model resolved against the env fallback. We want to
    // surface the *raw* per-agent override (whatever's in their yaml's
    // model: field) so the UI can show "NOX: opus override".
    const fs = await import('node:fs');
    const path = await import('node:path');
    const YAML = (await import('yaml')).default;
    const __dirname = path.dirname(new URL(import.meta.url).pathname).replace(/^\/(\w):/, '$1:');
    const agentsDir = path.resolve(__dirname, '..', 'agents');
    const agentRows = [...loadAgents().values()].map(a => {
      let raw = null;
      try {
        const yamlText = fs.readFileSync(path.join(agentsDir, a.id, 'agent.yaml'), 'utf8');
        const parsed = YAML.parse(yamlText);
        raw = typeof parsed?.model === 'string' ? parsed.model : null;
      } catch {}
      return { id: a.id, display_name: a.display_name, override: raw };
    });
    return {
      claude: {
        options: CLAUDE_MODELS,
        defaultModel: getEnv('DEFAULT_AGENT_MODEL', 'claude-sonnet-4-6'),
      },
      gemini: {
        options: GEMINI_MODELS,
        currentModel: getEnv('GEMINI_MODEL', 'gemini-2.0-flash'),
      },
      agents: agentRows,
    };
  });

  app.post('/api/models', async (req, reply) => {
    try { requireSwitch('DASHBOARD_MUTATIONS_ENABLED'); }
    catch (e: unknown) { reply.code(503); return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
    const body = req.body as {
      defaultClaude?: string;
      gemini?: string;
      agentModels?: Record<string, string | null>;
    };
    const validClaude = new Set(CLAUDE_MODELS.map(m => m.id));
    const validGemini = new Set(GEMINI_MODELS.map(m => m.id));
    if (body.defaultClaude && !validClaude.has(body.defaultClaude)) {
      reply.code(400);
      return { ok: false, error: `Unknown Claude model '${body.defaultClaude}'.` };
    }
    if (body.gemini && !validGemini.has(body.gemini)) {
      reply.code(400);
      return { ok: false, error: `Unknown Gemini model '${body.gemini}'.` };
    }
    if (body.agentModels && typeof body.agentModels === 'object') {
      const knownAgents = new Set([...loadAgents().keys()]);
      for (const [agentId, model] of Object.entries(body.agentModels)) {
        if (!knownAgents.has(agentId)) {
          reply.code(400);
          return { ok: false, error: `Unknown agent '${agentId}'.` };
        }
        if (model !== null && model !== '' && !validClaude.has(model)) {
          reply.code(400);
          return { ok: false, error: `Unknown Claude model '${model}' for agent '${agentId}'.` };
        }
      }
    }
    const { setEnvKey } = await import('./env-writer.js');
    if (body.defaultClaude) setEnvKey('DEFAULT_AGENT_MODEL', body.defaultClaude);
    if (body.gemini) setEnvKey('GEMINI_MODEL', body.gemini);
    if (body.agentModels && typeof body.agentModels === 'object') {
      const { setAgentModel } = await import('./yaml-writer.js');
      for (const [agentId, model] of Object.entries(body.agentModels)) {
        setAgentModel(agentId, model && model !== '' ? model : null);
      }
      // Bust the agent-config cache and re-sync DB so subsequent spawns pick the new model up immediately.
      const { loadAgents: reload, syncAgentsToDb } = await import('./agent-config.js');
      reload(true);
      syncAgentsToDb();
    }
    return {
      ok: true,
      defaultClaude: getEnv('DEFAULT_AGENT_MODEL', 'claude-sonnet-4-6'),
      gemini: getEnv('GEMINI_MODEL', 'gemini-2.0-flash'),
    };
  });

  app.get('/api/agents', async () => {
    const agents = [...loadAgents().values()].map(a => ({
      id: a.id,
      display_name: a.display_name,
      description: a.description,
      model: a.model,
      cwd: a.cwd,
      warroom: a.warroom,
    }));
    return { agents };
  });

  app.get('/api/audit-log', async (req) => {
    const limit = Math.min(500, Math.max(1, Number((req.query as Record<string, string>).limit ?? 100)));
    return { entries: recentAudit(limit) };
  });

  app.get('/api/hive-mind', async () => {
    const rows = db().prepare(`SELECT * FROM hive_mind_log ORDER BY ts DESC LIMIT 200`).all();
    return { entries: rows };
  });

  app.get('/api/missions', async (req) => {
    const status = (req.query as { status?: string }).status;
    const rows = status
      ? db().prepare(`SELECT * FROM mission_tasks WHERE status = ? ORDER BY created_at DESC LIMIT 200`).all(status)
      : db().prepare(`SELECT * FROM mission_tasks ORDER BY created_at DESC LIMIT 200`).all();
    return { missions: rows };
  });

  app.post('/api/missions', async (req, reply) => {
    try { requireSwitch('DASHBOARD_MUTATIONS_ENABLED'); }
    catch (e: unknown) { reply.code(503); return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
    const body = req.body as { agent_id?: string; prompt?: string; meta?: Record<string, unknown>; watch?: boolean };
    if (!body?.agent_id || !body?.prompt) {
      reply.code(400);
      return { ok: false, error: 'agent_id and prompt required' };
    }
    // Merge top-level `watch` into meta_json so the worker can find it consistently.
    const meta = (body.meta && typeof body.meta === 'object' ? { ...body.meta } : {}) as Record<string, unknown>;
    if (body.watch === true) meta.watch = true;
    const metaJson = Object.keys(meta).length > 0 ? JSON.stringify(meta) : null;
    const r = db().prepare(`INSERT INTO mission_tasks (agent_id, prompt, meta_json) VALUES (?, ?, ?)`)
      .run(body.agent_id, body.prompt, metaJson);
    return { ok: true, id: Number(r.lastInsertRowid) };
  });

  // Unread NØX assistant messages since `since` (ms). Used by the Eye badge.
  app.get('/api/nox/unread', async (req) => {
    const sinceRaw = (req.query as { since?: string }).since;
    const since = Number(sinceRaw);
    const ts = Number.isFinite(since) ? since : Date.now();
    const row = db().prepare(`
      SELECT COUNT(*) AS n, MAX(ts) AS latest
      FROM conversation_log
      WHERE agent_id = 'nox'
        AND role = 'assistant'
        AND ts > ?
        AND (source IS NULL OR source != 'warroom')
    `).get(ts) as { n: number; latest: number | null };
    return { count: row.n ?? 0, latestTs: row.latest ?? null };
  });

  app.patch('/api/missions/:id', async (req, reply) => {
    try { requireSwitch('DASHBOARD_MUTATIONS_ENABLED'); }
    catch (e: unknown) { reply.code(503); return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
    const id = Number((req.params as { id: string }).id);
    const body = req.body as { status?: string };
    const VALID = ['queued','running','done','failed','cancelled'];
    if (!body?.status || !VALID.includes(body.status)) {
      reply.code(400);
      return { ok: false, error: 'invalid status' };
    }
    const finished = (body.status === 'done' || body.status === 'failed' || body.status === 'cancelled') ? Date.now() : null;
    db().prepare(`UPDATE mission_tasks SET status = ?, finished_at = COALESCE(?, finished_at) WHERE id = ?`).run(body.status, finished, id);
    return { ok: true };
  });

  // ─── Suggestions ─────────────────────────────────────────
  app.get('/api/suggestions', async (req) => {
    const includeResolved = (req.query as { include?: string }).include === 'all';
    return {
      suggestions: listSuggestions({ includeResolved }),
      pending: pendingCount(),
      lastRun: lastRun(),
    };
  });

  app.get('/api/suggestions/count', async () => ({ pending: pendingCount() }));

  app.post('/api/suggestions/run', async (req, reply) => {
    try { requireSwitch('DASHBOARD_MUTATIONS_ENABLED'); }
    catch (e: unknown) { reply.code(503); return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
    const result = await runSuggestionsJob({ trigger: 'manual' });
    return { ok: true, result };
  });

  app.post('/api/suggestions/:id/accept', async (req, reply) => {
    try { requireSwitch('DASHBOARD_MUTATIONS_ENABLED'); }
    catch (e: unknown) { reply.code(503); return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
    const id = Number((req.params as { id: string }).id);
    try {
      const r = acceptSuggestion({ id, by: 'user:dashboard' });
      return { ok: true, ...r };
    } catch (e: unknown) {
      reply.code(400);
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  app.post('/api/suggestions/:id/dismiss', async (req, reply) => {
    try { requireSwitch('DASHBOARD_MUTATIONS_ENABLED'); }
    catch (e: unknown) { reply.code(503); return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
    const id = Number((req.params as { id: string }).id);
    try {
      dismissSuggestion({ id, by: 'user:dashboard' });
      return { ok: true };
    } catch (e: unknown) {
      reply.code(400);
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  app.post('/api/suggestions/:id/snooze', async (req, reply) => {
    try { requireSwitch('DASHBOARD_MUTATIONS_ENABLED'); }
    catch (e: unknown) { reply.code(503); return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
    const id = Number((req.params as { id: string }).id);
    const days = Number((req.body as { days?: number })?.days ?? 7);
    try {
      snoozeSuggestion({ id, by: 'user:dashboard', days });
      return { ok: true };
    } catch (e: unknown) {
      reply.code(400);
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  app.get('/api/warroom/transcripts', async () => {
    const meetings = db().prepare(`
      SELECT meeting_id, command, MIN(ts) AS started, MAX(ts) AS ended, COUNT(*) AS entries
      FROM warroom_transcript
      GROUP BY meeting_id
      ORDER BY started DESC LIMIT 50
    `).all();
    return { meetings };
  });

  app.get('/api/warroom/transcripts/:meetingId', async (req) => {
    const id = (req.params as { meetingId: string }).meetingId;
    const entries = db().prepare(`SELECT * FROM warroom_transcript WHERE meeting_id = ? ORDER BY ts ASC`).all(id);
    return { entries };
  });

  app.post('/api/message', async (req, reply) => {
    try {
      requireSwitch('DASHBOARD_MUTATIONS_ENABLED');
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      reply.code(503);
      return { ok: false, error: msg };
    }
    const body = req.body as {
      text?: string;
      agent?: string;
      images?: Array<{ mimeType: string; data: string; name?: string }>;
    };
    const hasImages = Array.isArray(body?.images) && body!.images!.length > 0;
    if (!body?.text && !hasImages) {
      reply.code(400);
      return { ok: false, error: 'text or images required' };
    }
    let attachments: string[] | undefined;
    if (hasImages) {
      const turnId = `chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      attachments = saveAttachments(turnId, body!.images!);
    }
    const replies = await dispatchMessage({
      text: body.text || '(image attached)',
      agentTarget: body.agent,
      source: 'dashboard',
      attachments,
    });
    return { ok: true, replies };
  });

  app.post('/api/chat/mark-block-consumed', async (req, reply) => {
    try {
      requireSwitch('DASHBOARD_MUTATIONS_ENABLED');
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      reply.code(503);
      return { ok: false, error: msg };
    }
    const body = req.body as {
      messageId?: number;
      blockKind?: 'ask' | 'mission';
      blockIdx?: number;
      missionId?: number;
    };
    const { messageId, blockKind, blockIdx } = body;
    if (typeof messageId !== 'number' || (blockKind !== 'ask' && blockKind !== 'mission') || typeof blockIdx !== 'number') {
      reply.code(400);
      return { ok: false, error: 'messageId (number), blockKind (ask|mission), blockIdx (number) required' };
    }
    const row = db().prepare('SELECT meta_json FROM conversation_log WHERE id = ?').get(messageId) as { meta_json: string | null } | undefined;
    if (!row) {
      reply.code(404);
      return { ok: false, error: 'message not found' };
    }
    let meta: Record<string, unknown> = {};
    if (row.meta_json) {
      try { meta = (JSON.parse(row.meta_json) as Record<string, unknown>) ?? {}; } catch { meta = {}; }
    }
    const consumed = Array.isArray(meta.consumed_blocks)
      ? (meta.consumed_blocks as Array<Record<string, unknown>>)
      : [];
    const exists = consumed.some(c => c.kind === blockKind && c.idx === blockIdx);
    if (!exists) {
      const entry: Record<string, unknown> = { kind: blockKind, idx: blockIdx };
      if (blockKind === 'mission' && typeof body.missionId === 'number') entry.missionId = body.missionId;
      consumed.push(entry);
      meta.consumed_blocks = consumed;
      db().prepare('UPDATE conversation_log SET meta_json = ? WHERE id = ?').run(JSON.stringify(meta), messageId);
    }
    return { ok: true };
  });

  app.post('/api/switch', async (req, reply) => {
    const body = req.body as { name?: string; value?: boolean };
    const VALID: SwitchName[] = [
      'LLM_SPAWN_ENABLED',
      'WARROOM_TEXT_ENABLED',
      'WARROOM_VOICE_ENABLED',
      'DASHBOARD_MUTATIONS_ENABLED',
      'MISSION_AUTO_ASSIGN_ENABLED',
      'SCHEDULER_ENABLED',
    ];
    if (!body?.name || typeof body.value !== 'boolean' || !VALID.includes(body.name as SwitchName)) {
      reply.code(400);
      return { ok: false, error: 'invalid switch name or value' };
    }
    // Lockout guard: refuse to disable DASHBOARD_MUTATIONS_ENABLED via dashboard.
    if (body.name === 'DASHBOARD_MUTATIONS_ENABLED' && body.value === false) {
      reply.code(403);
      return { ok: false, error: 'DASHBOARD_MUTATIONS_ENABLED can only be disabled by editing .env directly (lockout protection).' };
    }
    flipSwitch(body.name, body.value, { actorType: 'user' });
    return { ok: true, switches: snapshotSwitches() };
  });

  // ─── Team discussions ───────────────────────────────────
  app.get('/api/discussions', async () => {
    return { threads: listDiscussions(50) };
  });

  app.get('/api/discussions/:threadId', async (req, reply) => {
    const threadId = (req.params as { threadId: string }).threadId;
    const data = getDiscussion(threadId);
    if (!data) {
      reply.code(404);
      return { ok: false, error: 'thread not found' };
    }
    return { ok: true, ...data };
  });

  app.post('/api/discussions', async (req, reply) => {
    try { requireSwitch('DASHBOARD_MUTATIONS_ENABLED'); }
    catch (e: unknown) { reply.code(503); return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
    const body = req.body as { title?: string; participants?: string[]; openingPrompt?: string };
    if (!body?.title || !Array.isArray(body?.participants) || body.participants.length === 0 || !body?.openingPrompt) {
      reply.code(400);
      return { ok: false, error: 'title, participants (non-empty array), openingPrompt required' };
    }
    try {
      const data = await createDiscussion({
        title: body.title,
        participants: body.participants,
        openingPrompt: body.openingPrompt,
      });
      return { ok: true, ...data };
    } catch (e: unknown) {
      reply.code(400);
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  app.post('/api/discussions/:threadId/reply', async (req, reply) => {
    try { requireSwitch('DASHBOARD_MUTATIONS_ENABLED'); }
    catch (e: unknown) { reply.code(503); return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
    const threadId = (req.params as { threadId: string }).threadId;
    const body = req.body as { text?: string };
    if (!body?.text || !body.text.trim()) {
      reply.code(400);
      return { ok: false, error: 'text required' };
    }
    try {
      const data = await replyToDiscussion({ threadId, text: body.text });
      return { ok: true, ...data };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      reply.code(msg.includes('not found') ? 404 : 400);
      return { ok: false, error: msg };
    }
  });

  app.get('/api/conversation/:agentId', async (req) => {
    const agentId = (req.params as { agentId: string }).agentId;
    const q = req.query as { since?: string };
    const sinceMs = q?.since ? Number(q.since) : 0;
    const rows = db().prepare(`
      SELECT id, ts, role, text, source, meta_json FROM conversation_log
      WHERE agent_id = ?
        AND (source IS NULL OR source != 'warroom')
        AND ts > ?
      ORDER BY ts DESC LIMIT 200
    `).all(agentId, Number.isFinite(sinceMs) ? sinceMs : 0) as Array<{
      id: number; ts: number; role: string; text: string; source: string | null; meta_json: string | null;
    }>;
    const entries = rows.reverse().map(r => {
      let meta: Record<string, unknown> | null = null;
      if (r.meta_json) {
        try { meta = JSON.parse(r.meta_json); } catch { meta = null; }
      }
      return { id: r.id, ts: r.ts, role: r.role, text: r.text, source: r.source, meta };
    });
    return { entries };
  });

  const port = Number(getEnv('DASHBOARD_PORT', '7777'));
  const host = getEnv('DASHBOARD_BIND', '127.0.0.1') ?? '127.0.0.1';
  await app.listen({ port, host });
  return { port, close: () => app.close() };
}
