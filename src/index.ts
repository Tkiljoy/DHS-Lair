import 'dotenv/config';
import { startDashboard } from './dashboard.js';
import { syncAgentsToDb, loadAgents } from './agent-config.js';
import { audit, pruneAudit } from './audit-log.js';
import { consolidateMemory, decayMemoryStep } from './memory.js';
import { runSuggestionsJob } from './suggestions.js';
import { startMissionWorker } from './mission-worker.js';
import { getEnv, getSwitch } from './kill-switches.js';
import { db } from './db.js';

async function main(): Promise<void> {
  // Touch the DB so WAL mode is set early.
  db();
  syncAgentsToDb();
  audit({ actorType: 'system', action: 'startup', payload: { agents: [...loadAgents().keys()] } });

  const { port } = await startDashboard();
  console.log(`\n🐲 DHS-Lair ready at http://127.0.0.1:${port}/\n`);

  // Mission auto-executor — picks up queued mission_tasks rows.
  startMissionWorker();

  // Memory consolidation timer.
  const intervalMin = parseInt(getEnv('MEMORY_CONSOLIDATION_INTERVAL_MIN', '30') ?? '30', 10);
  if (getEnv('GEMINI_API_KEY')) {
    setInterval(async () => {
      try {
        const r = await consolidateMemory();
        if (!r.ok) console.warn('[memory] consolidation failed:', r.error);
      } catch (e) {
        console.error('[memory] consolidation crashed:', e);
      }
    }, intervalMin * 60 * 1000);
    console.log(`[memory] Tier 2 consolidation every ${intervalMin}m (Gemini Flash).`);
  } else {
    console.log('[memory] Tier 1 mode (no GEMINI_API_KEY). Add it to .env to enable Tier 2.');
  }

  // Daily audit prune + memory decay + suggestions run.
  setInterval(async () => {
    pruneAudit();
    decayMemoryStep();
    if (getSwitch('SCHEDULER_ENABLED')) {
      try {
        const r = await runSuggestionsJob({ trigger: 'scheduled' });
        if (r.totalInserted > 0) console.log(`[suggestions] scheduled run inserted ${r.totalInserted} (${JSON.stringify(r.byType)})`);
      } catch (e) {
        console.error('[suggestions] scheduled run failed:', e);
      }
    }
  }, 24 * 60 * 60 * 1000);

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

function shutdown(): void {
  audit({ actorType: 'system', action: 'shutdown' });
  process.exit(0);
}

main().catch(err => {
  console.error('fatal:', err);
  process.exit(1);
});
