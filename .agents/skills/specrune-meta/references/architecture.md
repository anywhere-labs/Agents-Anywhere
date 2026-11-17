# Local Architecture

SpecRune in a user project is four layers; the boundary tells you where a
change belongs.

## 1. Workflow — `.specrune/workflow.md`

Three phases (Plan / Execute / Finish) with numbered steps and two kinds of
content:

- **Parsed contracts**: the `## Phase Index` heading,
  `[workflow-state:<status>]` breadcrumb blocks and `#### N.M` step headings. The
  context compiler reads these for the per-turn breadcrumb (`specrune inject`)
  and step bodies (`specrune context --mode phase --step N.N`).
- **Prose**: everything else, freely rewritable.

Request triage lives here too: not every request deserves a task.

## 2. Persistence — `.specrune/`

- `spec/<package>/<layer>/` — code-specs; `index.md` points at the guideline
  files; `spec/guides/` holds cross-cutting checklists. Selected per task via
  manifests.
- `tasks/<MM-DD-slug>/` — `prd.md`, optional `design.md` / `implement.md`,
  `research/*.md`, and `implement.jsonl` / `check.jsonl` (one
  `{"file","reason"}` per line). Finished tasks move to `tasks/archive/<YYYY-MM>/`.
- `sessions/<id>.md` — one record per session, written by `specrune session
  record`. Legacy `workspace/<developer>/` journals are migrated by `import`.
  Raw conversations stay in the hosts' stores, queried via `specrune mem`.
- `config.yaml` — project configuration.
- `.runtime/sessions/<context-key>.json` — the per-session task binding; one per
  session, never inferred.

## 3. Platform — `.pi/`, `.opencode/`, `.codex/`, `.agents/`

Platform files adapt host events and output formats; task resolution, workflow
state, context compilation and snapshots stay in the shared Go CLI.

See `platform-files.md` for discovery, hook trust and managed paths.

## 4. Runtime services

- **Sub-agent dispatch** — the host launches the role from `.pi/agents/`,
  `.opencode/agents/` or `.codex/agents/`.
- **Memory** — `specrune mem`: read-only search over local host session logs;
  nothing is uploaded.
- **Lifecycle** — `update` / `uninstall` / `ablate` / `restore`, all driven by
  `.specrune/.template-hashes.json`.

## Customization principles

1. Local content beats defaults — read the project's files before editing.
2. Respect ownership — generated templates are ours until edited; spec, tasks
   and workspace are the user's from day one.
3. Keep parsed contracts intact when rewriting prose; a cosmetic edit that
   breaks `[workflow-state:*]` parsing silently kills injection.
