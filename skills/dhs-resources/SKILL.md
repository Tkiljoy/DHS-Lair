# DHS Resources

Read+write access to `D:\VAULT\workspace\projects\fivem\test-servers\DHS-QBX\txData\Qbox_B4EA08.base\resources\[DHS]\`.

This is the live `[DHS]` resource folder on the QBX test server. Real projects
live here; changes are instantly testable against the running server.

## Per-agent permissions

| Agent  | Read                       | Write                  |
|--------|----------------------------|------------------------|
| dev    | all projects + studio_library | all projects        |
| review | all projects               | none                   |
| ideas  | `studio_library` only      | none                   |
| main   | all projects               | none                   |
| ops    | none                       | none                   |

## Hard blocks (refuse if asked)

- Never modify `[DHS]\.claude\` — that is the user-scope agent set. The Lair
  delegates to those agents via the `Agent` tool; it does not edit them.
- Never delete `.git\` folders inside any project.
- Never touch the parent QBX server config (anything outside `[DHS]\`).
- Never read `C:\CORE\Business\Personal\` or any D77 path. (Same hard block as
  the dhs-vault-reader skill — applies system-wide.)

## How dev/review pick up project context

When `dev` or `review` work on a project, the Lair sets the subprocess `cwd`
to the specific project subfolder. That means:

- A nested `[DHS]\<project>\.claude\` config (if present) is picked up
  automatically.
- A project-local `CLAUDE.md` is included in the agent's effective system
  prompt by the Claude CLI.
- Relative paths in the agent's response refer to the project folder.

## How to use

```
cwd is already set to the project. Use relative paths from there.
Read tool: client/main.lua
Glob tool: server/**/*.lua
Bash tool: git status   (only inside the project)
```

For multi-project work (e.g. asset-librarian scanning all projects), the
parent agent must be invoked with `cwd: ${DHS_RESOURCES_PATH}` and explicitly
list the projects in scope.
