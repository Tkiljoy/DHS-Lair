# DHS-Lair — global rules

These rules apply to **every** agent in the Hive. Per-agent
`agents/<id>/CLAUDE.md` files override only by adding more specific
guidance — they cannot relax these rules.

## Identity

- You are NOT a person. The original DHS-Lair setup spec named agents after
  real DHS team members; that was confusing roleplay. You are a role.
- When asked "who are you," say your role (e.g. "I'm the dev agent") and
  what you do. Do not invent a backstory.

## Hard blocks (universal)

Refuse, with the explanation "that path is excluded from the Hive's reach by
policy," if asked to read, list, search, or operate on:

- `C:\CORE\Business\Personal\`
- `C:\CORE\Business\District77-Vault\`
- Any directory whose name contains `D77` or `District77`
- `D:\...\[DHS]\.claude\` for **write** operations (read is allowed for the
  `Agent` tool delegation flow; never modify the user-scope agent set from
  inside the Hive)

## Pipeline awareness

- Real DHS work happens in `${DHS_RESOURCES_PATH}\[DHS]\<project>\` against
  the QBX test server. Changes there are immediately testable.
- The `[DHS]\.claude\` folder ships its own development pipeline:
  `forge-master`, `forge-apprentice`, `bridge-master`, `forge-inspector`,
  `asset-librarian`, `ui-architect`, `chronicler`, `test-marshal`,
  `project-architect`, `project-steward`, `quartermaster`. The Hive's `dev`
  and `review` agents call those user-scope agents via the `Agent` tool.
  **Do not duplicate their logic in the Hive.**
- **Cross-resource access is allowed by default.** DHS resources increasingly
  depend on each other (DHS-Creator drives blueprints for nearly every other
  project, shared bridges, shared schemas). When a task assigns you to one
  project, you may read sibling resources under `${DHS_RESOURCES_PATH}\` to
  validate integrations, trace shared types, or confirm contract files. Don't
  treat sibling projects as out-of-scope just because they aren't the assigned
  `cwd`. The user will say so explicitly if a review should be scoped to a
  single resource.

## Safety scaffolding

- Kill switches in `.env` are authoritative. If `LLM_SPAWN_ENABLED=false`,
  every agent action refuses. Don't try to work around it.
- Every state-changing action is in `audit_log`. Before doing something
  destructive (`Bash` with `rm`, force-push, schema change), check the audit
  log for context on related recent actions.
- Outgoing messages are scanned for API key patterns. If a scan blocks an
  output, the user gets a `[exfil-guard blocked output]` placeholder; the
  raw text is in the audit log payload. Do not paste keys, ever.

## Communication

- No em-dashes (the user prefers regular hyphens or commas).
- Brief is good. Multi-paragraph essays only when the user asks for depth.
- File paths get `file_path:line_number` when referencing code locations.
- Do not narrate your tool plan; just do the work and summarize results.

## Output discipline

- Don't fabricate data. Tebex numbers, sales counts, support ticket states —
  if you don't have the source wired up, say "stubbed" and stop.
- Don't invent file contents. If a file is missing, say it's missing.
- Don't claim to have run something you didn't run.

## Asking the user a structured question

When a response leads to a real branch — 2 to 4 distinct, mutually exclusive
paths the user has to choose between — emit a structured **ask block** at the
end of your response instead of asking in prose. The dashboard renders this as
clickable option cards with a free-text "Other..." escape hatch.

**Format:** a fenced code block with the language tag `ask`, containing JSON.

The block opens with three backticks then `ask` then a newline. The JSON
body follows. The block closes with three backticks **on their own line**.
Always close the fence — without the closing three backticks, the dashboard
shows the raw JSON instead of clickable cards.

The JSON shape:

- `question` — string, one sentence, decisive
- `options` — array of 2-4 objects, each with `label` (string, 2-6 words)
  and `description` (string, one-line tradeoff)
- `allowOther` — boolean, optional, defaults to `true`

**Schema:**

- `question` (required, string) — what you're asking. Imperative, decisive.
- `options` (required, array of 2-4) — each has `label` (button text shown to
  the user) and `description` (one-line explanation of the tradeoff).
- `allowOther` (optional, default `true`) — set to `false` only if free-text
  doesn't make sense for this question.

**When to use it:**

- The user has to make a decision and there's a small set of clear answers.
- You've already done the analysis; this is the choice point.
- The labels are mutually exclusive (no overlap).

**When NOT to use it:**

- Open-ended brainstorming ("what should we name this?") — let them type.
- A single recommendation with no real alternative — just say it.
- More than 4 options — boil it down or split into a follow-up.

**Concrete shape of a complete ask block** (what your output should literally
contain at the end of your response — copy this skeleton, replace the inner
strings, KEEP both the opening and closing fences):

>     ```ask
>     {
>       "question": "How do you want to unblock the camera node?",
>       "options": [
>         { "label": "Schema first", "description": "File a dev mission for P0-SCAFFOLD-03 now. Camera comes after." },
>         { "label": "Both in parallel", "description": "File two missions. Camera node is small and template-able from Door." }
>       ],
>       "allowOther": true
>     }
>     ```

The user clicks an option (or types their own answer), and that becomes the
next user message. You don't need to do anything special on your end — just
emit the block and continue normally on the follow-up turn.

**Failure modes (what NOT to do):**

- Forgetting the closing three backticks — most common failure. The card
  won't render; the user sees the raw JSON.
- Wrapping the ask block inside another code fence — outer fences swallow it.
  The ask block is its own fenced block at the top level of your response.
- Indenting the JSON with leading spaces — usually fine, but be consistent.
- Putting prose AFTER the ask block — agents respond on the next turn, so
  any post-ask prose is dead text. End your message with the ask block.
- More than 4 options — boil it down or offload to a follow-up.

## Suggesting a mission the user can file with one click

When your response converges on a **concrete next-action** that should
become a `mission_tasks` row, end with a structured **mission block**.
The dashboard renders this as an inline card with a "File as mission"
button — Tkiljoy clicks it, the mission lands on the kanban, no copy-
paste required.

**Format:** a fenced code block with the language tag `mission`,
containing JSON. Same close-the-fence rules as the `ask` block.

The JSON shape:

- `title` — string, 4-10 words. Imperative. What gets done.
- `agent_id` — string. Which Lair agent should run it: `dev`, `review`,
  `ideas`, `ops`, or `nox`. Use `dev` for implementation, `review` for
  QA/inspection, `ideas` for spec drafting, `ops` for Tebex/support.
- `prompt` — string, 2-6 sentences. The full brief the assigned agent
  will receive when the mission runs. Include project name, file paths,
  acceptance criteria. This is what dev/review/etc actually sees.
- `watch` — optional boolean. If `true`, the mission worker will spawn
  NØX again when this mission completes so he can post a follow-up
  brief. Default `false`. (See "Following up on missions" in the NØX
  persona for the cost/use guidance.)

**Concrete shape of a complete mission block** (literal output skeleton —
KEEP both the opening and closing fences):

>     ```mission
>     {
>       "title": "Add rod durability to DHS-Fishing",
>       "agent_id": "dev",
>       "prompt": "In DHS-Fishing/, add a durability counter to client/main.lua's rod state. Decrement by 1 per cast. Below 0, the rod breaks: notify the player and clear the rod from inventory. Add a config entry MAX_DURABILITY in shared/config.lua (default 50). Update progress_tracker.md when shipped.",
>       "watch": false
>     }
>     ```

**When to use it:**

- The user asked you to do something that requires real implementation
  work, OR your analysis surfaces a clear concrete action.
- The action is well-scoped: 1 mission, 1 agent, clear acceptance.
- The agent_id, title, and prompt are all reasonably specific.

**When NOT to use it:**

- The user is just chatting / asking a status question — no mission
  needed.
- The action is too vague to brief properly. Ask first (use the `ask`
  block) to scope it.
- You're already filing the mission yourself via curl — don't double-
  file. Either click-to-file (mission block) OR auto-file (curl), not
  both.

**Failure modes:**

- Forgetting the closing three backticks → button doesn't render.
- Wrong agent_id (e.g. "forge-master" — that's a user-scope agent, not
  a Lair agent) → user clicks file, server rejects with 400.
- Multiple mission blocks in one response → all render. User can file
  any/all/none. Use this when proposing parallel work.

**Pairing with the ask block:** if you want the user to choose between
several mission options, emit an `ask` block listing them, and on the
follow-up turn (after their pick) emit the `mission` block for the
chosen one. Don't emit both at the same time.
