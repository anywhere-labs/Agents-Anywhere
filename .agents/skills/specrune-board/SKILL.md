---
name: specrune-board
description: Open the offline dashboard for `.specrune/` — contract blocks and req graph, tasks, sessions. Use for whole-repo overview, dangling-reference audits, one task side by side, or 看板/规范看板/离线看板/打开看板/board/dashboard.
---

# specrune-board

A single static HTML file that renders what SpecRune has already written to
disk. No server, no build step, no external scripts: open the file and hand it
a repository. It is strictly **read-only** — it never writes to the repository,
never calls `createWritable`, and sends nothing anywhere.

Reach for it when you want:

- the whole picture at once instead of grepping file by file — contract-block
  counts, active vs archived tasks, session timeline
- an audit of the `req:` reference graph — which contract blocks nothing
  points at, and which references are dangling
- one task's artifacts side by side (its `prd` / `design` / `implement`, its
  `research/*.md`, and its `implement.jsonl` / `check.jsonl` manifests)
- an earlier session's Summary / Next Steps in readable form

## How to use it

1. Open `assets/specrune-board.html` in Chrome or Edge. Double-clicking the
   file is fine; it works from a `file://` URL with no HTTP server.
2. Click **选择目录** and pick either the repository root or the `.specrune`
   directory itself. Once a directory reads successfully, the board remembers
   that handle, so reopening the same file reloads the repository
   automatically. It reads on load and on demand only; it never watches the
   disk.
3. Read the four tabs — 总览 / 规范 / 任务 / 会话. Press `/` to focus the
   cross-cutting search.

Data on disk is written by the CLI in batches at session boundaries, so the
board does **not** poll. After running CLI commands that changed the tree,
click **重新扫描** (direct-read mode only).

## What it reads

| Data | On-disk source | Notes |
|---|---|---|
| Specs | `.specrune/spec/<pkg>/<layer>/*.md` | Optional frontmatter, `{#slug}` contract-block anchors, and `req:<file>#<slug>` references |
| Tasks | `.specrune/tasks/<MM-DD-slug>/` and `tasks/archive/<YYYY-MM>/` | `task.json` keys, `prd` / `design` / `implement`, `research/*.md`, both jsonl manifests |
| Sessions | `.specrune/sessions/<id>.md` | Frontmatter plus the journal-shaped body sections |

Two behaviours worth knowing:

- **Malformed session records are skipped, not fatal.** A record missing its
  closing `---` or its `id` is counted and reported as skipped; everything else
  still loads.
- **A task's own artifacts are counted as reference sources.** A `req:` anchor
  written in a task's `prd.md` resolves to the contract block it names, and the
  board labels such references `任务` so they are not confused with
  spec-internal ones. In-degree is shown split as `规范 / 任务`.

## Limits

Read [references/limits.md](references/limits.md) before relying on the board
for browser support, directory memory, read-only scope, data it does not read,
or dangling-detection caveats. The board is snapshot-oriented, so a stale
view is the normal failure mode, not an exception.

