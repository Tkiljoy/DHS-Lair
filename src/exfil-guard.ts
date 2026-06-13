import { audit } from './audit-log.js';
import { getEnv } from './kill-switches.js';

const PATTERNS: { name: string; re: RegExp }[] = [
  { name: 'anthropic_key', re: /sk-ant-[a-zA-Z0-9_\-]{40,}/g },
  { name: 'slack_token', re: /xox[bapsr]-[A-Za-z0-9-]{10,}/g },
  { name: 'github_token', re: /gh[pousr]_[A-Za-z0-9_]{36,}/g },
  { name: 'aws_access_key', re: /AKIA[0-9A-Z]{16}/g },
  { name: 'gcp_api_key', re: /AIza[0-9A-Za-z\-_]{35}/g },
  { name: 'openai_key', re: /sk-(?:proj-)?[A-Za-z0-9_\-]{40,}/g },
  { name: 'high_entropy_hex', re: /\b[a-fA-F0-9]{40,}\b/g },
];

export interface ExfilScanResult {
  ok: boolean;
  blocked: boolean;
  hits: { pattern: string; sample: string }[];
}

export function scanForExfil(text: string): ExfilScanResult {
  const hits: { pattern: string; sample: string }[] = [];
  for (const { name, re } of PATTERNS) {
    re.lastIndex = 0;
    const match = re.exec(text);
    if (match) {
      const sample = match[0].slice(0, 8) + '…';
      hits.push({ pattern: name, sample });
    }
  }
  return { ok: hits.length === 0, blocked: hits.length > 0, hits };
}

export function scanPathForBlocked(p: string): boolean {
  const blocks = (getEnv('HARD_BLOCK_PATHS', '') ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  const norm = p.replace(/\//g, '\\').toLowerCase();
  return blocks.some(b => norm.startsWith(b.replace(/\//g, '\\').toLowerCase()));
}

export function guardOutbound(text: string, context: { actorType: 'agent' | 'system' | 'user'; actorId?: string; target?: string }): string {
  const result = scanForExfil(text);
  if (result.blocked) {
    audit({
      actorType: context.actorType,
      actorId: context.actorId,
      action: 'exfil_block',
      target: context.target,
      payload: { hits: result.hits, length: text.length },
    });
    return `[exfil-guard blocked output: ${result.hits.map(h => h.pattern).join(', ')}]`;
  }
  return text;
}
