---
name: specrune-start
description: Bootstrap a SpecRune session in a fresh conversation — load the compact context (specrune context), review recent sessions, then pick or resume a task. Use at the start of a session when no task is bound yet, or when the user types /specrune-start or says “开始会话/start a session”. NOT for exploring a new requirement (that is specrune-brainstorm) and not for resuming an already-bound task (that is specrune-continue).
---
# Start Session

Bootstrap a SpecRune session by loading the compact context by hand. Use this
at the beginning of a conversation in a SpecRune project, or whenever the host
platform has no session-start hook.

---

## Step 1: Current state

Identity, git status, and the session's bound task:

```bash
specrune context
```

## Step 2: Recent sessions

```bash
specrune session log
```

What happened recently, with the task each session belonged to and where it
left off. Hook-driven platforms get the same three entries injected into their
stable context automatically — this step is for platforms that only get
`specrune context`, and it is the same list either way.

Use it before asking the user what they were working on. For the reasoning
behind an old decision, `specrune mem` — see the `specrune-session-insight`
skill for which to reach for.

## Step 3: Workflow overview

The phase index and request triage rules parsed from `.specrune/workflow.md`:

```bash
specrune context --mode phase
```

The full guide lives in `.specrune/workflow.md` (read on demand).

## Step 4: Spec indexes

Discover packages and their spec layers, then read the index of each layer
you expect to touch:

```bash
specrune packages
specrune specs
cat .specrune/spec/<package>/<layer>/index.md   # for each relevant layer
cat .specrune/spec/guides/index.md              # cross-cutting guides
```

Index files point at the concrete guideline docs; the index is not the
guideline.

## Step 5: Decide the next action

From Step 1 you know the bound task and its status:

- **No task bound** → classify the request. For simple conversation or a
  one-off answer, just answer it. For work with requirements worth writing
  down, ask whether to create a task:
  ```bash
  specrune task create "<title>" --slug <ascii-slug> --description "<what it delivers>"
  ```
- **Status `planning` + no `prd.md`** → Phase 1. Load the `specrune-brainstorm`
  skill and run requirement exploration (step 1.1).
- **Status `planning` + `prd.md` exists** → stay in Phase 1. Lightweight
  tasks can be PRD-only; complex tasks need `design.md` + `implement.md`.
  Curate the manifests, then activate after the user confirms:
  ```bash
  specrune task start <task>
  ```
- **Status `in_progress`** → the step depends on how far it got, and the numbers
  depend on which workflow template this project uses (`native` runs Phase 3 as
  `3.1/3.2/3.3/3.4`, `tdd` as `3.1/3.2/3.3`). Route by role, then resolve the
  number:
  ```bash
  specrune context --mode phase      # phase index for this project's template
  specrune context --mode phase --step <N.N>
  ```
  Implementation not started → the implement step. Done but unchecked → the
  quality check step. Checked → the spec update, commit and archive steps.
  For most projects `/specrune-continue` answers this for you.
- **Status `completed` or `done`** → the work is finished but not yet archived.
  Phase 3 remains: the spec update, the commit, then
  `specrune task archive <task>`.
- **Status `canceled`** → the task was abandoned, not finished. There is no
  wrap-up to do and it must not be flipped to completed. Archive it to close the
  record, or pick it up again with `specrune task start <task>` — it flips the
  status back to `in_progress` and records the pickup in `notes`. It cannot know
  how far you got, so add `specrune task set-status <task> in_progress --note
  "…"` to say so.

---

## Skill routing (quick reference)

| User intent | Skill |
|---|---|
| New feature / unclear requirements | `specrune-brainstorm` |
| About to write code | `specrune-before-dev` |
| Done coding / quality check | `specrune-check` |
| Stuck / fixed the same bug multiple times | `specrune-break-loop` |
| Learned something worth capturing | `specrune-update-spec` |

Each step's full text lives in `.specrune/workflow.md`; load one on demand with
`specrune context --mode phase --step N.N`. The per-turn breadcrumb names the
skill to load for whichever phase you are in.
