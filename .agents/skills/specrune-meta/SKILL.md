---
name: specrune-meta
description: Understand and customize SpecRune — .specrune/ structure, workflow, tasks, specs, workspace, platform files, skills, commands, agents, injection, and specrune mem. Use when modifying any generated file or mechanism.
---

# specrune-meta

For projects where `specrune init` has been run: understand the local SpecRune
architecture and its customization entry points well enough to modify generated
files on request. The installed files are the extension surface; the SpecRune
source repository is not assumed available.

## Operating scope

- `.specrune/` — workflow, config, tasks, spec, workspace, runtime state, and
  the manifest `.specrune/.template-hashes.json`.
- Platform directories — `.pi/` (agents, prompts, extension, settings.json),
  `.opencode/` (agents, commands, plugin), `.codex/` (hooks, task agents).
- Shared skill layer — `.agents/skills/`; projects may host their own skills
  there too.
- Outside the project tree (user-owned, never written): the hosts' own session
  stores, read via `specrune mem`.

The SpecRune source repository is not assumed available — the local files are
the extension surface.

## How to use

1. Read `references/architecture.md` first.
2. Host-specific request → `references/platform-files.md`.
3. "Change how X works" → `references/customization.md`.
4. Task state → `specrune task list` / `specrune task current`. `task list`
   defaults to active tasks, the first 20 rows and a count for the rest;
   `--all` includes archived tasks and expands the full list.
5. Before editing, read the actual files — local content is authoritative.

## Key rules

- `.specrune/workflow.md` is the local workflow source of truth. Its
  `## Phase Index` heading, `[workflow-state:*]` blocks and `#### N.M` step
  headings are parsed contracts; the prose is yours to rewrite.
- `.specrune/spec/`, `tasks/` and `workspace/` are user data: `update` never
  overwrites them, `uninstall` deletes them only with an explicit warning.
- `.specrune/.template-hashes.json` is management state — a mismatch means "user
  edited this", turning the next update into a question. Do not hand-edit it.
- Bundled `specrune-*` skills and commands are rewritten by `specrune update`.
  Project rules belong in `.specrune/spec/`, a project-local skill, or the
  current task.
- Platform files decide what runs: `.pi/settings.json` mounts the extension and
  prompts; OpenCode discovers its plugin by path; Codex reads `.codex/hooks.json`
  after the hooks are trusted with `/hooks`.
- Lifecycle: `update` three-way merges templates, `uninstall` deletes only
  manifest entries, `ablate` / `restore` snapshot and restore managed paths.

## Do not

- Do not modify a global npm install or the upstream source; extend the
  local files.
- Do not overwrite user-modified local files without checking the manifest
  first.
- Do not describe mechanisms the installed CLI does not have; cross-check
  `specrune help` and `.specrune/workflow.md`.
