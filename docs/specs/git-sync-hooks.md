# Spec: Git-Sync Automation Hooks
**Status:** Draft — awaiting Tkiljoy review before any implementation is filed  
**Date:** 2026-05-04  
**Author:** ideas agent  
**Scope:** Two pipeline hooks, no new agent persona

---

## Overview

Two lightweight hooks wrap existing git operations at fixed seams in the
DHS-Lair pipeline:

- **Hook 1 — `post-chronicler-push`:** Auto-push after chronicler finalizes a
  changelog or version bump.
- **Hook 2 — `pre-inspector-pull`:** Auto-pull before forge-inspector begins
  an inspection pass.

Neither hook introduces a new agent or standup voice. Both are disabled by a
single env var kill switch.

---

## Hook 1: `post-chronicler-push`

### Purpose
Ensure that once chronicler has written a final changelog entry and bumped the
version, the working branch is pushed to origin immediately - no stale-branch
drift between release documentation and the remote.

### Trigger
The `stop` hook in `settings.json` fires after any agent session ends. The
hook script inspects the session transcript summary for the chronicler agent
completion signal (a sentinel string such as `CHRONICLER_DONE`) and acts only
on that match. All other agent completions are a no-op.

### Where it lives
- **Hook declaration:** `.claude/settings.json` under `hooks.stop`
- **Implementation:** `C:\CORE\Business\DHS-Hive\scripts\hooks\post-chronicler-push.sh`

The settings entry:
```json
"hooks": {
  "stop": [
    {
      "matcher": "CHRONICLER_DONE",
      "hooks": [
        {
          "type": "command",
          "command": "bash C:/CORE/Business/DHS-Hive/scripts/hooks/post-chronicler-push.sh"
        }
      ]
    }
  ]
}
```

### Behavior

1. Reads `DHS_GIT_SYNC_ENABLED` - if `false`, exits 0 with a log entry
   (`[git-sync] kill switch active, skipping push`).
2. Reads the target project path and branch from an env var or temp state file
   written by chronicler at completion (`GIT_SYNC_PROJECT_PATH`,
   `GIT_SYNC_BRANCH`).
3. Validates pre-conditions:
   - Working tree is clean (`git status --porcelain` returns empty). If dirty,
     aborts with error logged to audit_log (see Audit Trail section).
   - Current branch is NOT `main` or `master`. If it is, aborts and surfaces a
     confirmation prompt to the user - no silent main pushes.
   - Remote exists (`git remote get-url origin` succeeds). If missing, aborts
     with logged error.
4. Runs `git push origin <branch>` (no `--force`, no `--force-with-lease`).
5. Captures the pushed commit SHA (`git rev-parse HEAD`) and writes the audit
   entry (see Audit Trail section).
6. On success, prints `[git-sync] pushed <SHA> to <branch> for <project>`.

### Branch protection rules (hard-coded, not configurable)
- `main` and `master` are blocked unconditionally from auto-push.
- Any branch matching `release/*` requires an explicit `GIT_SYNC_ALLOW_RELEASE=true`
  env var to proceed; otherwise aborts with a logged warning.
- All other branches (e.g., `dev-tk`, `v2`, `feature/*`) are allowed.

---

## Hook 2: `pre-inspector-pull`

### Purpose
Guarantee forge-inspector always inspects the latest remote state. Eliminates
the class of review failures caused by the inspector working off code that dev
already fixed on a subsequent push.

### Trigger
The `pre_tool_use` hook in `settings.json` intercepts `Agent` tool calls. The
hook script matches on `subagent_type: forge-inspector` and acts only on that
match.

### Where it lives
- **Hook declaration:** `.claude/settings.json` under `hooks.pre_tool_use`
- **Implementation:** `C:\CORE\Business\DHS-Hive\scripts\hooks\pre-inspector-pull.sh`

The settings entry:
```json
"hooks": {
  "pre_tool_use": [
    {
      "matcher": "forge-inspector",
      "hooks": [
        {
          "type": "command",
          "command": "bash C:/CORE/Business/DHS-Hive/scripts/hooks/pre-inspector-pull.sh"
        }
      ]
    }
  ]
}
```

### Behavior

1. Reads `DHS_GIT_SYNC_ENABLED` - if `false`, exits 0 with a log entry and
   allows the inspector to proceed (never blocks inspection, even when disabled).
2. Reads the target project path from the `Agent` tool call context env or a
   shared state file set by the calling agent.
3. Validates pre-conditions:
   - Working tree is clean. If dirty (uncommitted changes), **does not pull**
     and logs a warning to audit_log, then allows inspection to proceed on the
     current state. Dirty-tree is a warning, not a hard block - review must
     never be completely prevented by a sync failure.
   - Remote exists. If missing, logs and proceeds without pulling.
4. Runs `git pull --ff-only origin <branch>`.
5. On fast-forward success: logs the new HEAD SHA to audit_log.
6. On non-fast-forward (diverged history): aborts the pull, logs the conflict
   detail to audit_log with severity `WARN`, and allows inspection to proceed
   on the current local state. The inspector output will note the potential
   staleness.

---

## Audit Trail

Every auto-push (Hook 1) writes a structured entry to the Hive's audit log.
Auto-pulls (Hook 2) write on both success and failure.

### Entry format
```json
{
  "ts": "2026-05-04T14:30:00Z",
  "hook": "post-chronicler-push | pre-inspector-pull",
  "project": "<project_name>",
  "branch": "<branch_name>",
  "sha": "<full_commit_sha>",
  "remote": "origin",
  "result": "success | skipped | error",
  "reason": "<human-readable detail on skip or error>"
}
```

### Audit log location
`C:\CORE\Business\DHS-Hive\audit_log\git-sync.jsonl` — one JSON object per
line, append-only. Ops can grep this file by project name to correlate pushes
against Tebex sale timestamps.

---

## Failure Modes

| Condition | Hook 1 (push) | Hook 2 (pull) |
|---|---|---|
| Kill switch active | Exit 0, log skipped | Exit 0, log skipped, allow inspection |
| Dirty working tree | Abort push, log error | Log warning, skip pull, allow inspection |
| On `main`/`master` | Abort, prompt user | N/A (pull is safe on any branch) |
| Remote missing | Abort push, log error | Log warning, skip pull, allow inspection |
| Non-fast-forward merge | N/A | Abort pull, log WARN, allow inspection on local state |
| Push rejected (upstream diverged) | Log error with remote message, do NOT force | N/A |
| Script itself errors (bash failure) | Log with exit code, do NOT silently swallow | Log with exit code, allow inspection |

**Key principle:** Hook 2 (pull) must never block review from starting. Sync
failures are informational. Hook 1 (push) may abort the push but must never
corrupt the working tree or force-override remote state.

---

## Kill Switch

Single env var controls both hooks:

```
DHS_GIT_SYNC_ENABLED=false
```

Set in `.env` at the Hive root. Both hook scripts read this var at startup.
When `false`:
- Hook 1 skips the push, logs `[git-sync] disabled`, exits 0.
- Hook 2 skips the pull, logs `[git-sync] disabled`, exits 0 and allows
  inspection to proceed normally.

Default value if the var is unset: `true` (hooks are active).

A per-project override can suppress only one project's auto-push:
```
DHS_GIT_SYNC_SKIP_PROJECTS=DHS-PrisonSim,DHS-Creator
```
Comma-separated list. Hook 1 checks this list before pushing; matching
projects are skipped and logged.

---

## Open Questions for Tkiljoy

1. **State handoff from chronicler:** Chronicler currently doesn't write a
   state file. Hook 1 needs `GIT_SYNC_PROJECT_PATH` and `GIT_SYNC_BRANCH` from
   somewhere. Options: (a) chronicler writes a temp file on completion, (b) the
   hook infers from the current working directory at session end, (c) the
   calling agent passes them as env vars. Which is cleanest for your setup?

2. **Sentinel string:** The `stop` hook matcher needs a reliable signal that
   chronicler (not another agent) just completed. If the Hive dashboard already
   emits structured agent-completion events, we can match on those instead of a
   sentinel string in the transcript.

3. **Audit log rotation:** `git-sync.jsonl` will grow unbounded. Should ops
   handle rotation manually, or should the hook rotate at a size threshold
   (e.g., >10 MB)?

4. **Release branch policy:** The spec blocks `release/*` branches by default
   behind `GIT_SYNC_ALLOW_RELEASE=true`. If PrisonSim V2 uses a `release/v2`
   branch for its final push, this needs to be set. Worth confirming now before
   implementation.

---

## Implementation Notes (for dev, not ideas)

- Both scripts should be POSIX-compatible bash, no external dependencies beyond
  standard git and jq (for JSON audit log writes).
- The hook scripts go in version control under `DHS-Hive/scripts/hooks/` so
  they ship with the Hive config.
- Settings.json changes go through the `update-config` skill, not manual edits.
- This spec intentionally does NOT define the bash implementations - that's a
  dev mission once Tkiljoy approves the spec.
