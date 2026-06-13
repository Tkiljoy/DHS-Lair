import { GoogleGenerativeAI } from '@google/generative-ai';
import { getEnv } from './kill-switches.js';
import { logUsage, computeGeminiCost } from './usage.js';

let _client: GoogleGenerativeAI | null = null;

export function isGeminiConfigured(): boolean {
  return !!getEnv('GEMINI_API_KEY');
}

function client(): GoogleGenerativeAI {
  if (_client) return _client;
  const key = getEnv('GEMINI_API_KEY');
  if (!key) throw new Error('GEMINI_API_KEY missing');
  _client = new GoogleGenerativeAI(key);
  return _client;
}

export interface GenerateOptions {
  prompt: string;
  /** Used for logging only. e.g. 'memory:consolidate', 'suggestions:agent_split'. */
  category?: string;
  /** Optional agent attribution for the usage log. */
  agentId?: string;
  /** Default 'gemini-2.0-flash'. */
  model?: string;
}

// Default chosen to match D77's working setup. 2.0-flash family has limit=0
// on AI Studio free tier as of 2026 — 2.5-flash-lite is the modern equivalent
// that's actually allocated quota.
const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash-lite';

export async function generateText(opts: GenerateOptions): Promise<string> {
  const model = opts.model ?? getEnv('GEMINI_MODEL', DEFAULT_GEMINI_MODEL)!;
  const m = client().getGenerativeModel({ model });
  const r = await m.generateContent(opts.prompt);
  // Capture token usage for the Settings dashboard.
  const um = r.response.usageMetadata;
  const inputTokens = um?.promptTokenCount ?? 0;
  const outputTokens = um?.candidatesTokenCount ?? 0;
  if (inputTokens > 0 || outputTokens > 0) {
    logUsage({
      source: 'gemini',
      agentId: opts.agentId,
      model,
      inputTokens,
      outputTokens,
      costUsd: computeGeminiCost(model, inputTokens, outputTokens),
      category: opts.category,
    });
  }
  return r.response.text().trim();
}

/** Calls Gemini, strips fenced ```json blocks if present, JSON.parses. */
export async function generateJSON<T = unknown>(opts: GenerateOptions): Promise<T> {
  const text = await generateText(opts);
  const cleaned = text.startsWith('```')
    ? text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()
    : text;
  return JSON.parse(cleaned) as T;
}
