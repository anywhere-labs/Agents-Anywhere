---
name: specrune-finish-work
description: Record the session, then archive the finished task. Use only AFTER its quality check passed, on /specrune-finish-work or 收尾/finish work/归档. Not for review or spec updates (specrune-check/-update-spec).
---
# Finish Work

Wrap up the session: verify the tree, record the session, archive the finished
task(s). Spec updates are not done here — load `specrune-update-spec` for those.
Code commits are NOT done here — they belong to the workflow's commit
step and must already be in history. That step is named, not numbered: numbers
differ per workflow template and a stale one points at the wrong step with no
error.

## Step 1: Survey current state

```bash
specrune context --mode record
git status --porcelain
```

Record mode lists active tasks, dirty paths, and recent commits (the hashes
Step 3 needs). If it surfaces other completed tasks, ask once — "These N tasks
look done — archive them too this round? [y/N]", default no. The bound task is
archived regardless.

## Step 2: Classify dirty paths

Ignore `.specrune/workspace/`, `.specrune/tasks/` and `.specrune/sessions/`:
this flow writes there. For the rest, decide whether each path is this task's
work (cited in `prd.md` / the manifests, or in code areas of its scope) or
another window's. Then:

- **This task's work** — stop. Report the paths and send the user back to the
  commit step. Do not `git commit` here and do not ask the user to.
- **Unrelated** — report once and continue.
- **Unsure** — ask once, then route by the answer.

## Step 3: Record the session

Verify every acceptance criterion in `prd.md` first — the summary claims what
happened.

```bash
specrune session record --title "Session title" \
  --commit "hash1,hash2" \
  --summary "Brief summary of what happened" \
  --next-step "What the next session should pick up first"
```

**Record before archiving.** The record's `task:` field resolves from the
active-task pointer, and `task archive` clears session pointers aimed at the task
it moves — archiving first leaves the field empty and still exits 0. Pass the
work commits from Step 1, not the archive commits.

`--next-step` is for a session with no memory of this one: name the concrete
next action, not a topic. Repeat the flag for several items; the first is what
gets surfaced. Older records without Next Steps are normal — do not backfill.

## Step 4: Finish and archive

```bash
specrune task finish
specrune task archive <task>
```

At minimum the bound task, plus any extras confirmed in Step 1. Archive moves
the directory to `.specrune/tasks/archive/<YYYY-MM>/`, clears session pointers,
and commits. It marks the task `completed` — except `canceled`, which keeps its
status and empty completion date. Skip when there is no task.

Final commit order: work commit → session record → `chore(task): archive ...`.
