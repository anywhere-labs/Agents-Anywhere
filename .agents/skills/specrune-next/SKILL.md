---
name: specrune-next
description: Bootstrap or resume a SpecRune session — load context, route the bound task to its workflow step (routing authority). Use on /specrune-next or /specrune-start, for what next, or 开始会话/继续/接着干. New needs → specrune-brainstorm.
---
# Next Step

Bootstrap a session (no task bound) or pick up the bound task at the right step
of `.specrune/workflow.md` instead of re-deriving the flow.

This is the single definition of the routing table: the `/specrune-start` and
`/specrune-next` commands point here instead of repeating it.

## Step 1: Load current context

```bash
specrune context
specrune context --mode current   # just the bound task + status
specrune session log
specrune context --mode phase
```

No task bound? Read the indexes only for areas the work will touch
(`.specrune/spec/<package>/<layer>/index.md`, `spec/guides/index.md`), then
decide below. A bound task also reports itself in `specrune task current`.

`task current` shows the binding, git state, and where the phase index says you
are. One binding per session; switch with `specrune task start <task>`.

## Step 2: Follow this project's workflow

`.specrune/workflow.md` is the only routing authority. Read its `## Phase
Index`, the current per-turn breadcrumb, and the relevant `#### N.N` step before
choosing an action. Use the status and artifacts named by that file; do not
assume a particular status set, phase count, step number, or native/tdd route.

The workflow may be customized by the project. If the breadcrumb and workflow
give a step id, use that id exactly; a missing id can otherwise return an empty
result without an error. This skill only explains how to load the project's
instructions and which generic helper skill to invoke when the workflow names
one.

## Step 3: Load the specific step

```bash
specrune context --mode phase --step <X.X>
```

Follow the loaded instructions, then move to the next step.
