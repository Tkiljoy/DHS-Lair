// Background mission worker. Polls mission_tasks for status='queued',
// claims one at a time, spawns the assigned agent, records the result.
//
// Respects:
//   - SCHEDULER_ENABLED kill switch (gates the polling loop)
//   - LLM_SPAWN_ENABLED kill switch (the agent spawner enforces this anyway)
//   - Concurrency limit (1 mission at a time globally for v1)

import { db, nowMs } from './db.js';
import { runAgent } from './agent.js';
import { loadAgents } from './agent-config.js';
import { audit } from './audit-log.js';
import { getSwitch } from './kill-switches.js';

const POLL_INTERVAL_MS = 5000;
const MAX_CONCURRENT = 1;

let running = 0;
let pollingNow = false;
let pollHandle: NodeJS.Timeout | null = null;

interface MissionRow {
  id: number;
  created_at: number;
  agent_id: string;
  status: string;
  prompt: string;
  result: string | null;
  started_at: number | null;
  finished_at: number | null;
  meta_json: string | null;
}

export function startMissionWorker(): void {
  if (pollHandle) return;
  console.log(`[mission-worker] polling every ${POLL_INTERVAL_MS / 1000}s, concurrency=${MAX_CONCURRENT}`);
  pollHandle = setInterval(() => { void tick(); }, POLL_INTERVAL_MS);
  // Also tick immediately on boot so a queued mission from a prior session fires fast.
  void tick();
}

export function stopMissionWorker(): void {
  if (pollHandle) {
    clearInterval(pollHandle);
    pollHandle = null;
  }
}

async function tick(): Promise<void> {
  if (pollingNow) return;
  if (!getSwitch('SCHEDULER_ENABLED')) return;
  if (!getSwitch('LLM_SPAWN_ENABLED')) return;
  if (running >= MAX_CONCURRENT) return;

  pollingNow = true;
  try {
    const next = db().prepare(`
      SELECT * FROM mission_tasks
      WHERE status = 'queued'
      ORDER BY created_at ASC
      LIMIT 1
    `).get() as MissionRow | undefined;
    if (!next) return;

    // Claim atomically — refuse if someone else already claimed it.
    const claimed = db().prepare(`
      UPDATE mission_tasks SET status = 'running', started_at = ?
      WHERE id = ? AND status = 'queued'
    `).run(nowMs(), next.id);
    if (claimed.changes === 0) return;

    running++;
    audit({
      actorType: 'scheduler',
      action: 'message_in',
      target: `mission:${next.id}`,
      payload: { agent_id: next.agent_id, prompt_len: next.prompt.length },
    });

    // Fire-and-forget. Don't block the poller; the next tick will spawn another
    // mission only if running < MAX_CONCURRENT.
    void executeMission(next).catch(err => {
      console.error(`[mission-worker] execute failed for #${next.id}:`, err);
    }).finally(() => { running--; });
  } finally {
    pollingNow = false;
  }
}

function isWatched(mission: MissionRow): boolean {
  if (!mission.meta_json) return false;
  try {
    const meta = JSON.parse(mission.meta_json);
    return meta && typeof meta === 'object' && meta.watch === true;
  } catch { return false; }
}

async function runFollowUp(mission: MissionRow, finalStatus: 'done' | 'failed', resultText: string): Promise<void> {
  const noxAgent = loadAgents().get('nox');
  if (!noxAgent) {
    console.warn(`[mission-worker] follow-up skipped for #${mission.id}: NØX not registered`);
    return;
  }
  const truncatedPrompt = mission.prompt.length > 800 ? mission.prompt.slice(0, 800) + '\n[…truncated]' : mission.prompt;
  const truncatedResult = (resultText ?? '').length > 4000 ? resultText.slice(0, 4000) + '\n[…truncated]' : (resultText ?? '');
  const followUpPrompt = [
    `Mission #${mission.id} just completed (status: ${finalStatus}).`,
    `Assigned to: @${mission.agent_id}`,
    ``,
    `Original prompt:`,
    truncatedPrompt,
    ``,
    `Result:`,
    truncatedResult,
    ``,
    `Compose a brief 2-3 sentence follow-up for Tkiljoy: what's done, any obvious next step. Match the energy of the original ask. End with the structured \`ask\` block ONLY if the result genuinely opens 2-4 distinct branches Tkiljoy needs to choose between. Otherwise no ask block. Do NOT pad.`,
  ].join('\n');

  const followUp = await runAgent({
    agent: noxAgent,
    userMessage: followUpPrompt,
    source: 'mission-followup',
    sourceTurn: `mission-${mission.id}-followup`,
    userTurnRole: 'system',
  });

  audit({
    actorType: 'scheduler',
    action: 'agent_response',
    target: `mission:${mission.id}`,
    payload: { ok: followUp.ok, kind: 'mission_followup', missionId: mission.id, finalStatus },
  });

  db().prepare(`INSERT INTO hive_mind_log (agent_id, event, summary) VALUES (?, ?, ?)`)
    .run('nox', 'mission_followup', `Mission #${mission.id} (${finalStatus}) - follow-up posted to NØX chat`);
}

async function executeMission(mission: MissionRow): Promise<void> {
  const agents = loadAgents();
  const agent = agents.get(mission.agent_id);

  if (!agent) {
    const errorMsg = `Agent '${mission.agent_id}' is not registered. Mission cannot run.`;
    db().prepare(`
      UPDATE mission_tasks SET status = 'failed', result = ?, finished_at = ?
      WHERE id = ?
    `).run(errorMsg, nowMs(), mission.id);
    audit({
      actorType: 'scheduler',
      action: 'agent_response',
      target: `mission:${mission.id}`,
      payload: { ok: false, error: errorMsg, kind: 'mission_completed' },
    });
    return;
  }

  // Parse cwdVars from meta if any (e.g. {project: "DHS-Fishing"} for /assign-style missions).
  let cwdVars: Record<string, string> = {};
  if (mission.meta_json) {
    try {
      const meta = JSON.parse(mission.meta_json);
      if (meta && typeof meta === 'object' && meta.cwd_vars && typeof meta.cwd_vars === 'object') {
        cwdVars = meta.cwd_vars as Record<string, string>;
      }
    } catch {}
  }

  try {
    const result = await runAgent({
      agent,
      userMessage: mission.prompt,
      source: 'scheduled',
      sourceTurn: `mission-${mission.id}`,
      cwdVars,
      userTurnRole: 'system',
    });

    const finalStatus: 'done' | 'failed' = result.ok ? 'done' : 'failed';
    db().prepare(`
      UPDATE mission_tasks SET status = ?, result = ?, finished_at = ?
      WHERE id = ?
    `).run(finalStatus, result.text, nowMs(), mission.id);
    audit({
      actorType: 'scheduler',
      action: 'agent_response',
      target: `mission:${mission.id}`,
      payload: { ok: result.ok, durationMs: result.durationMs, kind: 'mission_completed' },
    });
    // If the mission was filed with meta.watch=true, spawn NØX with the
    // result so he can compose a follow-up message that lands in his
    // chat panel. Fire-and-forget; failures here are logged, not retried.
    if (isWatched(mission)) {
      void runFollowUp(mission, finalStatus, result.text).catch(err => {
        console.error(`[mission-worker] follow-up failed for #${mission.id}:`, err);
      });
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    db().prepare(`
      UPDATE mission_tasks SET status = 'failed', result = ?, finished_at = ?
      WHERE id = ?
    `).run(`Worker error: ${errorMsg}`, nowMs(), mission.id);
    audit({
      actorType: 'scheduler',
      action: 'agent_response',
      target: `mission:${mission.id}`,
      payload: { ok: false, error: errorMsg, kind: 'mission_completed' },
    });
  }
}
