# Coverage Checklists

Two checklists the planning flow applies before leaving planning. Both are
accounting devices: the failure they prevent is a requirement-class nobody
mentioned.

## Coverage taxonomy

Before leaving planning, walk every class below and mark it **covered**,
**partial**, or **missing**. A class the repo cannot answer is question
material: rank the partial/missing classes by impact × uncertainty, ask about
the highest first, and keep accounting for whatever stays open.

1. **Goal & scope** — the outcome, who it serves, and what is explicitly out.
2. **Domain & data** — the objects, their fields, ownership, and lifecycle.
3. **Interaction & states** — states, transitions, and what the user can do
   from each.
4. **Non-functional quality** — performance, reliability, security, cost.
5. **Integration & dependencies** — upstream/downstream contracts, versions,
   and how a failing dependency behaves.
6. **Edge cases & failure handling** — empty/boundary/large input, partial
   failure, retry, rollback, recovery, concurrency.
7. **Constraints & trade-offs** — compatibility, deadlines, budget, and what
   we accept paying for it.
8. **Completion signals** — how we know it is done and correct.

A class is not covered just because nobody asked about it.

## Implicit requirements sweep

Walk this list line by line and judge each one **applied / not-applying /
deferred**; never leave a line silent.

- data that must survive a crash without loss or duplication
- sensitive or personal data handling rules
- permissions and who is allowed to do what
- audit trail — who changed what, and when
- what the user sees when something fails
- who depends on current behavior, and the compatibility guarantees
- accessibility, localization, or compliance obligations

`applied` becomes a requirement, `not-applying` gets a one-line reason, and
`deferred` becomes an Open Question with a safe default value.
