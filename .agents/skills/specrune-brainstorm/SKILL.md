---
name: specrune-brainstorm
description: Turn a request into requirements and planning artifacts. Use when requirements are unclear, prd.md is missing or stale, before task start, or asked to brainstorm/refine scope.
---

# specrune-brainstorm

## Planning contract (non-negotiable)

- Build, implement, fix, refactor, or "go ahead" is not approval to leave
  planning; task-creation consent is not implementation approval either.
- Every non-trivial task needs at least one user response after the request;
  with nothing to clarify, that response must approve the final planning
  summary below.
- While a user-owned product, scope, UX, compatibility, risk, or acceptance
  decision is unresolved: end the turn with exactly one highest-value
  question; do not edit product code or run `specrune task start`.

## Evidence rule (non-negotiable)

If the repository can answer it — code, tests, configs, docs, specs, task
history, past sessions — explore instead of asking. Ask only for product
intent, preference, scope, risk tolerance, or decisions inspection leaves
ambiguous. Existing patterns are evidence, not decisions.

## Preconditions

Use after task-creation consent, when ready to plan.
With no task yet:

```bash
specrune task create "<title>" --slug <ascii-slug> --description "<summary>"
```

All are required; `--slug` is ASCII letters, digits and hyphens. `create`
scaffolds `prd.md`; fill it in before follow-ups.

## Decomposition decision (gate, not advice)

`specrune task start` refuses a task with no children, no `decompose_reason`,
and more than 5 checkboxes under `## 验收标准` / `## Acceptance Criteria` or
more than 3 list items under `## 交付物` / `## Deliverables`. Parsing failure
counts as zero and never blocks — the reason is required either way; override
per task with `task set-meta <task> decompose_threshold "<acc>/<del>"`.

Decide before writing `prd.md`, then pick one shape: one task (with reason),
parent plus ordered children, or unrelated siblings.
[references/decomposition.md](references/decomposition.md) holds the commands
and rules.

## Planning flow

1. Capture the request and initial facts in `prd.md`.
2. Record the decomposition verdict before requirements: children, or one
   `decompose_reason`. Revisit if the PRD grows past the threshold — `task
   start` will refuse it.
3. Inspect evidence: code, tests, configs, docs, specs, related tasks and
   research, `session log --grep`, `mem search` (two-sources table: update-spec
   step 3). If it needs 5+ files, leaves the repo, or crowds out this
   session's context, dispatch a `specrune-research` sub-agent (one question
   each) after `specrune dispatch <slug>` — ledger:
   [references/dispatch.md](references/dispatch.md). On a Codex host, read
   [references/codex-dispatch.md](references/codex-dispatch.md) first.
4. Sort findings into confirmed facts / open product intent / open scope-risk
   decisions / out-of-scope. Apply both checklists from
   [references/coverage-checklists.md](references/coverage-checklists.md). If
   scope widens past the threshold, go back to step 2.
5. If a user-owned decision remains, ask one highest-value question with your
   recommendation and the trade-off, then stop; no implementation this turn.
6. After each answer, update `prd.md`, recompute the inventory, and repeat
   from step 4.
7. With no decision left, create or update `design.md` / `implement.md` for
   complex tasks.
8. Run the convergence gates, present the summary, and stop. Only explicit
   approval authorizes `specrune task start` and implementation; repeat the
   final review if artifacts change.

## Question rules

One question per message: the decision, why it matters, your recommendation,
and the trade-off. Do not ask process questions ("should I search?") — do the
evidence work. Never choose a product decision for the user. When evidence and
the request resolve everything, go to the final summary — still requires
explicit approval. Intent questions ("what are you trying to achieve?", "what
would make this a failure?") are **open-ended**: no option menu that anchors
the user. Recommendation plus trade-off is for genuinely exclusive options,
not for discovering intent.

## Artifact rules

- `prd.md` — **Goal**, **Confirmed Facts**, **Requirements**, **Acceptance
  Criteria**, **Out of Scope**, **Open Questions**. The two headings must be
  exactly `## 验收标准` (or `## Acceptance Criteria`) and `## 交付物` (or
  `## Deliverables`); `- [ ]` items for acceptance, plain `-` / `1.`
  deliverables; any other heading counts zero.
- `design.md` (complex tasks) — architecture/boundaries, data flow/contracts,
  compatibility/migration, trade-offs, rollback. One section must be headed
  exactly `## 备选方案` (or `## Alternatives considered`); `task start` refuses
  design.md without it.
- `implement.md` (complex tasks) — ordered checklist, validation commands,
  risky files/rollback points, pre-start checks; not a manifest replacement.

Lightweight tasks may stay PRD-only. Complex tasks need all three artifacts;
both manifests need one real spec/research entry before `task start` (commands
in [references/artifacts.md](references/artifacts.md)). Empty manifests are
refused unless `--allow-empty-context`.

## Convergence gates

Before presenting the final summary, verify:

- user outcome, product value, and in/out-of-scope behavior are explicit
- the decomposition decision is recorded (children, or `decompose_reason`)
- acceptance criteria describe observable outcomes
- user-owned product/scope/UX/compatibility/risk decisions are resolved
- blocking open questions are empty and anti-goals are explicit — what would
  make this delivery a failure even if it runs
- technical unknowns researched (a `specrune-research` dispatch counts) or
  deferred without changing MVP behavior
- `prd.md` convergence pass: repeated facts collapsed, no lost anchors,
  decisions, or acceptance mappings
- every `## Coverage taxonomy` class covered or deferred, each deferred item
  recorded in `## Open Questions` / `## Out of Scope`
- the `## Implicit requirements sweep` walked row by row, each row applied /
  not-applying / deferred — no blanks

Checklists: [references/coverage-checklists.md](references/coverage-checklists.md);
these gates restate them as pass/fail. The final summary shows Goal, In Scope,
Out of Scope, Acceptance Criteria, Key Decisions, Risks / Deferred items, and
artifact status.
