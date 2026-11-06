# Logic checks

Regression net for this port's **pure logic** — the parts that are not ArkUI and
therefore can run on Node: parsers, label rules, state machines, tokenizers,
search and projection helpers.

```powershell
cd harmony
node tools/logic-checks/run.mjs        # every check, one verdict, exit 1 on any failure
node tools/logic-checks/<one>.mjs      # a single check while iterating
```

## Why it lives in the repository

It used to live in `%TEMP%`, and a Windows temp cleanup deleted the whole suite
along with the device helper script. It is committed now so that cannot happen
again; `run.mjs` is part of the per-batch gate next to `verify-resource-usage`,
`verify-encoding` and `verify-reachability`.

## How a check works

`lib.mjs` mirrors the real `.ets` sources (and their relative-import closure) into
`.generated/` and imports them, so a check exercises **the shipped code** under
Node's type stripping. That is the whole point: a check that re-implements the
rule it verifies will keep passing while the shipped rule is broken.

Two kinds of check, both wanted:

- **behavioural** — `loadModule('model/RuntimeIdentity.ets')`, then assert on real
  return values. See `runtime-identity-check.mjs`.
- **structural** — `readSource('ui/.../SessionDetailScreen.ets')`, then assert on a
  rule *table* in the source (branch order, resource names). See
  `session-placeholder-check.mjs`, which guards a branch that was missing
  entirely.

Conventions:

- one file per module, named `<kebab-name>-check.mjs`;
- 10–25 assertions covering fallbacks, blank/null handling, ordering and
  boundaries — concrete expected values, never "it did not throw";
- a module that cannot load standalone (ArkUI, `@ohos.*`, `$r(...)`) is skipped,
  not faked, and not modified to become testable;
- **every check must be provably able to fail** — see below.

## Proving a check can fail (never on the live tree)

```powershell
node tools/logic-checks/mutate.mjs <module.ets> <check.mjs> "<find>" "<replace>"
```

It copies the source tree to a temp directory, applies the edit **to the copy**,
runs the check against the copy through `AA_CHECK_SRC_ROOT`, and deletes the copy.
Exit code 0 means the check rejected the mutation; 1 means it passed anyway and is
a rubber stamp.

Mutating the live tree is forbidden, and not only on principle: a deliberate
mutation once sat in the working tree long enough to be **committed** by someone
else before the check finished, and had to be reverted by hand a minute later.
`AA_CHECK_SRC_ROOT` (honoured by `lib.mjs`) exists so the ritual can never put a
broken file in front of another reader.

`.generated/` is derived output: it is git-ignored, skipped by
`verify-encoding.mjs`, and cleared by `run.mjs` on every run so a mutant mirror
can never mix into a normal one.
