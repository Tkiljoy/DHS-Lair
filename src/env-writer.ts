import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { audit } from './audit-log.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.resolve(__dirname, '..', '.env');

/**
 * Update or insert a single key in .env. Preserves comments + ordering.
 * Triggers an mtime change so kill-switches.ts re-reads within ~1.5s.
 */
export function setEnvKey(key: string, value: string): void {
  let text = '';
  try { text = fs.readFileSync(ENV_PATH, 'utf8'); } catch { text = ''; }
  const lines = text.split(/\r?\n/);
  const re = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}=`);
  let updated = false;
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) {
      lines[i] = `${key}=${value}`;
      updated = true;
      break;
    }
  }
  if (!updated) lines.push(`${key}=${value}`);
  fs.writeFileSync(ENV_PATH, lines.join('\n'), 'utf8');
}

export function flipSwitch(name: string, value: boolean, actor: { actorType: 'user' | 'system'; actorId?: string }): void {
  setEnvKey(name, String(value));
  audit({
    actorType: actor.actorType,
    actorId: actor.actorId,
    action: 'kill_switch_flip',
    target: name,
    payload: { value },
  });
}
