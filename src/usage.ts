import { db, nowMs } from './db.js';

export type UsageSource = 'claude' | 'gemini';

export interface UsageEntry {
  source: UsageSource;
  agentId?: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreateTokens?: number;
  /** Authoritative cost in USD. For Claude this comes from the CLI's
   *  `total_cost_usd`. For Gemini we compute it from token counts. */
  costUsd?: number;
  category?: string;
  meta?: unknown;
}

// Gemini pricing — list price as of late 2025 / early 2026, Flash 2.0 tier.
// Format: USD per million tokens. Update if Google changes pricing.
const GEMINI_PRICES: Record<string, { in: number; out: number }> = {
  'gemini-2.5-flash-lite':  { in: 0.10, out: 0.40 },
  'gemini-2.0-flash':       { in: 0.10, out: 0.40 },
  'gemini-2.0-flash-lite':  { in: 0.075, out: 0.30 },
  'gemini-2.5-flash':       { in: 0.30, out: 2.50 },
  'gemini-2.5-pro':         { in: 1.25, out: 5.00 },
  'gemini-1.5-flash':       { in: 0.075, out: 0.30 },
  'gemini-1.5-pro':         { in: 1.25, out: 5.00 },
};

export function computeGeminiCost(model: string, inputTokens: number, outputTokens: number): number {
  const price = GEMINI_PRICES[model];
  if (!price) {
    // Unknown Gemini model — log zero rather than guess. Update GEMINI_PRICES when needed.
    return 0;
  }
  return (inputTokens / 1_000_000) * price.in + (outputTokens / 1_000_000) * price.out;
}

export function logUsage(entry: UsageEntry): void {
  const stmt = db().prepare(`
    INSERT INTO usage_log
      (ts, source, agent_id, model, input_tokens, output_tokens,
       cache_read_tokens, cache_create_tokens, cost_usd, category, meta_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    nowMs(),
    entry.source,
    entry.agentId ?? null,
    entry.model,
    entry.inputTokens ?? 0,
    entry.outputTokens ?? 0,
    entry.cacheReadTokens ?? 0,
    entry.cacheCreateTokens ?? 0,
    entry.costUsd ?? 0,
    entry.category ?? null,
    entry.meta === undefined ? null : JSON.stringify(entry.meta),
  );
}

export interface UsageBucket {
  source: UsageSource;
  /** Sum of input_tokens + output_tokens + cache reads/writes — single user-visible number. */
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  costUsd: number;
  callCount: number;
}

export interface UsageWindow {
  claude: UsageBucket;
  gemini: UsageBucket;
  totalTokens: number;
  totalCostUsd: number;
}

function emptyBucket(source: UsageSource): UsageBucket {
  return {
    source,
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreateTokens: 0,
    costUsd: 0,
    callCount: 0,
  };
}

function aggregateSince(sinceMs: number | null): UsageWindow {
  const claude = emptyBucket('claude');
  const gemini = emptyBucket('gemini');
  const sql = sinceMs == null
    ? `SELECT source, SUM(input_tokens) AS in_t, SUM(output_tokens) AS out_t,
              SUM(cache_read_tokens) AS cr, SUM(cache_create_tokens) AS cc,
              SUM(cost_usd) AS cost, COUNT(*) AS calls
       FROM usage_log GROUP BY source`
    : `SELECT source, SUM(input_tokens) AS in_t, SUM(output_tokens) AS out_t,
              SUM(cache_read_tokens) AS cr, SUM(cache_create_tokens) AS cc,
              SUM(cost_usd) AS cost, COUNT(*) AS calls
       FROM usage_log WHERE ts > ? GROUP BY source`;
  const rows = (sinceMs == null
    ? db().prepare(sql).all()
    : db().prepare(sql).all(sinceMs)) as Array<{
      source: UsageSource;
      in_t: number; out_t: number; cr: number; cc: number; cost: number; calls: number;
    }>;
  for (const r of rows) {
    const target = r.source === 'claude' ? claude : gemini;
    target.inputTokens = r.in_t ?? 0;
    target.outputTokens = r.out_t ?? 0;
    target.cacheReadTokens = r.cr ?? 0;
    target.cacheCreateTokens = r.cc ?? 0;
    target.costUsd = r.cost ?? 0;
    target.callCount = r.calls ?? 0;
    target.totalTokens = target.inputTokens + target.outputTokens + target.cacheReadTokens + target.cacheCreateTokens;
  }
  return {
    claude,
    gemini,
    totalTokens: claude.totalTokens + gemini.totalTokens,
    totalCostUsd: claude.costUsd + gemini.costUsd,
  };
}

/** Beginning of "today" in local time, as ms. */
function startOfTodayMs(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export interface UsageReport {
  today: UsageWindow;
  sevenDays: UsageWindow;
  allTime: UsageWindow;
}

export function usageReport(): UsageReport {
  return {
    today: aggregateSince(startOfTodayMs()),
    sevenDays: aggregateSince(nowMs() - 7 * 86400000),
    allTime: aggregateSince(null),
  };
}
