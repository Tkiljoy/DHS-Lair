import { loadAgents, AgentConfig } from './agent-config.js';
import { runAgent, SpawnResult } from './agent.js';
import { audit } from './audit-log.js';
import { db, nowMs } from './db.js';
import { getSwitch, requireSwitch } from './kill-switches.js';

export interface IncomingMessage {
  text: string;
  agentTarget?: string;     // explicit @-mention or selector from dashboard
  source: 'dashboard' | 'warroom' | 'scheduled';
  /** Absolute paths of image files attached for this turn. */
  attachments?: string[];
}

export interface OrchestratorReply {
  agent: string;
  text: string;
  ok: boolean;
  meta?: Record<string, unknown>;
}

function parseExplicitTarget(text: string): { target?: string; rest: string } {
  const m = text.match(/^@([a-zA-Z0-9_-]+)\s+(.*)$/s);
  if (m) return { target: m[1], rest: m[2] };
  return { rest: text };
}

function parseAssign(text: string): { project: string; task: string } | null {
  // /assign <project> <task...>
  const m = text.match(/^\/assign\s+(\S+)\s+(.+)$/s);
  if (!m) return null;
  return { project: m[1], task: m[2] };
}

function parseReview(text: string): { project: string } | null {
  const m = text.match(/^\/review\s+(\S+)\s*$/s);
  if (!m) return null;
  return { project: m[1] };
}

export async function dispatchMessage(msg: IncomingMessage): Promise<OrchestratorReply[]> {
  audit({ actorType: 'user', action: 'message_in', target: msg.agentTarget, payload: { source: msg.source, length: msg.text.length } });

  // War room slash commands
  if (msg.text.startsWith('/standup')) {
    return runStandup(msg.source);
  }
  if (msg.text.startsWith('/discuss')) {
    const rest = msg.text.replace(/^\/discuss\s*/, '').trim();
    return runDiscuss(rest, msg.source);
  }

  const agents = loadAgents();
  let target = msg.agentTarget;
  let body = msg.text;
  if (!target) {
    const parsed = parseExplicitTarget(msg.text);
    target = parsed.target;
    body = parsed.rest;
  }

  // /assign and /review go to dev/review respectively.
  const assign = parseAssign(body);
  if (assign) {
    target = target ?? 'dev';
    body = `Project: ${assign.project}\nTask: ${assign.task}\n\nFollow your DHS Resources skill to cd into the project folder, then delegate to the appropriate user-scope agent (forge-master / forge-apprentice / quartermaster / project-architect / ui-architect). After the implementation, call test-marshal for a QA test plan and chronicler for a changelog entry. Return a summary, the diff, and the test plan.`;
  }
  const review = parseReview(body);
  if (review) {
    target = target ?? 'review';
    body = `Run a review pass on project: ${review.project}\n\nDelegate sequentially to forge-inspector (best-practice + pipeline compliance), bridge-master (Community Bridge integration), and asset-librarian (duplicate detection vs studio_library). Aggregate the findings into a single report: pass/fail per pass, blocking issues, risk notes, suggested fixes. Do NOT fix issues — that is dev's job.`;
  }

  const agentId = target ?? 'nox';
  const agent = agents.get(agentId);
  if (!agent) {
    return [{ agent: agentId, text: `agent '${agentId}' is not registered`, ok: false }];
  }

  const cwdVars: Record<string, string> = {};
  if (assign) cwdVars.project = assign.project;
  if (review) cwdVars.project = review.project;

  const result = await runAgent({
    agent,
    userMessage: body,
    source: msg.source,
    cwdVars,
    attachments: msg.attachments,
  });

  audit({ actorType: 'agent', actorId: agent.id, action: 'message_out', payload: { ok: result.ok, length: result.text.length, source: msg.source } });
  return [{ agent: agent.id, text: result.text, ok: result.ok, meta: { durationMs: result.durationMs, exitCode: result.exitCode } }];
}

async function runStandup(source: IncomingMessage['source']): Promise<OrchestratorReply[]> {
  if (!getSwitch('WARROOM_TEXT_ENABLED')) {
    return [{ agent: 'system', text: 'WARROOM_TEXT_ENABLED is false. War room refused.', ok: false }];
  }
  const meetingId = `standup-${nowMs()}`;
  const agents = [...loadAgents().values()].filter(a => a.warroom !== false);
  const replies: OrchestratorReply[] = [];

  audit({ actorType: 'user', action: 'warroom_meeting', target: meetingId, payload: { command: 'standup', participants: agents.map(a => a.id) } });

  for (const a of agents) {
    const prompt = `Quick standup status. 2-3 sentences max. Cover: what you wrapped, what's queued, any blockers. Speak in first person.`;
    db().prepare(`INSERT INTO warroom_transcript (meeting_id, command, agent_id, role, text) VALUES (?, ?, ?, ?, ?)`)
      .run(meetingId, 'standup', a.id, 'prompt', prompt);
    const result = await runAgent({ agent: a, userMessage: prompt, source: 'warroom', sourceTurn: meetingId, toolsOverride: a.warroom_tools ?? [] });
    db().prepare(`INSERT INTO warroom_transcript (meeting_id, command, agent_id, role, text) VALUES (?, ?, ?, ?, ?)`)
      .run(meetingId, 'standup', a.id, 'response', result.text);
    replies.push({ agent: a.id, text: result.text, ok: result.ok });
  }
  return replies;
}

async function runDiscuss(question: string, source: IncomingMessage['source']): Promise<OrchestratorReply[]> {
  if (!getSwitch('WARROOM_TEXT_ENABLED')) {
    return [{ agent: 'system', text: 'WARROOM_TEXT_ENABLED is false. War room refused.', ok: false }];
  }
  if (!question) {
    return [{ agent: 'system', text: 'Usage: /discuss <question>', ok: false }];
  }
  const meetingId = `discuss-${nowMs()}`;
  const agentsAll = [...loadAgents().values()];
  const participants = agentsAll.filter(a => a.id !== 'nox' && a.warroom !== false);
  const consolidator = agentsAll.find(a => a.id === 'nox');
  const replies: OrchestratorReply[] = [];

  audit({ actorType: 'user', action: 'warroom_meeting', target: meetingId, payload: { command: 'discuss', question, participants: participants.map(a => a.id) } });

  for (const a of participants) {
    const prompt = `The user just asked: ${question}\n\nFrom your perspective and based on what you have access to, give your take in 3-5 sentences.`;
    db().prepare(`INSERT INTO warroom_transcript (meeting_id, command, agent_id, role, text) VALUES (?, ?, ?, ?, ?)`)
      .run(meetingId, 'discuss', a.id, 'prompt', prompt);
    const result = await runAgent({ agent: a, userMessage: prompt, source: 'warroom', sourceTurn: meetingId, toolsOverride: a.warroom_tools ?? [] });
    db().prepare(`INSERT INTO warroom_transcript (meeting_id, command, agent_id, role, text) VALUES (?, ?, ?, ?, ?)`)
      .run(meetingId, 'discuss', a.id, 'response', result.text);
    replies.push({ agent: a.id, text: result.text, ok: result.ok });
  }

  if (consolidator) {
    const consolidationInput = replies.map(r => `### ${r.agent}\n${r.text}`).join('\n\n');
    const prompt = `The user asked: ${question}\n\nThe following agents weighed in:\n\n${consolidationInput}\n\nBased on the above, what's the recommendation? Be decisive. 4-6 sentences.\n\nIf the team's input converges on a concrete next-action that should become a mission_tasks row, end your response with a structured \`mission\` block (per the top-level CLAUDE.md spec). Otherwise omit it.`;
    const result = await runAgent({ agent: consolidator, userMessage: prompt, source: 'warroom', sourceTurn: meetingId, toolsOverride: consolidator.warroom_tools ?? [] });
    db().prepare(`INSERT INTO warroom_transcript (meeting_id, command, agent_id, role, text) VALUES (?, ?, ?, ?, ?)`)
      .run(meetingId, 'discuss', 'nox', 'consolidator', result.text);
    replies.push({ agent: 'nox (consolidator)', text: result.text, ok: result.ok });
  }
  return replies;
}
