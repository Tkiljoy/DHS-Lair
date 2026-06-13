#!/usr/bin/env bash
# Fires on Claude Code stop hook after a session that emits CHRONICLER_DONE.
# Pushes the working branch to origin. Never force-pushes. Never touches main/master.
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

# Read stop hook stdin and check for sentinel string
HOOK_INPUT=$(cat || true)
if [[ "$HOOK_INPUT" != *"CHRONICLER_DONE"* ]]; then
  # Not a chronicler session — silent no-op
  exit 0
fi

# Kill switch
if [[ "$DHS_GIT_SYNC_ENABLED" == "false" ]]; then
  write_audit "post-chronicler-push" "" "" "" "skipped" "[git-sync] kill switch active"
  echo "[git-sync] kill switch active, skipping push"
  exit 0
fi

# State file required for push
if [[ ! -f "$STATE_FILE" ]]; then
  write_audit "post-chronicler-push" "" "" "" "error" "state file missing: $STATE_FILE — chronicler must write this before completing"
  echo "[git-sync] ERROR: state file not found at $STATE_FILE" >&2
  exit 1
fi

PROJECT_PATH=$(jq -r '.project_path' "$STATE_FILE")
BRANCH=$(jq -r '.branch' "$STATE_FILE")
PROJECT_NAME=$(jq -r '.project_name // (env.PROJECT_PATH | split("/") | last)' "$STATE_FILE" 2>/dev/null || basename "$PROJECT_PATH")

# Per-project skip list
DHS_GIT_SYNC_SKIP_PROJECTS="${DHS_GIT_SYNC_SKIP_PROJECTS:-}"
if [[ -n "$DHS_GIT_SYNC_SKIP_PROJECTS" ]]; then
  IFS=',' read -ra SKIP_LIST <<< "$DHS_GIT_SYNC_SKIP_PROJECTS"
  for skip in "${SKIP_LIST[@]}"; do
    if [[ "$PROJECT_NAME" == "$skip" ]]; then
      write_audit "post-chronicler-push" "$PROJECT_NAME" "$BRANCH" "" "skipped" "project in DHS_GIT_SYNC_SKIP_PROJECTS"
      echo "[git-sync] $PROJECT_NAME is in skip list, skipping push"
      exit 0
    fi
  done
fi

cd "$PROJECT_PATH" || {
  write_audit "post-chronicler-push" "$PROJECT_NAME" "$BRANCH" "" "error" "cannot cd to $PROJECT_PATH"
  echo "[git-sync] ERROR: cannot cd to $PROJECT_PATH" >&2
  exit 1
}

# Branch protection: main/master — hard block, no silent pushes
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [[ "$CURRENT_BRANCH" == "main" || "$CURRENT_BRANCH" == "master" ]]; then
  write_audit "post-chronicler-push" "$PROJECT_NAME" "$CURRENT_BRANCH" "" "error" "refused auto-push to main/master — push manually if intentional"
  echo "[git-sync] ERROR: refusing to auto-push to $CURRENT_BRANCH. Push manually if intentional." >&2
  exit 1
fi

# Branch protection: release/* requires explicit opt-in
if [[ "$CURRENT_BRANCH" == release/* ]]; then
  GIT_SYNC_ALLOW_RELEASE="${GIT_SYNC_ALLOW_RELEASE:-false}"
  if [[ "$GIT_SYNC_ALLOW_RELEASE" != "true" ]]; then
    write_audit "post-chronicler-push" "$PROJECT_NAME" "$CURRENT_BRANCH" "" "skipped" "release branch blocked — set GIT_SYNC_ALLOW_RELEASE=true to allow"
    echo "[git-sync] release branch $CURRENT_BRANCH blocked. Set GIT_SYNC_ALLOW_RELEASE=true to allow." >&2
    exit 1
  fi
fi

# Branch mismatch guard
if [[ "$CURRENT_BRANCH" != "$BRANCH" ]]; then
  write_audit "post-chronicler-push" "$PROJECT_NAME" "$CURRENT_BRANCH" "" "error" "branch mismatch: state=$BRANCH actual=$CURRENT_BRANCH"
  echo "[git-sync] ERROR: branch mismatch (state file says $BRANCH, HEAD is on $CURRENT_BRANCH)" >&2
  exit 1
fi

# Working tree must be clean
DIRTY=$(git status --porcelain)
if [[ -n "$DIRTY" ]]; then
  write_audit "post-chronicler-push" "$PROJECT_NAME" "$BRANCH" "" "error" "dirty working tree — commit changes before auto-push fires"
  echo "[git-sync] ERROR: working tree is dirty. Commit or stash before auto-push runs." >&2
  exit 1
fi

# Remote must exist
if ! git remote get-url origin &>/dev/null; then
  write_audit "post-chronicler-push" "$PROJECT_NAME" "$BRANCH" "" "error" "no remote 'origin' configured"
  echo "[git-sync] ERROR: no remote 'origin' found for $PROJECT_PATH" >&2
  exit 1
fi

# Push — no --force, no --force-with-lease
PUSH_OUTPUT=$(git push origin "$BRANCH" 2>&1) || {
  PUSH_EXIT=$?
  SHA=$(git rev-parse HEAD)
  write_audit "post-chronicler-push" "$PROJECT_NAME" "$BRANCH" "$SHA" "error" "push rejected (exit $PUSH_EXIT): $PUSH_OUTPUT"
  echo "[git-sync] ERROR: push failed for $PROJECT_NAME/$BRANCH (exit $PUSH_EXIT)" >&2
  echo "$PUSH_OUTPUT" >&2
  exit 1
}

SHA=$(git rev-parse HEAD)
write_audit "post-chronicler-push" "$PROJECT_NAME" "$BRANCH" "$SHA" "success" ""
echo "[git-sync] pushed $SHA to $BRANCH for $PROJECT_NAME"
