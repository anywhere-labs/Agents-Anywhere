---
name: specrune-review
description: Quality check changes against task requirements and specs. Use to review or verify recent changes, when implementation is done but unverified, or before committing. Sub-agents dispatch specrune-check; main session only.
---

# specrune-review

Verify recently written code: spec compliance, cross-layer safety, pre-commit
checks.

## Step 1: Identify what changed

```bash
git diff --name-only HEAD
git status
```

## Step 2: Read requirements and specs

Read the current task's artifacts (`prd.md`, then `design.md` /
`implement.md` when present), then for each changed package/layer read its
spec index and follow the quality checklist it points at:

```bash
specrune task show <task>
specrune packages
cat .specrune/spec/<package>/<layer>/index.md
```

## Step 3: Run project checks

Run the lint, type-check and test commands. Fix failures before going on.

## Step 4: Review against the checklist

**Code quality** — linter, type checker and tests pass; no debug logging left
in; no suppressed warnings or type-safety bypasses.

**Test coverage** — new function → unit test; bug fix → regression test;
changed behavior → existing tests updated.

**Spec sync** — if this change taught something non-obvious, load
`specrune-update-spec`. The wrap-up itself (record the session, then archive)
belongs to `specrune-finish-work`, not here.

**Scope discipline** — no tidying the task did not require, no abstraction or
extension point for a case that does not exist, no fallback for a state that
cannot occur, no file the acceptance criteria do not mention, no workaround
piled at the caller when the behavior lives elsewhere.

## Step 5: Cross-layer dimensions (skip if single-layer)

- **Data flow** — trace one read path and one write path end to end; types,
  schemas and errors pass cleanly between layers.
- **Code reuse** — existing similar code searched before adding new; a repeated
  value extracted only when it is one concept whose callers must change
  together.
- **Imports** — correct paths, no cycles.
- **Same-layer consistency** — other places using the same concept behave the
  same way.

## Step 6: Report and fix

Report every violation. Then split:

- **Mechanical and local** (lint nit, missing type, wrong import, dead branch,
  failing assertion) → fix in place, re-run the checks.
- **Design or judgment** (naming a shared concept, moving a module boundary,
  changing a public interface, reassigning where behavior lives) → record the
  evidence and your recommendation, and stop. Do not rewrite it silently.

If a fix would touch files outside the task's scope, say so and stop.
