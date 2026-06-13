#!/usr/bin/env bash
# Fires on Claude Code pre_tool_use hook before forge-inspector Agent calls.
# Pulls latest remote state so the inspector works off current code.
# NEVER blocks inspection — all failures are warnings only.
set -euo pipefail

HIVE_ROOT="C:/CORE/Business/DHS-Hive"
STATE_FILE="$HIVE_ROOT/scripts/hooks/.git-sync-state.json"
AUDIT_LOG="$HIVE_ROOT/audit_log/git-sync.jsonl"
ENV_FILE="$HIVE_ROOT/.env"

# Load .env (ignore if missing)
if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

DHS_GIT_SYNC_ENABLED="${DHS_GIT_SYNC_ENABLED:-true}"

write_audit() {
  local hook="$1" project="$2" branch="$3" sha="$4" result="$5" reason="$6"
  local ts
  ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || echo "1970-01-01T00:00:00Z")
  local entry
  entry=$(jq -nc \
    --arg ts "$ts" \
    --arg hook "$hook" \
    --arg project "$project" \
    --arg branch "$branch" \
    --arg sha "$sha" \
    --arg result "$result" \
    --arg reason "$reason" \
    '{ts:$ts,hook:$hook,project:$project,branch:$branch,sha:$sha,remote:"origin",result:$result,reason:$reason}')
  echo "$entry" >> "$AUDIT_LOG"
}

# Validate this is actually a forge-inspector call (double-check beyond settings matcher)
HOOK_INPUT=$(cat || true)
if [[ "$HOOK_INPUT" != *"forge-inspector"* ]]; then
  exit 0
fi

# Kill switch — always exit 0, inspection must proceed
if [[ "$DHS_GIT_SYNC_ENABLED" == "false" ]]; then
  write_audit "pre-inspector-pull" "" "" "" "skipped" "[git-sync] kill switch active — inspector proceeds on local state"
  echo "[git-sync] kill switch active, skipping pull — inspector proceeds on local state"
  exit 0
fi

# State file — optional for pull; proceed without if missing
if [[ ! -f "$STATE_FILE" ]]; then
  write_audit "pre-inspector-pull" "" "" "" "skipped" "state file missing — inspector proceeds on local state"
  echo "[git-sync] state file not found, inspector proceeds on local state"
  exit 0
fi

PROJECT_PATH=$(jq -r '.project_path' "$STATE_FILE")
BRANCH=$(jq -r '.branch' "$STATE_FILE")
PROJECT_NAME=$(jq -r '.project_name // ""' "$STATE_FILE" 2>/dev/null || basename "$PROJECT_PATH")

if ! cd "$PROJECT_PATH" 2>/dev/null; then
  write_audit "pre-inspector-pull" "$PROJECT_NAME" "$BRANCH" "" "skipped" "cannot cd to $PROJECT_PATH — inspector proceeds on local state"
  echo "[git-sync] cannot cd to $PROJECT_PATH, inspector proceeds on local state"
  exit 0
fi

# Remote check — warning only
if ! git remote get-url origin &>/dev/null; then
  SHA=$(git rev-parse HEAD 2>/dev/null || echo "")
  write_audit "pre-inspector-pull" "$PROJECT_NAME" "$BRANCH" "$SHA" "skipped" "no remote 'origin' — inspector proceeds on local state"
  echo "[git-sync] no remote 'origin', inspector proceeds on local state"
  exit 0
fi

# Dirty tree — warning only, skip pull but allow inspection
DIRTY=$(git status --porcelain)
if [[ -n "$DIRTY" ]]; then
  SHA=$(git rev-parse HEAD)
  write_audit "pre-inspector-pull" "$PROJECT_NAME" "$BRANCH" "$SHA" "skipped" "WARN: dirty working tree — pull skipped, inspector proceeds on local state"
  echo "[git-sync] WARN: dirty tree on $PROJECT_NAME/$BRANCH — pull skipped, inspector proceeds on local state"
  exit 0
fi

# Fast-forward pull only
PULL_OUTPUT=$(git pull --ff-only origin "$BRANCH" 2>&1) || {
  SHA=$(git rev-parse HEAD)
  write_audit "pre-inspector-pull" "$PROJECT_NAME" "$BRANCH" "$SHA" "error" "WARN: pull --ff-only failed (diverged history?): $PULL_OUTPUT — inspector proceeds on local state"
  echo "[git-sync] WARN: pull --ff-only failed for $PROJECT_NAME/$BRANCH — inspector proceeds on local state"
  echo "$PULL_OUTPUT"
  exit 0  # Never block inspection
}

SHA=$(git rev-parse HEAD)
write_audit "pre-inspector-pull" "$PROJECT_NAME" "$BRANCH" "$SHA" "success" ""
echo "[git-sync] pulled to $SHA on $BRANCH for $PROJECT_NAME"
