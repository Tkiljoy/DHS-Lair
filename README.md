# DHS-Lair

A local work-crew Lair for the FiveM script-store ops at DHS. Built on the
ClaudeClaw V3 base (orchestrator + SQLite shared memory + kill switches +
audit log + exfil guard + text war room). Five agents wrap the existing
user-scope FiveM dev agents that already live under `[DHS]\.claude\`.

**No Telegram. No Slack. No Discord.** Web dashboard only — desk-only.

## Agents

| Agent  | Role                                               |
|--------|----------------------------------------------------|
| nox    | Tkiljoy's primary personal-assistant companion. Default chat + router + war-room host. Visual: floating Evil Eye, persistent across all dashboard tabs. |
| dev    | Receives `/assign <project> <task>`. Wraps `forge-master`, `forge-apprentice`, `quartermaster`, `project-architect`, `ui-architect`. |
| review | Receives `/review <project>`. Wraps `forge-inspector`, `bridge-master`, `asset-librarian`. |
| ideas  | Brainstorms scripts/features/store positioning. No code. |
| ops    | Tebex / support backlog (stub for v1).             |

## Setup

```bash
npm install
npm run setup    # walks through .env, applies migrations
npm start        # launches dashboard at http://127.0.0.1:7777/
```

The setup wizard is re-runnable. It asks before overwriting `.env`.

You'll need:

- **Node 20+** (`node --version`)
- **`claude` CLI** on PATH (or set `CLAUDE_CLI` in `.env` to its full path)
- **Gemini API key** for Tier 2 memory extraction (free tier at
  https://aistudio.google.com/app/apikey). Without one the Lair runs in
  Tier 1 mode (conversation history only).

## Smoke test

After `npm start`, open `http://127.0.0.1:7777/` and run:

1. Send `nox`: "What's in DHS-Vault\01-Company\?" — verifies `dhs-vault-reader`.
2. Send `nox`: "List projects in [DHS]." — verifies `dhs-resources` read.
3. Send `dev`: `/assign DHS-Fishing add-rod-durability` — verifies subprocess
   spawns in the project folder and forge-apprentice runs. **Don't commit.**
4. Send `review`: `/review DHS-Fishing` — verifies forge-inspector +
   bridge-master + asset-librarian return a report.
5. Send `ideas`: "What's a low-effort FiveM script we haven't shipped?" —
   verifies brainstorm without code.
6. Send `/standup` — verifies all five agents respond.
7. Flip `LLM_SPAWN_ENABLED=false` in `.env`, send another message —
   verifies the kill switch refuses in ~2s. Flip back to `true`.
8. Inspect `store/dhs.db`:

   ```bash
   sqlite3 store/dhs.db "SELECT * FROM audit_log ORDER BY ts DESC LIMIT 10;"
   ```

If steps 1–8 pass, the Lair is wired correctly.

## Layout

```
agents/         five role-based agents (folders auto-discovered)
  _template/    copy this to add a new agent
skills/         auto-discovered skill folders
  dhs-vault-reader/    RO access to C:\CORE\Business\DHS-Vault
  dhs-resources/       RW access to [DHS]\<project> (per-agent perms)
  tebex/               stub for v1
  timezone/            US Eastern resolver
src/            orchestrator (Node 20+, TypeScript)
  index.ts             entry point
  dashboard.ts         Fastify web UI
  orchestrator.ts      routing + war room
  agent.ts             spawns `claude` subprocesses
  agent-config.ts      loads agents/<id>/agent.yaml
  skill-registry.ts    loads skills/<id>/SKILL.md
  memory.ts            Tier 2 (FTS5 + Gemini Flash extraction)
  db.ts                SQLite (WAL, busy_timeout=5000)
  kill-switches.ts     mtime-watching .env reader
  audit-log.ts         append-only audit
  exfil-guard.ts       regex scan on outbound text
public/         static dashboard HTML/JS
migrations/     numbered SQL files (idempotent)
scripts/        setup.ts, migrate.ts
store/          SQLite db (created on first migrate; gitignored)
.env.example    every key the codebase reads, documented
```

## Hard exclusions (always)

- `C:\CORE\Business\Personal\` — never read
- `C:\CORE\Business\District77-Vault\` — never read
- Any `D77` or `District77` directory — never read
- `[DHS]\.claude\` — never modify (the Lair delegates to it via `Agent` tool)

## What's not in v1 (intentional defer)

- Telegram / Slack / Discord bridges
- Voice (inbound, outbound, war room)
- Tier 3 semantic memory (add via Power Pack 06)
- Tebex live integration (skill is a stub until API key is wired)
- Auto-assign classifier (use explicit `@agent` or `/assign`)
- Suggestions feature (Pack 04 — needs 2-4 weeks of usage data)

## Power Packs

After the smoke test passes, paste **Pack 12 (backup)** from
`C:\Users\tkilj\Downloads\POWER_PACKS_V3.md`. SQLite is single-file; backups
are cheap insurance.

## Disclaimer

The system spawns the `claude` CLI as a subprocess with whatever tool
allowlist each agent's `agent.yaml` declares. `dev` has `Write`, `Edit`,
`Bash`, and `Agent` — meaning it can change project files and run commands
inside `[DHS]\<project>\`. Treat any project under `[DHS]\` as if it could
be modified at any time the Lair is running.

The exfil guard is regex-based. It will not catch every secret-shaped
string. Don't paste live keys into the Lair.

When in doubt, flip `LLM_SPAWN_ENABLED=false` in `.env`. The Lair will
refuse new agent work in ~2 seconds. Flip back when ready.
