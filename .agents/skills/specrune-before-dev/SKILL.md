---
name: specrune-before-dev
description: Load task requirements, specs and conventions before coding. Use when implementing or touching code outside a brainstorm.
---

# specrune-before-dev

Read the specs before coding so the implementation follows them, not the
model's habits.

## Steps

1. **Read the task's planning artifacts** (if a task is bound):

   ```bash
   specrune task current
   specrune task show <task>
   ```

   `prd.md` first; `design.md` / `implement.md` when present.

2. **Find the specs that apply**:

   ```bash
   specrune packages
   specrune specs            # path + title only; add --verbose for bytes/density/index refs
   ```

   Read `.specrune/spec/<package>/<layer>/index.md` for each package you touch
   and follow it into the concrete guideline files. The index is a pointer, not
   the goal. Include `spec/guides/index.md` for cross-cutting checklists.

3. **State the change boundary** before writing code, for a non-trivial change
   (more than one file, crosses a layer, changes a public interface, or edits
   code you did not just write):

   - the behavior gap between now and target
   - where that behavior actually lives (not where it is easiest to intercept)
   - files you expect to change, and why each is necessary
   - what this task explicitly does not do
   - how you will show a local refactor did not change behavior

   If the real scope is clearly larger than that, say so before continuing.
   Do not widen the change on your own.
