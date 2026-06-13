# DHS-Lair

A self-hosted, multi-agent orchestration platform that turns a single workstation into a coordinated "crew" of AI agents — with shared memory, hard safety rails, and a web war-room dashboard. Built to run real development and operations work for a software studio, locally and desk-only.

Think of it as a personal, security-conscious agent operating system: one router agent you talk to, several specialist agents it can delegate to, a shared memory layer so they don't forget context, and a set of kill switches and guards so the whole thing can't run away from you.

---

## What this project demonstrates

This repo is a working example of the kind of engineering these systems actually require in production:

- **Multi-agent orchestration** — a router agent plus role-based specialist agents (dev, review, ideas, ops), each spawned as an isolated subprocess with its own tool allowlist.
- **Agentic infrastructure** — auto-discovered agent configs and a skill registry (each skill is a self-contained folder with its own permissions), so new capabilities drop in without touching the core.
- **Production safety judgment** — kill switches, an append-only audit log, an outbound exfil guard, and hard directory exclusions. The system can modify real project files, so it's built assuming that power needs guardrails.
- **Shared persistent memory** — SQLite (WAL mode) with full-text search and an optional LLM-backed memory-extraction tier, so agents retain context across sessions.
- **Pragmatic, local-first design** — no cloud dependency, no chat-bridge sprawl. One dashboard, one database file, runs on a desk.

Stack: **Node 20+ · TypeScript · Fastify · SQLite (FTS5) · Claude CLI subprocesses · LLM memory extraction.**

---

## Architecture at a glance

```
You ──▶ Router agent (chat + war room)
            │
            ├──▶ dev agent     → spawns a sandboxed Claude subprocess in a project folder
            ├──▶ review agent  → runs inspection / QA passes and returns a report
            ├──▶ ideas agent   → brainstorms features & positioning (no code)
            └──▶ ops agent      → support / backlog tasks
                     │
       Shared layer: SQLite memory · audit log · kill switches · exfil guard
```

Each agent is defined by a small config file and a declared tool allowlist. The orchestrator routes messages, hosts a "war room" where agents collaborate, and enforces the safety layer on every action.

| Agent  | Role |
| ------ | ---- |
| router | Primary assistant + router + war-room host; persistent across the dashboard. |
| dev    | Receives `/assign <project> <task>`; spawns a sandboxed subprocess to do real implementation work. |
| review | Receives `/review <project>`; runs inspection, integration, and asset-audit passes. |
| ideas  | Brainstorms features, scripts, and product positioning. No code. |
| ops    | Support / operations backlog. |

---

## Safety model

Because agents can write files and run commands inside real project directories, the safety layer is a first-class part of the design, not an afterthought:

- **Kill switch** — flip a single env flag and the orchestrator refuses new agent work within ~2 seconds.
- **Append-only audit log** — every action is recorded in SQLite for review.
- **Exfil guard** — outbound text is regex-scanned for secret-shaped strings before it leaves.
- **Hard exclusions** — sensitive directories are never read, enforced in code.
- **Per-agent tool allowlists** — an agent only gets the tools its role declares (e.g. only `dev` gets write/exec).

---

## Setup

```bash
npm install
npm run setup    # walks through .env, applies migrations
npm start        # launches dashboard at http://127.0.0.1:7777/
```

Requirements:
- **Node 20+**
- **`claude` CLI** on PATH (or set `CLAUDE_CLI` in `.env`)
- *(Optional)* an LLM API key for the higher memory tier; without one, it runs on conversation history alone.

The setup wizard is re-runnable and asks before overwriting `.env`.

---

## Project layout

```
agents/        role-based agents (auto-discovered; copy _template/ to add one)
skills/        auto-discovered skill folders, each with its own permissions
src/           orchestrator (Node 20+, TypeScript)
  index.ts            entry point
  dashboard.ts        Fastify web UI
  orchestrator.ts     routing + war room
  agent.ts            spawns sandboxed subprocesses
  skill-registry.ts   loads skills
  memory.ts           persistent memory + LLM extraction
  db.ts               SQLite (WAL, busy_timeout)
  kill-switches.ts    env-watching safety reader
  audit-log.ts        append-only audit
  exfil-guard.ts      outbound text scan
public/        static dashboard
migrations/    numbered, idempotent SQL
scripts/       setup + migrate
```

---

## Roadmap

DHS-Lair is built in deliberate phases. Current build is the text-and-dashboard core; planned work extends it toward a full voice-driven assistant:

- **Voice I/O** — real-time speech in/out so the router agent works hands-free (JARVIS-style), layered on top of the existing orchestration core.
- **Semantic memory tier** — embedding-based recall on top of the current full-text layer.
- **Auto-routing classifier** — infer the right agent instead of explicit `/assign`.
- **Live integrations** — replace stubbed service connectors with real APIs.

---

## Status

Active development. The orchestration core, agent system, shared memory, and full safety layer are working; voice and semantic memory are the next phases. Built and maintained solo.
