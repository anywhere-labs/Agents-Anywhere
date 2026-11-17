---
name: specrune-update-spec
description: Capture a learned contract, convention or gotcha into .specrune/spec/. Use after a task, bug fix, or when future sessions must know it. Recall "how did we solve X last time", "have we discussed this before", 上次怎么解的, 之前讨论过吗.
---

# specrune-update-spec

Promote what you learned — from debugging, implementing or discussion — into
the project's specs. Do it when the insight is fresh; the workflow's scheduled
spec-update step is only a checkpoint for what was already learned.

## Code-spec first rule

"Spec" means **code-spec**: executable contracts, not principle prose —
signatures, payload fields, env keys, boundary behavior, testable error
behavior.

Code-spec depth is **mandatory** when the change involves a new/changed
command or API signature, a cross-layer request/response contract, a database
schema or migration, or infra integration (storage, queue, cache, secrets, env
wiring). A triggered update carries scope/trigger, signatures, contracts,
validation & error matrix, good/base/bad cases, required tests with assertion
points, and one wrong-vs-correct pair. The required section shape is in
[references/code-spec-shape.md](references/code-spec-shape.md).

## Process

1. **Name what you learned** — the fact, what it prevents, where it belongs.
2. **Classify it** — design decision / convention / pattern / forbidden
   pattern / common mistake / gotcha.
3. **Search before you write.** A second description is a duplicate or a
   conflict; decide which before writing.
   - Pull out the identifying tokens: command / flag / env key / path /
     function name, and the `{#slug}` you intend to use.
   - `rg -n '<token>' .specrune/spec/` — contracts in force now.
   - `specrune session log --grep '<token>'` — how it was decided before.
   - `specrune mem search '<token>'` — the original conversation behind a
     decision.
   - Start with `session log` (committed markdown, cheap, deterministic);
     escalate to `mem` only for reasoning. Say where you looked; a silent
     "I searched" is indistinguishable from not searching.
   - Classify every hit: same subject and rules → extend the block or add a
     `req:` pointer, do not duplicate; same subject, different rules →
     **conflict**, pick the authority, turn the loser into a `req:` pointer or
     mark it deprecated, write the supersedes line; same word, different
     subject → not a conflict, proceed.
   - This is targeted, not an audit. For "is the spec still coherent overall",
     run `specrune-spec-health` first.
   - Pure recall stops once the sources answer; the two-sources table, command
     shapes and stop rules are in [references/recall.md](references/recall.md).
     Skip the search when the context is already in this turn, `prd.md`, recent
     `git log`, or open files — or when you are a sub-agent whose dispatch
     prompt already carries the curated manifests.
   **Before adding a block, check whether the subject already has a retired
   block.** If it does, extend the live block, or replace the retired block's
   body with a pointer and put the new content in the live one — do not open a
   third block beside them. Two blocks on one subject is how a spec starts
   contradicting itself; `anchor-duplicate` and `retired-budget` catch it after
   the fact, but a gate firing is more expensive than checking here.
4. **Read the target file first** — structure, duplicates, the right section.
5. **Write it concrete** — a real example, a `file` + symbol anchor (never a
   line number — see the language guides below), the why, and the contract when
   the mandatory trigger applies. One concept per section. Replacing an
   existing block: write `取代：req:<file>#<slug>` (comma-separate several;
   cross-layer `req:<layer>/<file>#<slug>`) and turn the old block into a
   `req:` pointer or add
   `> 已被 req:<file>#<slug> 取代（<date>）；正文保留为历史。` The label is for
   readers; the `req:` tokens are what the gate checks. The layer's `index.md`
   holds the authoritative form.
6. **Update the index** if you added a section.

When writing references into a spec, read the language guide for the code you
are citing — [references/go.md](references/go.md) for Go, or
[references/typescript.md](references/typescript.md) for TypeScript and
JavaScript. Each covers which reference shapes stay checkable and which rot.

## Where it goes

Implemented feature → the relevant spec file; design decision → the spec's
design-decisions section; subtle bug fix → common-mistakes; reusable pattern →
patterns; gotcha → a warning callout; team convention → quality guidelines;
thinking trigger → a `guides/` checklist. "How to write the code" belongs in a
spec layer; "what to consider before writing" belongs in `guides/`, pointing at
specs and never duplicating them. Spec frontmatter (scope/globs/tags) is
display only; injection is chosen by hand via `implement.jsonl` /
`check.jsonl`. [references/targets.md](references/targets.md) holds the full
routing table.

## Out of scope

A spec is read on every injection. One-off implementation details and
typo-level changes are noise; project-wide rules found in one task's history
should be promoted here; **decision process** stays in the session record or
`design.md` with at most a one-line pointer; **unfixed findings** become their
own task or `task.json` `notes`; **self-reports of absence** ("not yet
reviewed", "to be filled") are not contracts — say what you verified instead.
