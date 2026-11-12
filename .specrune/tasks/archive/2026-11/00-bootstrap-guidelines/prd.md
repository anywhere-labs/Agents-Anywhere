# Bootstrap Task: Fill Project Development Guidelines

**You (the AI) are running this task. The developer does not read this file.**

The developer just ran `specrune init` on this project for the first time. `.specrune/` now exists with empty spec scaffolding, and this task sits under `.specrune/tasks/`.

**Your job**: help them populate `.specrune/spec/` with the team's real coding conventions. Every future AI session — this project's `implement` and `check` sub-agents — auto-loads spec files listed in per-task jsonl manifests. Empty spec = sub-agents write generic code. Real spec = sub-agents match the team's actual patterns.

Don't dump instructions. Open with a short greeting, figure out whether the repo already has convention docs (CLAUDE.md, .cursorrules, CONTRIBUTING.md, …), and drive the rest conversationally.

---

## Status (update the checkboxes as you complete each item)

- [ ] Fill backend guidelines
- [ ] Fill frontend guidelines
- [ ] Remove templates that don't apply to this project
- [ ] Add code examples

---

## Templates are a starting point, not a contract

The scaffolded files listed below are a candidate set for a typical project of this type — not a checklist. Delete every template that has no counterpart in this repository: a backend with no database should not ship `.specrune/spec/backend/database-guidelines.md`, a frontend with no client state library should not ship `.specrune/spec/frontend/state-management.md`. A spec file describing something the project doesn't do is worse than a missing one — sub-agents read specs as ground truth and will invent architecture to match.

When you delete or rename a file, update that layer's `index.md` (the Guidelines Index table) so it lists only files that actually exist.

Exception: `.specrune/spec/guides/` ships pre-filled with general thinking guides. Keep it unless a guide clearly doesn't fit this project — that one is customize-or-remove, not fill.

---

## Spec files to populate (survivors of the step above)

### Backend guidelines

| File | What to document |
|------|------------------|
| `.specrune/spec/backend/directory-structure.md` | Where different file types go (routes, services, utils) |
| `.specrune/spec/backend/database-guidelines.md` | ORM, migrations, query patterns, naming conventions |
| `.specrune/spec/backend/error-handling.md` | How errors are caught, logged, and returned |
| `.specrune/spec/backend/logging-guidelines.md` | Log levels, format, what to log |
| `.specrune/spec/backend/quality-guidelines.md` | Code review standards, testing requirements |

### Frontend guidelines

| File | What to document |
|------|------------------|
| `.specrune/spec/frontend/directory-structure.md` | Component / page / hook organization |
| `.specrune/spec/frontend/component-guidelines.md` | Component patterns, props conventions |
| `.specrune/spec/frontend/hook-guidelines.md` | Custom hook naming and patterns |
| `.specrune/spec/frontend/state-management.md` | State library, patterns, what goes where |
| `.specrune/spec/frontend/type-safety.md` | Type conventions, type organization |
| `.specrune/spec/frontend/quality-guidelines.md` | Linting, testing, accessibility |

### Thinking guides (already populated)

`.specrune/spec/guides/` contains general thinking guides pre-filled with best practices. Customize them to this project, or remove a guide that clearly doesn't fit — then update `.specrune/spec/guides/index.md`.

---

## How to fill the spec

### Step 0: Use the spec-bootstrap skill if available (fastest path)

If a skill named `specrune-spec-bootstrap` is installed in this environment, invoke it and let it drive the whole population flow end to end — it owns repository analysis, spec boundary choices, doc writing, and verification against the real codebase. The steps below remain useful as the manual fallback and explain the principles either way.

### Step 1: Import from existing convention files first (preferred)

Search the repo for convention docs that already exist. If any do, read them and extract the relevant rules into the matching spec files — this is almost always faster, and more accurate, than documenting from scratch.

| File / Directory | Tool |
|------|------|
| `CLAUDE.md / CLAUDE.local.md` | Claude Code |
| `AGENTS.md` | Codex / Claude Code / agent-compatible tools |
| `.cursorrules` | Cursor |
| `.cursor/rules/*.mdc` | Cursor (rules directory) |
| `.windsurfrules` | Windsurf |
| `.clinerules` | Cline |
| `.github/copilot-instructions.md` | GitHub Copilot |
| `.vscode/settings.json → github.copilot.chat.codeGeneration.instructions` | VS Code Copilot |
| `CONVENTIONS.md / .aider.conf.yml` | aider |
| `CONTRIBUTING.md` | General project conventions |
| `.editorconfig` | Editor formatting rules |

### Step 2: Analyze the codebase for anything not covered by existing docs

Scan real code to discover patterns. Before writing each spec file:

- Find 2-3 real examples of each pattern in the codebase.
- Reference real file paths, not hypothetical ones.
- Document the anti-patterns the team clearly avoids.

### Step 3: Document reality, not ideals

**Critical**: write what the code *actually does*, not what it should do. Sub-agents match the spec, so aspirational patterns that don't exist in the codebase will cause sub-agents to write code that looks out of place.

If the team has known tech debt, document the current state. Improvement is a separate conversation, not a bootstrap concern.

---

## Quick explainer of the runtime (share when they ask "why do we need spec at all")

- Every AI coding task spawns two sub-agents: one that writes code and one that verifies quality against the spec.
- Each task carries `implement.jsonl` / `check.jsonl` manifests listing which spec files to load.
- The platform hook auto-injects those spec files plus the task's `prd.md` into every sub-agent prompt, so the sub-agent codes and reviews per team conventions without anyone pasting them manually.
- Source of truth: `.specrune/spec/`. That's why filling it well now pays off forever.

---

## Completion

When the developer confirms the checklist items above are done with real examples (not placeholders), guide them to run:

```bash
specrune task finish
specrune task archive 00-bootstrap-guidelines
```

After archive, every new developer who joins this project gets a `00-join-<slug>` onboarding task instead of this one.

---

## Suggested opening line

"Welcome! Your `specrune init` set me up to help you fill the project spec — a one-time setup so every future AI session follows the team's conventions instead of writing generic code. Before we start, do you have any existing convention docs (CLAUDE.md, .cursorrules, CONTRIBUTING.md, …) I can pull from, or should I scan the codebase from scratch?"
