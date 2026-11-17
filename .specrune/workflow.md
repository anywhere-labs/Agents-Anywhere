# Development Workflow

This document defines how a development session runs in this repository. It is
read by the AI at session start and parsed by tooling for the per-turn state
breadcrumb. Change it deliberately — the blocks below are load-bearing.

## Core Principles

1. **Specs before code.** Spec files under `.specrune/spec/` describe how this project
   does things. Read the relevant ones before writing code that touches them.
2. **One active task at a time.** Work is scoped to a task. The per-turn
   breadcrumb reports which one, and its state decides what happens next.
3. **Artifacts are the handoff.** Requirements, design and plan live in the task
   directory as markdown. They are the contract between planning and execution.
4. **Context is curated, not dumped.** Sub-agents receive exactly the spec and
   research files listed in their jsonl manifest. Adding a file to a manifest is
   a deliberate act.

## SpecRune System

### Developer Identity

`.specrune/.developer` holds your name and is gitignored — identity is per person,
not per project. In a linked git worktree the file is read from the main
checkout, so `git worktree add` does not lose it.

Override with the `SPECRUNE_DEVELOPER` environment variable. Tasks record both a
`creator` and an `assignee`; assignee defaults to you.

### Spec System

```
.specrune/spec/<package>/<layer>/index.md    spec entry point for one layer
.specrune/spec/guides/index.md               cross-cutting thinking guides
```

Spec files are plain markdown with no frontmatter. A file named `index.md` is an
entry point and may carry a `## Guidelines Index` table linking to sibling files;
those links are followed when the index is injected.

Package is omitted in a single-repo project. Declare `packages:` in
`config.yaml` to scope specs per package in a monorepo.

### Task System

```
.specrune/tasks/<MM-DD-slug>/
  task.json          metadata (status, assignee, parent/children, branch)
  prd.md             requirements and acceptance criteria
  design.md          technical design          (complex tasks)
  implement.md       execution plan            (complex tasks)
  implement.jsonl    context manifest for the implement sub-agent
  check.jsonl        context manifest for the check sub-agent
  research/          research output
.specrune/tasks/archive/<YYYY-MM>/...            archived tasks
```

`implement.jsonl` and `check.jsonl` are seeded empty on sub-agent-capable
platforms and curated during planning: one JSON object per line,
`{"file": "<path>", "reason": "<why>"}`. Spec and research documents only —
never code paths.

### Session Records

```
.specrune/sessions/<id>.md     one authoritative record per session
```

Each finished session writes its own file. The record is the authoritative
memory of what happened, written at the end of a session. It is not a changelog
of code — that is what git history is for. Read it back with
`specrune session log`. Legacy `workspace/<developer>/` journals and indexes
are migrated into these records by `specrune import`; the runtime reads
records only, and no index file is generated.

### Active Task

The active task is a **session-scoped pointer**, stored at
`.specrune/.runtime/sessions/<context-key>.json`. The context key is derived from the
platform and that session's own id.

There is no fallback and no guessing. If a session has no identity, it has no
active task, and every command says so plainly. Inferring "the active task"
from how many session files happen to exist is how a session ends up writing to
another session's task.

## Phase Index

The three phases below are the whole workflow. Each has a step list; steps
marked `[required]` are gates, the rest are tool calls you reach for when the
task needs them.

### Request Triage

Not every request is a task. Fix a typo, answer a question, adjust a comment —
just do it. Create a task when the work has requirements worth writing down and
an outcome someone can accept or reject.

### Planning Artifacts

A lightweight task can stay PRD-only. Add `design.md` when there is a real
technical decision to make, and `implement.md` when execution needs an ordered
plan. Adding an artifact you will not use is worse than not adding it.

### Parent / Child Task Trees

A task that is too large to finish in one session becomes a parent with child
tasks. Children are full tasks: they get their own directory, their own
artifacts, their own manifest. The parent tracks progress and nothing else.

<!-- Per-turn breadcrumb: no active task (before Phase 1) -->
```
[workflow-state:no_task]
No active task. Unclear scope or a new feature: load specrune-brainstorm first —
a task needs a real slug and description, never one invented from a guess.
Task-shaped: specrune task create "<title>" --slug <ascii-slug> --description "<what it delivers>"
Over 5 acceptance criteria or 3 deliverables: split into children, or one
specrune task set-decompose <task> "<why>". Simple questions/typos: just do them.
[/workflow-state:no_task]
```

<!-- Per-turn breadcrumb: subagent session without its own task pointer -->
```
[workflow-state:delegated]
You are a subagent session: your task context arrives in the curated prompt,
not via a session pointer. Do not create, start, finish, or set the status of
tasks - that belongs to the main session. If reality contradicts this block,
report the mismatch to the main session and continue your assigned work. Do
not invent a task to fix it.
[/workflow-state:delegated]
```

### Phase 1: Plan

Understand the request, write it down, gather the context the executor will
need, then activate the task.

<!-- Per-turn breadcrumb: Phase 1 (status='planning') -->
```
[workflow-state:planning]
Phase 1 — Plan. Active task: {task}
Step 1.1 load specrune-brainstorm; write prd.md with checkable acceptance
criteria, and add design.md for real technical decisions.
Step 1.3 curate implement.jsonl / check.jsonl (specrune task add-context).
Step 1.4 specrune task start activates. Step text: specrune context --mode phase --step N.N
No implementation code in this phase.
[/workflow-state:planning]
```

<!-- Per-turn breadcrumb: Phase 1 with dispatch.mode=inline -->
```
[workflow-state:planning-inline]
Phase 1 — Plan (inline mode). Active task: {task}
Step 1.1 — load the specrune-brainstorm skill; fill prd.md, add design.md when needed.
Inline mode reads spec files directly instead of via jsonl manifests, but still
curate the manifests at step 1.3. Step 1.4 activates with specrune task start.
Full text of any step: specrune context --mode phase --step N.N
Do not write implementation code in this phase.
[/workflow-state:planning-inline]
```

### Phase 2: Execute

Implement against the specs and the plan, then check the result against both.

<!-- Per-turn breadcrumb: Phase 2/3 (status='in_progress') -->
```
[workflow-state:in_progress]
Phase 2 — Execute. Active task: {task}
Step 2.1 load specrune-before-dev, dispatch specrune-implement; add missing context to implement.jsonl.
Step 2.2 dispatch a fresh specrune-check; findings go to review.md.
Step 2.3 dispatch specrune-implement to fix open findings, then repeat 2.2-2.3.
Green: no new blocker/major, every old finding closed; then specrune task finish (Phase 3).
Full text: specrune context --mode phase --step N.N
[/workflow-state:in_progress]
```

<!-- Per-turn breadcrumb: Phase 2/3 with dispatch.mode=inline -->
```
[workflow-state:in_progress-inline]
Phase 2 — Execute (inline mode). Active task: {task}
Load specrune-before-dev; do steps 2.1-2.3 yourself in this session — no sub-agents.
2.1 implement. 2.2 review fresh against check.jsonl; write review.md. 2.3 fix open
findings yourself, then repeat 2.2-2.3. Inline reads spec files directly; lint and
tests are the check pass. Green: no new blocker/major, every old finding closed;
then: specrune task finish. Full text: specrune context --mode phase --step N.N
[/workflow-state:in_progress-inline]
```

<!-- Per-turn breadcrumb: Phase 2/3 with dispatch.implement=inline -->
```
[workflow-state:in_progress-implement-inline]
Phase 2 — Execute (implement inline). Active task: {task}
Step 2.1 — load specrune-before-dev and implement in this session; keep implement.jsonl curated.
Step 2.2 dispatch a fresh specrune-check; findings go to review.md.
Step 2.3 fix open findings yourself, then repeat 2.2-2.3.
Green: no new blocker/major, every old finding closed; then specrune task finish.
Full text: specrune context --mode phase --step N.N
[/workflow-state:in_progress-implement-inline]
```

<!-- Per-turn breadcrumb: Phase 2/3 with dispatch.check=inline -->
```
[workflow-state:in_progress-check-inline]
Phase 2 — Execute (check inline). Active task: {task}
Step 2.1 load specrune-before-dev, dispatch specrune-implement; add missing context to implement.jsonl.
Step 2.2 — run a fresh check pass yourself against check.jsonl; write review.md.
No specrune-check sub-agent. Step 2.3 dispatch specrune-implement to fix, then repeat 2.2-2.3.
Green: no new blocker/major, every old finding closed; then: specrune task finish.
Full text: specrune context --mode phase --step N.N
[/workflow-state:in_progress-check-inline]
```

### Phase 3: Finish

Verify, update the specs that the change made stale, commit, and archive.

<!-- Per-turn breadcrumb: Phase 3 (status='completed') -->
```
[workflow-state:completed]
Phase 3 — Finish. Active task: {task}
Step 3.2 load specrune-update-spec. Read the target spec before editing
(a duplicate section is worse), and skip typo-level changes: noise buries real updates.
Step 3.3 commit code and spec updates together.
Step 3.4 verify every acceptance criterion, then: specrune task archive <task>
Full text: specrune context --mode phase --step N.N
[/workflow-state:completed]

[workflow-state:canceled]
Task {task} was canceled — abandoned, not finished; it must not be flipped back
to completed: that would erase the record of why. No wrap-up to do.
Look: specrune task show <task>. Close the record: specrune task archive <task>.
Resume: specrune task start <task> (reopens it, records the pickup; it cannot
know your progress, so note it: specrune task set-status <task> in_progress --note "进度到哪一步")
[/workflow-state:canceled]
```

### Rules

- One active task per session. Switching tasks is `task start`, not a second pointer.
- Archive before starting something unrelated. A task tree full of finished work
  is a task tree nobody reads.
- Keep each task's title and description filled in — create refuses blanks, and
  task validate flags an empty record.

### Active Task Routing

Commands take a task by name, by relative path, or by full path:

```
specrune task start my-task                        # suffix match, must be unique
specrune task start .specrune/tasks/01-31-my-task   # exact
specrune task start /abs/path/.specrune/tasks/...   # absolute
```

A bare name that matches more than one task is a failure, not a coin flip.
Pass the full directory name.

### Guardrails

- Task references are confined to `.specrune/tasks/`. A reference that resolves
  outside it is rejected — including one already written into a session file by
  an older tool version.
- Session pointers are never inferred. No identity means no active task.
- Writes are atomic (temp file + rename). A crash mid-write leaves the previous
  content intact rather than a truncated file.

### Loading Step Detail

This file carries the index and the phase summaries. The full body of a single
step is loaded on demand:

```bash
specrune context --mode phase --step 1.1
```

## Phase 1: Plan

#### 1.0 Create task `[required · once]`

```bash
specrune task create "<title>" --slug <ascii-slug> --description "<what this task delivers>"
```

A task is a commit point: once it exists, the rest of this phase has somewhere
to write its conclusions.

Binding it to this session is best-effort, not part of this step. When a session
identity is available, creating a task also points the breadcrumb at
`[workflow-state:planning]`; run from a bare shell (no session identity) or with
`--no-start` and nothing is bound — the task is still created, and step 1.4 binds
it. Do not check for a bound task to find out whether you are in Phase 1.

#### 1.1 Requirement exploration `[required · repeatable]`

Read the request against the codebase before writing requirements. The goal is
to find the parts of the request that are underspecified — those are where the
implementation will guess, and guesses are where rework comes from.

Write findings into `prd.md`, using the six sections the
`specrune-brainstorm` skill defines:

- **Goal** — one paragraph, what changes for the user.
- **Confirmed Facts** — what you verified against the codebase, with file:line
  anchors; drop facts that do not bear on the change.
- **Requirements** — what must be true when this is done.
- **Acceptance Criteria** — how someone else verifies it. Checkable boxes, not
  adjectives.
- **Out of Scope** — what this change deliberately leaves out.
- **Open Questions** — decisions still owed by the user; empty before
  `task start`.

#### 1.2 Research `[optional · repeatable]`

Dispatch a research sub-agent when any of these trigger lines is met:

- The investigation is expected to span five or more files, or needs to
  reconstruct the shape of a large subsystem or historical module.
- The answer lives outside this repository (dependency behavior, external APIs,
  protocol docs) and the conclusion affects the requirements.
- The reading itself would crowd out the main session's context — the kind of
  reading whose details are no longer needed once the conclusions are written
  down.

Research output goes to `research/*.md` and is cited from a manifest. Research
describes what exists; it does not recommend changes. Every report opens with
an evidence card — status (VERIFIED / INCONCLUSIVE / NOT_FOUND), the sources
it rests on, and the git revision it was written against.

A question too large for one pass — many files, many hops between them — is
split into smaller questions with one research agent each; they may run in
parallel. Three deep passes over the parts beat one shallow pass over the
whole.

Before each dispatch, record what the sub-agent is handed:
`specrune dispatch <slug>` writes a dispatch slip
(`.dispatch/<slug>.json`) listing the compiled inputs and the git
revision — the ledger the report's evidence card answers to.

#### 1.3 Configure context `[required · once]`

Curate `implement.jsonl` and `check.jsonl` — one JSON object per line:

```json
{"file": ".specrune/spec/<pkg>/<layer>/index.md", "reason": "conventions for the code being changed"}
```

Spec and research documents only. A manifest with no real entries means every
sub-agent runs with zero spec context, and `task start` refuses to activate such a
task unless you pass `--allow-empty-context`.

List what is available:

```bash
specrune packages
specrune specs
```

#### 1.4 Activate task `[required · once]`

```bash
specrune task start <task>
```

Ask the user before running this. Activation is where the plan stops being a draft:
`task start` flips the status and binds the pointer, so anything the user wanted
changed in `prd.md` has to be settled first. Show the slug, the goal and the
acceptance criteria, wait for a yes, then run it.

This binds the task to this session, flips `planning` → `in_progress`, and records
the checked-out branch. The breadcrumb moves to `[workflow-state:in_progress]`.

#### 1.5 Completion criteria

Phase 1 is done when `prd.md` has checkable acceptance criteria, `design.md` exists
if there was a real design decision, both manifests have real entries, and the
task is activated. Anything short of that means Phase 2 starts by guessing.

## Phase 2: Execute

#### 2.1 Implement `[required · repeatable]`

Dispatch the implement sub-agent with the task's prompt. It receives the curated
manifests plus `prd.md`, `design.md` and `implement.md`.

The implement agent modifies code and does not commit. If the injected context is
missing something it needs, add it to `implement.jsonl` and re-dispatch — do not
paste the spec into the prompt by hand, because the next dispatch will not have
it.

#### 2.2 Review — fresh check `[required · repeatable]`

Dispatch a **fresh** check sub-agent for every round. Each round reads the task
artifacts, `check.jsonl`, and `review.md` when it exists — never rely on the
previous round's memory.

Findings go to `review.md` in the task directory: the check agent creates it, or
returns the ledger content when its role cannot write. Record each finding with
an id, severity (`blocker` / `major` / `minor` / `nit`), `file:line`,
evidence and status (`open` / `fixed` / `verified` / `rejected` / `deferred`).
The ledger is append-only; a finding's current status is its last event.

Each round verifies every open or fixed finding from earlier rounds before it
looks for new ones. A finding must trace to an acceptance criterion, a spec in
`check.jsonl`, or the review checklist; otherwise it is at most a nit. Do not
invent new standards between rounds.

A round that edited code, specs, task artifacts, or templates cannot be green:
if it fixed a mechanical or local issue, its verdict stays red and the next
fresh round verifies the fix. Writing `review.md` is the only permitted
write and does not make the round red. Green requires **no new blocker/major**
and every finding terminal (`verified` / `rejected` / `deferred`); `open` and
`fixed` are still unfinished. Minor/nit may be deferred with a reason;
rejecting or deferring a blocker/major needs the user's agreement.

The check agent records `Candidate: green|red` for the round; the main session
confirms it and records the final `Verdict: green|red` in `review.md`.

The main session stops at 3 review rounds by default. If round 3 is still red,
it hands the ledger to the user instead of opening another round.

#### 2.3 Fix findings and re-review `[required · repeatable]`

Dispatch the implement sub-agent to fix the open findings; when
`dispatch.implement` is `inline`, fix them in this session instead. The fixer
reads `review.md`, fixes each open finding, and appends a fix record under it.
It does not close findings — only the next fresh check can mark them `verified`.

Then return to 2.2 with a new check dispatch. Default cap: **3 review rounds**.
If round 3 is still red, stop and hand the ledger to the user: extend the budget
explicitly, accept or defer the remainder, or split a follow-up task. The cap is
a circuit breaker, not a permanent ban.

#### 2.4 Rollback `[on demand]`

If an approach turns out to be wrong, discard the changes and re-plan. Do not
layer a correction on top of a wrong shape — the result reads as intentional.

## Phase 3: Finish

#### 3.1 Debug retrospective `[on demand]`

If this task cost more than it should have, write down why while it is still
fresh. A retrospective that names a specific cause ("the spec said X but the code
did Y") is worth keeping; one that says "more testing needed" is not.

#### 3.2 Spec update `[required · once]`

If this change introduced a pattern, contract or convention that the specs do not
describe, update them now. Read the target spec file before editing it — a
duplicate section is worse than a missing one.

Skip this for changes that introduce nothing new. Updating specs for a typo fix
is noise that makes the real spec changes harder to find.

#### 3.3 Commit changes `[required · once]`

Commit the code and the spec updates together. A spec change without the code it
describes cannot be reviewed.

#### 3.4 Wrap-up reminder

Verify every acceptance criterion in `prd.md` before archiving. Then:

```bash
specrune task archive <task>
```

Archive flips the status to `completed`, unlinks children, clears the session
pointers aimed at it, moves the directory to `.specrune/tasks/archive/<YYYY-MM>/`,
and commits. Two details are deliberate: a `canceled` task keeps its status and
its empty completion date (archiving it as finished would erase the record of
why), and an already-set `completedAt` is never overwritten — that date is the
day the work finished, not the day it was filed away.

## Customizing the Workflow

This file is yours. The parser depends on the structure described at the top of
this document — the `## Phase Index` heading, the `[workflow-state:*]` blocks, and
`#### N.M` step headings. Everything else is prose you can rewrite to match how your
team actually works.
