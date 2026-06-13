# DHS Vault Reader

Read-only access to `C:\CORE\Business\DHS-Vault\`.

This is the company's Obsidian vault. Use it to look up project specs, store
copy, brand decisions, FiveM build notes, and the original `dhs-hive-setup.md`.

## Hard blocks (refuse if asked)

- `C:\CORE\Business\Personal\` — never read, never list, never reference.
- `C:\CORE\Business\District77-Vault\` — never read, never list.
- Any directory under `C:\CORE\Business\` whose name contains `D77` or
  `District77`.

If a user asks you to read a path inside a hard block, refuse with: "That path
is excluded from the Lair's reach by policy. Nothing I can do there."

## What's in the vault (top-level orientation)

- `01-Company\`     — DHS company state: roles, finance, decisions.
- `02-Products\`    — per-script docs (one folder per FiveM resource).
- `03-Marketing\`   — store copy, Tebex listings, Discord templates.
- `04-Operations\`  — support workflows, recurring tasks.
- `05-Notes\`       — daily notes, working drafts.
- `dhs-hive-setup.md` — the original setup spec (this file's name predates the rebrand; superseded by this build).

Read at file granularity. Don't recursively dump entire folders unless asked
for something specific.

## How to use

```
Read tool: C:\CORE\Business\DHS-Vault\02-Products\<script>\<file>.md
Glob tool: C:\CORE\Business\DHS-Vault\02-Products\**\*.md
Grep tool: search for terms across the vault
```

Never write to the vault from the Lair.
