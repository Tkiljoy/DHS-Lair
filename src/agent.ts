import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { AgentConfig, resolveCwd, resolveAdditionalDirs } from './agent-config.js';
import { audit } from './audit-log.js';
import { guardOutbound } from './exfil-guard.js';
import { getEnv, requireSwitch } from './kill-switches.js';
import { db, nowMs } from './db.js';
import { logTurn, buildMemoryBlock, recentTurns } from './memory.js';
import { loadSkills, summarizeSkillsForAgent } from './skill-registry.js';
import { logUsage } from './usage.js';

export interface SpawnOptions {
  agent: AgentConfig;
  userMessage: string;
  source?: string;        // 'dashboard','warroom','scheduled'
  sourceTurn?: string;    // groups multi-agent responses
  cwdVars?: Record<string, string>;
  /** Override tool allowlist (e.g. for war room). */
  toolsOverride?: string[];
  /** Role to log the inbound prompt as. Defaults to 'user'.
   *  Mission-worker passes 'system' so scripted prompts don't show as user. */
  userTurnRole?: 'user' | 'system';
  /** Absolute paths of image files to attach. Granted via --add-dir
   *  and referenced in the prompt so the agent can Read them. */
  attachments?: string[];
}

export interface SpawnResult {
  ok: boolean;
  text: string;
  exitCode: number | null;
  durationMs: number;
  error?: string;
}

interface ClaudeResultJson {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  duration_ms?: number;
  duration_api_ms?: number;
  num_turns?: number;
  result?: string;
  session_id?: string;
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

/** Strip the common leading indent from all non-blank lines. Preserves
 *  relative indentation (e.g. nested code-block structure) but eliminates
 *  the constant 4-space/tab prefix the claude CLI sometimes adds. */
function stripCommonIndent(text: string): string {
  const lines = text.split(/\r?\n/);
  const nonBlank = lines.filter(l => l.trim().length > 0);
  if (nonBlank.length === 0) return text;
  let minIndent = Infinity;
  for (const l of nonBlank) {
    const m = l.match(/^[ \t]*/);
    if (m) minIndent = Math.min(minIndent, m[0].length);
  }
  if (!isFinite(minIndent) || minIndent === 0) return text;
  return lines.map(l => l.length >= minIndent ? l.slice(minIndent) : l).join('\n');
}

function buildHistoryBlock(agentId: string, currentMessage: string): string {
  const turns = recentTurns(agentId, 12).filter(t => t.text !== currentMessage);
  if (turns.length === 0) return '';
  const lines = ['## Recent conversation history', '', '*(your prior turns with this user — read for continuity)*', ''];
  for (const t of turns) {
    const who = t.role === 'user' ? 'User' : 'You';
    const stamp = new Date(t.ts).toLocaleString();
    const body = t.text.length > 1500 ? t.text.slice(0, 1500) + '\n…[truncated]' : t.text;
    lines.push(`**${who}** · ${stamp}`);
    lines.push(body);
    lines.push('');
  }
  return lines.join('\n');
}

function buildRecentMissionsBlock(agentId: string): string {
  // NØX has no kanban visibility from inside his run, so he can curl-file a
  // mission that the user just clicked-to-file moments earlier. Showing him
  // the last 10 minutes of missions lets him check before double-filing.
  if (agentId !== 'nox') return '';
  const sinceMs = Date.now() - 10 * 60 * 1000;
  let rows: Array<{ id: number; created_at: number; agent_id: string; status: string; prompt: string }> = [];
  try {
    rows = db().prepare(`
      SELECT id, created_at, agent_id, status, prompt FROM mission_tasks
      WHERE created_at > ?
      ORDER BY created_at DESC
      LIMIT 10
    `).all(sinceMs) as typeof rows;
  } catch { return ''; }
  if (rows.length === 0) return '';
  const lines = [
    '## Recent missions on the kanban (last 10 min)',
    '',
    '*Filed by Tkiljoy (click-to-file from a `mission` block) or by you (curl). Check this list before curl-filing — if a row already covers the work, do NOT file another. Confirm with the user instead.*',
    '',
  ];
  for (const r of rows) {
    const stamp = new Date(r.created_at).toLocaleTimeString();
    const preview = r.prompt.replace(/\s+/g, ' ').slice(0, 140);
    lines.push(`- **#${r.id}** · @${r.agent_id} · ${r.status} · ${stamp} — ${preview}${r.prompt.length > 140 ? '…' : ''}`);
  }
  return lines.join('\n');
}

function buildToolGuidanceBlock(agent: AgentConfig, extraDirs: string[]): string {
  if (extraDirs.length === 0 && (!agent.tools || agent.tools.length === 0)) return '';
  const lines = ['## Tool guidance (active for this turn)', ''];
  if (agent.tools && agent.tools.length > 0) {
    lines.push(`You have these tools allowlisted: ${agent.tools.map(t => `\`${t}\``).join(', ')}.`);
  }
  if (extraDirs.length > 0) {
    lines.push('');
    lines.push('At spawn time you were granted filesystem access to the directories below via `--add-dir`. **These grants are real and your tools will succeed inside them — do not refuse, hedge, or claim "permissions not granted." Just call Read/Glob/Grep on absolute paths inside these dirs.**');
    lines.push('');
    for (const d of extraDirs) lines.push(`- \`${d}\``);
  }
  lines.push('');
  lines.push('If a path is outside these grants, then refuse with the explicit reason. But for paths inside the grants, **proceed without asking.**');
  return lines.join('\n');
}

function buildSystemPrompt(agent: AgentConfig, userMessage: string, extraDirs: string[]): string {
  const claudeMd = fs.readFileSync(agent.claude_md_path, 'utf8');
  const skills = loadSkills();
  const skillBlock = summarizeSkillsForAgent(skills, agent.default_skills ?? []);
  const memoryBlock = buildMemoryBlock(agent.id, userMessage);
  const historyBlock = buildHistoryBlock(agent.id, userMessage);
  const missionsBlock = buildRecentMissionsBlock(agent.id);
  const toolBlock = buildToolGuidanceBlock(agent, extraDirs);

  const blocks = [
    `# Agent identity: ${agent.id}`,
    `Display name: ${agent.display_name}`,
    agent.description ? `Description: ${agent.description}` : '',
    '',
    '---',
    '',
    claudeMd.trim(),
    '',
    toolBlock,
    skillBlock,
    memoryBlock,
    historyBlock,
    missionsBlock,
  ].filter(Boolean);

  return blocks.join('\n');
}

export async function runAgent(opts: SpawnOptions): Promise<SpawnResult> {
  const start = Date.now();
  try {
    requireSwitch('LLM_SPAWN_ENABLED');
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    audit({ actorType: 'system', action: 'kill_switch_refusal', target: opts.agent.id, payload: { switch: 'LLM_SPAWN_ENABLED' } });
    return { ok: false, text: msg, exitCode: null, durationMs: Date.now() - start, error: msg };
  }

  const cwd = resolveCwd(opts.agent, opts.cwdVars ?? {});
  let tools = opts.toolsOverride ?? opts.agent.tools ?? [];
  const model = opts.agent.model ?? getEnv('DEFAULT_AGENT_MODEL', 'claude-sonnet-4-6')!;
  const claudeBin = getEnv('CLAUDE_CLI', '') || 'claude';

  // Persist the inbound turn before spawning. Default role is 'user',
  // but mission-worker passes 'system' so scripted prompts don't render
  // as if the human typed them.
  const inboundRole = opts.userTurnRole ?? 'user';
  const turnMeta = opts.attachments && opts.attachments.length > 0
    ? { attachments: opts.attachments }
    : undefined;
  logTurn(opts.agent.id, inboundRole, opts.userMessage, {
    source: opts.source,
    sourceTurn: opts.sourceTurn,
    meta: turnMeta,
  });

  // Resolve filesystem grants first so they're visible to the system prompt.
  const extraDirs = resolveAdditionalDirs(opts.agent, opts.cwdVars ?? {})
    .filter(d => fs.existsSync(d));

  // If the user attached images, grant Read on each parent dir so the
  // agent's Read tool can open them. Dedupe with extraDirs.
  const attachments = (opts.attachments ?? []).filter(p => fs.existsSync(p));
  if (attachments.length > 0) {
    const attachDirs = Array.from(new Set(attachments.map(p => path.dirname(p))));
    for (const d of attachDirs) {
      if (!extraDirs.includes(d)) extraDirs.push(d);
    }
    // Defensive: force-include Read in the tools list so the agent can actually
    // open the attached file(s). Without this, an agent whose persona-yaml omits
    // Read (or whose toolsOverride drops it for warroom) would silently fail to
    // see the image and reply as if it received text only.
    if (!tools.includes('Read')) {
      tools = [...tools, 'Read'];
    }
  }

  const systemPrompt = buildSystemPrompt(opts.agent, opts.userMessage, extraDirs);

  // Place the attachments block BEFORE the user message so the agent sees it
  // first and reads the images before composing its reply. The previous order
  // (block appended after the user message) made the instruction easy to skim
  // past, especially for short user prompts like "what is this?".
  const attachmentsBlock = attachments.length > 0
    ? [
        '## Attached images (current turn)',
        '',
        'The user attached the file(s) below. **Before composing your reply, call the `Read` tool on each absolute path so you actually see the image** — `Read` renders image files visually. Do not respond as if you only received text.',
        '',
        ...attachments.map(p => `- \`${p}\``),
        '',
        '---',
        '',
      ].join('\n')
    : '';

  // We pipe the entire prompt (persona + memory + user message) via stdin
  // so no command-line argument contains spaces or newlines.
  // This is the only spawn pattern that survives Windows cmd.exe tokenization
  // when shell:true is required for .cmd shims (claude is npm-installed -> claude.cmd).
  const fullPrompt = `${systemPrompt}\n\n---\n\n# User message (current turn)\n\n${attachmentsBlock}${opts.userMessage}`;

  const args = [
    '-p',
    '--model', model,
    '--output-format', 'json',
    // Hive-spawned agents have no interactive permission channel — a prompt
    // for Edit/Write/Bash would just hang the subprocess. Safety still comes
    // from --allowed-tools (whitelist), --add-dir (filesystem scope),
    // exfil-guard (output scan), and the audit log. Override via env if a
    // deployment wants stricter behavior.
    '--permission-mode', process.env.AGENT_PERMISSION_MODE || 'bypassPermissions',
  ];

  if (tools.length > 0) {
    args.push('--allowed-tools', tools.join(','));
  }

  for (const d of extraDirs) {
    args.push('--add-dir', d);
  }

  audit({
    actorType: 'system',
    actorId: opts.agent.id,
    action: 'agent_spawn',
    target: cwd,
    payload: { model, tools, additionalDirs: extraDirs, source: opts.source, sourceTurn: opts.sourceTurn, promptLen: fullPrompt.length },
  });

  // Surface live "agent working" state to Pulse/Brain/Graph. The matching
  // 'spawn_finished' row goes in below on close/error. The dashboard derives
  // the working set from `spawn_started > spawn_finished` per agent.
  db().prepare(`INSERT INTO hive_mind_log (agent_id, event, summary) VALUES (?, ?, ?)`)
    .run(opts.agent.id, 'spawn_started', (opts.source ?? 'chat'));

  return new Promise<SpawnResult>(resolve => {
    let stdout = '';
    let stderr = '';
    const child = spawn(claudeBin, args, {
      cwd: fs.existsSync(cwd) ? cwd : process.cwd(),
      env: { ...process.env },
      shell: process.platform === 'win32',
    });

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });

    // Pipe the full prompt to stdin and close.
    child.stdin.on('error', () => { /* swallow EPIPE if process dies early */ });
    child.stdin.write(fullPrompt, 'utf8');
    child.stdin.end();

    // Dev missions chain forge-master → bridge-master → forge-inspector → ...
    // and can run 10+ minutes. 5 min was too aggressive and was SIGKILLing
    // runs that had already produced complete results. Override via env if
    // a specific deployment needs it tighter or looser.
    const timeoutMs = Number(process.env.AGENT_TIMEOUT_MS) || (20 * 60 * 1000);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.on('error', err => {
      clearTimeout(timer);
      const text = `agent spawn failed: ${err.message}`;
      audit({ actorType: 'system', actorId: opts.agent.id, action: 'agent_response', payload: { ok: false, error: err.message } });
      logTurn(opts.agent.id, 'assistant', text, { source: opts.source, sourceTurn: opts.sourceTurn });
      db().prepare(`INSERT INTO hive_mind_log (agent_id, event, summary) VALUES (?, ?, ?)`)
        .run(opts.agent.id, 'spawn_finished', `error: ${err.message.slice(0, 100)}`);
      resolve({ ok: false, text, exitCode: null, durationMs: Date.now() - start, error: err.message });
    });

    child.on('close', code => {
      clearTimeout(timer);
      // Parse JSON output if possible (claude -p --output-format json).
      // Fall back to raw stdout text on parse failure.
      let resultText = '';
      let parsedJson: ClaudeResultJson | null = null;
      try {
        const trimmed = stdout.trim();
        if (trimmed.startsWith('{')) {
          parsedJson = JSON.parse(trimmed) as ClaudeResultJson;
          if (typeof parsedJson?.result === 'string') {
            resultText = parsedJson.result;
          }
        }
      } catch {
        parsedJson = null;
      }
      if (!resultText) resultText = stdout;
      const raw = stripCommonIndent(resultText).replace(/\n{3,}/g, '\n\n').trim() || stderr.trim() || '(no output)';

      // Log usage if the JSON came back with token info.
      if (parsedJson?.usage) {
        const u = parsedJson.usage;
        logUsage({
          source: 'claude',
          agentId: opts.agent.id,
          model,
          inputTokens: u.input_tokens ?? 0,
          outputTokens: u.output_tokens ?? 0,
          cacheReadTokens: u.cache_read_input_tokens ?? 0,
          cacheCreateTokens: u.cache_creation_input_tokens ?? 0,
          costUsd: parsedJson.total_cost_usd ?? 0,
          category: opts.source ?? 'chat',
          meta: { sourceTurn: opts.sourceTurn, durationApiMs: parsedJson.duration_api_ms, numTurns: parsedJson.num_turns },
        });
      }
      const guarded = guardOutbound(raw, { actorType: 'agent', actorId: opts.agent.id, target: opts.source });
      logTurn(opts.agent.id, 'assistant', guarded, { source: opts.source, sourceTurn: opts.sourceTurn });
      // A run is successful if claude exited cleanly OR it produced a
      // structured result (parsedJson with is_error !== true and a non-empty
      // result string). The latter covers SIGKILL-after-completion and
      // similar edge cases where the agent did its work but the wrapping
      // shell didn't return 0. Without this, every long mission was being
      // misclassified as failed even though it finished its job.
      const hasGoodJson = !!(parsedJson && parsedJson.is_error !== true && typeof parsedJson.result === 'string' && parsedJson.result.trim().length > 0);
      const ok = code === 0 || hasGoodJson;
      audit({
        actorType: 'agent',
        actorId: opts.agent.id,
        action: 'agent_response',
        payload: { ok, exitCode: code, durationMs: Date.now() - start, length: guarded.length, timedOut, hasGoodJson },
      });
      db().prepare(`INSERT INTO hive_mind_log (agent_id, event, summary) VALUES (?, ?, ?)`)
        .run(opts.agent.id, 'message', guarded.slice(0, 200));
      db().prepare(`INSERT INTO hive_mind_log (agent_id, event, summary) VALUES (?, ?, ?)`)
        .run(opts.agent.id, 'spawn_finished', `exit ${code}${timedOut ? ' (timeout)' : ''}`);
      resolve({ ok, text: guarded, exitCode: code, durationMs: Date.now() - start });
    });
  });
}
