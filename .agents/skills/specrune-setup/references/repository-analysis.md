# Repository Architecture Analysis

Map the codebase before writing specs — spec boundaries should follow structure
that already exists.

## Pass 1: Skeleton

1. **Entry points** — binaries, servers, CLIs, scripts; what starts what.
2. **Module boundaries** — directories with a coherent responsibility and a
   narrow face outward. Note the import direction.
3. **Layering** — name the actual layers and where the seams are.
4. **Data flow** — trace one read path and one write path end to end; these
   become your cross-layer contract specs.

## Pass 2: Evidence

- **Test layout** — unit / integration / e2e, and what they treat as
  unmockable. Test structure reveals the real contracts.
- **Change hotspots** — `git log --oneline -- <dir>`; files that churn together
  are one conceptual unit.
- **Repeated patterns** — the same error handling, validation sequence or
  config-loading idiom 3+ times is a convention worth writing down.
- **Invariants** — what every call site assumes (ordering, locking, encoding,
  lifecycle). The highest-value specs: violating them fails far from the cause.

## Pass 3: Boundary decisions

For each candidate spec file:

1. Would a newcomer to this directory plausibly get this wrong without the
   spec? If not, it adds noise.
2. Can the rule point at concrete files? If not, it is generic advice — discard
   it.
3. Does it change how code is written or only how it is reviewed? Both are
   valid; they belong in different sections.

Then place each unit: `<package>/<layer>/` for implementation rules, `guides/`
for cross-cutting thinking checklists.

## Output

A short map (packages/layers, how they connect, which paths are contract-heavy)
plus the list of spec files and the code each covers. Keep the map in the
session — the specs are the durable output.
