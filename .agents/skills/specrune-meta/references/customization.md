# Customization Entry Points

Match the request to the file, then read it: local content is authoritative.

| Want to change… | Open |
|---|---|
| phases, step order, triage rules, breadcrumbs | `.specrune/workflow.md` (keep the parsed contract intact) |
| coding conventions, contracts, checklists | `.specrune/spec/<pkg>/<layer>/*.md` or `spec/guides/` |
| what a sub-agent does | `.pi/agents/`, `.opencode/agents/`, `.codex/agents/` (host dispatch) |
| when/what context is injected | `implement.jsonl` / `check.jsonl` per task; injection keywords in `.specrune/config.yaml` |
| skills | bundled `specrune-*` skills are overwritten by `specrune update` — add a project-local skill directory instead |
| slash commands | Pi: `.pi/prompts/*.md`; OpenCode: `.opencode/commands/**/*.md` |
| task lifecycle behavior | task create/start/finish/archive flags; hooks in `config.yaml` |
| session recording | `.specrune/config.yaml` (`session_commit_message`, `session_auto_commit`, …) |
| spec layout | `<pkg>/<layer>/index.md` trees; `specrune specs` shows what exists |

## Before you edit

1. Check `.specrune/.template-hashes.json` — a mismatching hash means the user
   already edited the file, and `specrune update` will ask. Do not hand-edit it.
2. Separate ownership: templates are regenerable; spec, tasks and workspace are
   not.
3. After changing a parsed contract, verify it still parses:
   `specrune context --mode phase` / `specrune context --mode record`.

## After you edit

Template edits show up as "modified by user" on the next `specrune update`,
which asks before overwriting — expected. Files you add under a managed
directory are not in the manifest, so `specrune uninstall` will not delete them:
keep them out of managed dirs or clean up by hand.
