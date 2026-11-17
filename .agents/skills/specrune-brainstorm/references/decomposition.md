# Decomposition decision — shapes and commands

Read this when the gate in SKILL.md says to decide the task shape. Pick
exactly one:

| Shape | When | How |
|---|---|---|
| One task | Slices are not independently acceptable, or there are none | Write the reason: `specrune task set-decompose <task> "<why one task finishes this>"` |
| Parent + children, ordered | Slices relate: one cannot be accepted before another | Create the parent, then each child with `--parent`; add `--depends-on` for the ordering |
| Siblings, no parent | Slices are unrelated and independently acceptable | Create each on its own — no `--parent`, no `--depends-on` |

```bash
# parent + ordered children (the parent carries the goal and the dependency graph)
specrune task create "<parent title>" --slug <ascii-slug> --description "<total goal>"
specrune task create "<slice A>" --slug <slice-a-slug> --description "<slice A>" --parent <parent-dir>
specrune task create "<slice B>" --slug <slice-b-slug> --description "<slice B>" --parent <parent-dir> --depends-on <parent-dir>/slice-a

# unrelated slices: two independent tasks, same origin, no link
specrune task create "<slice A>" --slug <slice-a-slug> --description "<slice A>"
specrune task create "<slice B>" --slug <slice-b-slug> --description "<slice B>"
```

- `--depends-on` takes the **directory name** (e.g. `10-25-slice-a`), repeatable
  or comma-separated, and only siblings under the same `--parent`.
- `canceled` does not satisfy a dependency. A child that depends on an abandoned
  slice stays blocked on purpose: re-decide it, do not let it start.
- A parent is a container: `task finish` on it is refused while any child is not
  `completed`. Once the children are filed, `specrune task next <parent>` is the
  loop's entry point — it lists children whose dependencies are all met.
