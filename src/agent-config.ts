import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { db, nowMs } from './db.js';
import { getEnv } from './kill-switches.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AGENTS_DIR = path.resolve(__dirname, '..', 'agents');

export interface AgentConfig {
  id: string;
  display_name: string;
  description?: string;
  model?: string;
  /** ALLOWLIST of Claude Code tools the agent may use. */
  tools?: string[];
  /** Working directory the `claude` subprocess runs in. Supports {project} substitution. */
  cwd?: string;
  /** Extra directories the agent's tools may read/write. Passed as --add-dir to claude CLI. */
  additional_dirs?: string[];
  /** If true, this agent can be addressed in the war room. */
  warroom?: boolean;
  /** Tools the agent can use specifically inside the war room. Defaults to []. */
  warroom_tools?: string[];
  /** Skills the agent should default to using. */
  default_skills?: string[];
  /** Path to CLAUDE.md (resolved). */
  claude_md_path: string;
  /** Folder path of the agent. */
  folder: string;
}

function loadOne(folder: string): AgentConfig | null {
  const yamlPath = path.join(folder, 'agent.yaml');
  const claudeMdPath = path.join(folder, 'CLAUDE.md');
  if (!fs.existsSync(yamlPath) || !fs.existsSync(claudeMdPath)) return null;
  const raw = fs.readFileSync(yamlPath, 'utf8');
  const parsed = YAML.parse(raw) as Partial<AgentConfig>;
  const id = path.basename(folder);
  if (!parsed.display_name) {
    throw new Error(`agent ${id}: agent.yaml missing display_name`);
  }
  return {
    id,
    display_name: parsed.display_name!,
    description: parsed.description,
    model: parsed.model ?? getEnv('DEFAULT_AGENT_MODEL', 'claude-sonnet-4-6'),
    tools: parsed.tools ?? [],
    cwd: parsed.cwd,
    additional_dirs: parsed.additional_dirs ?? [],
    warroom: parsed.warroom ?? false,
    warroom_tools: parsed.warroom_tools ?? [],
    default_skills: parsed.default_skills ?? [],
    claude_md_path: claudeMdPath,
    folder,
  };
}

/** Expand env-var refs (${X}) and substitution vars ({key}) in a path. */
export function resolvePath(p: string, vars: Record<string, string> = {}): string {
  let out = p;
  for (const [k, v] of Object.entries(vars)) out = out.replaceAll(`{${k}}`, v);
  out = out.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_m, name) => getEnv(name) ?? `\${${name}}`);
  return out;
}

let _cache: Map<string, AgentConfig> | null = null;
let _cacheBuiltAt = 0;
const CACHE_TTL_MS = 5000;

export function loadAgents(force = false): Map<string, AgentConfig> {
  if (!force && _cache && Date.now() - _cacheBuiltAt < CACHE_TTL_MS) return _cache;
  const out = new Map<string, AgentConfig>();
  if (!fs.existsSync(AGENTS_DIR)) {
    _cache = out;
    _cacheBuiltAt = Date.now();
    return out;
  }
  const entries = fs.readdirSync(AGENTS_DIR, { withFileTypes: true });
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('_') || e.name.startsWith('.')) continue;
    const folder = path.join(AGENTS_DIR, e.name);
    try {
      const cfg = loadOne(folder);
      if (cfg) out.set(cfg.id, cfg);
    } catch (err) {
      console.error(`[agent-config] failed to load ${e.name}:`, err);
    }
  }
  _cache = out;
  _cacheBuiltAt = Date.now();
  return out;
}

export function syncAgentsToDb(): void {
  const agents = loadAgents(true);
  const stmt = db().prepare(`
    INSERT INTO agents (id, display_name, description, model, cwd, tools_json, registered_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      display_name = excluded.display_name,
      description  = excluded.description,
      model        = excluded.model,
      cwd          = excluded.cwd,
      tools_json   = excluded.tools_json,
      last_seen_at = excluded.last_seen_at
  `);
  const ts = nowMs();
  for (const a of agents.values()) {
    stmt.run(a.id, a.display_name, a.description ?? null, a.model ?? null, a.cwd ?? null, JSON.stringify(a.tools ?? []), ts, ts);
  }
}

export function resolveCwd(agent: AgentConfig, vars: Record<string, string> = {}): string {
  return resolvePath(agent.cwd ?? process.cwd(), vars);
}

export function resolveAdditionalDirs(agent: AgentConfig, vars: Record<string, string> = {}): string[] {
  return (agent.additional_dirs ?? []).map(p => resolvePath(p, vars));
}
