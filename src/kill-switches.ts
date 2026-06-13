import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.resolve(__dirname, '..', '.env');

export type SwitchName =
  | 'LLM_SPAWN_ENABLED'
  | 'WARROOM_TEXT_ENABLED'
  | 'WARROOM_VOICE_ENABLED'
  | 'DASHBOARD_MUTATIONS_ENABLED'
  | 'MISSION_AUTO_ASSIGN_ENABLED'
  | 'SCHEDULER_ENABLED';

const DEFAULTS: Record<SwitchName, boolean> = {
  LLM_SPAWN_ENABLED: true,
  WARROOM_TEXT_ENABLED: true,
  WARROOM_VOICE_ENABLED: false,
  DASHBOARD_MUTATIONS_ENABLED: true,
  MISSION_AUTO_ASSIGN_ENABLED: false,
  SCHEDULER_ENABLED: true,
};

let cache: Record<string, string> = {};
let lastMtime = 0;
let lastChecked = 0;
const CHECK_INTERVAL_MS = 1500;

function refreshIfStale(): void {
  const now = Date.now();
  if (now - lastChecked < CHECK_INTERVAL_MS) return;
  lastChecked = now;
  try {
    const st = fs.statSync(ENV_PATH);
    if (st.mtimeMs === lastMtime && Object.keys(cache).length > 0) return;
    lastMtime = st.mtimeMs;
    const buf = fs.readFileSync(ENV_PATH);
    const parsed = dotenv.parse(buf);
    cache = parsed;
  } catch {
    // .env may not exist yet (during setup). Use defaults via process.env fallback.
    cache = { ...process.env } as Record<string, string>;
  }
}

export function getEnv(name: string, fallback?: string): string | undefined {
  refreshIfStale();
  return cache[name] ?? process.env[name] ?? fallback;
}

export function getSwitch(name: SwitchName): boolean {
  refreshIfStale();
  const raw = (cache[name] ?? process.env[name] ?? String(DEFAULTS[name])).trim().toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'yes';
}

export class KillSwitchRefusal extends Error {
  constructor(public switchName: SwitchName) {
    super(`${switchName} is false. Operation refused. Edit .env to re-enable.`);
    this.name = 'KillSwitchRefusal';
  }
}

export function requireSwitch(name: SwitchName): void {
  if (!getSwitch(name)) throw new KillSwitchRefusal(name);
}

export function snapshotSwitches(): Record<SwitchName, boolean> {
  return {
    LLM_SPAWN_ENABLED: getSwitch('LLM_SPAWN_ENABLED'),
    WARROOM_TEXT_ENABLED: getSwitch('WARROOM_TEXT_ENABLED'),
    WARROOM_VOICE_ENABLED: getSwitch('WARROOM_VOICE_ENABLED'),
    DASHBOARD_MUTATIONS_ENABLED: getSwitch('DASHBOARD_MUTATIONS_ENABLED'),
    MISSION_AUTO_ASSIGN_ENABLED: getSwitch('MISSION_AUTO_ASSIGN_ENABLED'),
    SCHEDULER_ENABLED: getSwitch('SCHEDULER_ENABLED'),
  };
}
