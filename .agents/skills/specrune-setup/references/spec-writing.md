# Writing High-Signal Spec Files

A spec file earns its place by changing how someone writes or reviews code.

## What belongs

- **Rules with a concrete target** — real files, symbols, paths. "Handle errors
  like `store/pg.go` does" is a spec; "handle errors well" is not.
- **Invariants call sites assume** — ordering, locking, encoding, lifecycle.
- **Local conventions** — idioms that appear 3+ times; codify what the code
  already does consistently.
- **Anti-patterns seen in this repo** — tried and rejected here, with the
  reason.

## What does not

- Restating the language, framework or a linked official doc.
- Orientation prose ("this module is important because…").
- Implementation plans — those belong in `implement.md`.
- Rules with no evidence behind them: every rule should answer "which file does
  this come from?"
- The decision process, rejected options, and unfixed findings — those live in
  the task's `design.md`, the session record, or a follow-up task.
- Self-reports of absence ("not yet reviewed", "to be filled"). State what you
  verified; do not record your own uncertainty.

## Structure

1. **One-line scope** — what this file covers and what it does not.
2. **Rules as short imperatives**, grouped by concern, the most-bitten first.
3. **Examples beside the rule** — a 3–10 line excerpt beats a paragraph; show
   the wrong shape when the mistake is plausible.
4. **Pointers, not copies** — link the canonical file instead of duplicating it.

## Consistency pass

- Every `index.md` lists exactly the files that exist.
- No placeholders, empty headings or "TODO: fill this in".
- Cross-references resolve.
- Package/layer placement matches where the rule is enforced; cross-package
  rules live in `guides/`.
