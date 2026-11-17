---
name: specrune-break-loop
description: Deep post-mortem of a fixed bug so its class stops recurring. Use after fixing a stubborn bug, when the same bug came back, or to analyze why earlier fixes failed.
---

# specrune-break-loop

Run this once the debug session is over. The value is not in fixing this bug
but in making this class of bug impossible to repeat.

## 1. Root cause category

| Category | Characteristics | Example |
|----------|-----------------|---------|
| **A. Missing Spec** | nobody documented how to do it right | new feature with no checklist |
| **B. Cross-Layer Contract** | interface between layers was ambiguous | API returned a different format than the caller assumed |
| **C. Change Propagation Failure** | changed one place, missed another | function signature changed, one call site survived |
| **D. Test Coverage Gap** | unit passes, integration fails | component works alone, breaks when combined |
| **E. Implicit Assumption** | code relied on an undocumented invariant | timestamp seconds vs milliseconds |

## 2. Why earlier fixes failed (if applicable)

Check whether this was hit before: `specrune session log --grep "<symptom>"`
(escalate to `specrune mem` for the reasoning behind older entries — update-spec
step 3 has the two-sources table). A
repeat is the strongest evidence for which category applies.

- **Surface Fix** — treated the symptom, not the root cause
- **Incomplete Scope** — found the cause, did not cover all cases
- **Tool Limitation** — grep missed it, the type checker was not strict enough
- **Wrong Mental Model** — kept looking in the same layer, never went cross-layer

## 3. Prevention mechanisms

Prefer stronger over weaker: documentation → review checklist → runtime
detection → test coverage → compile-time enforcement → architecture that makes
the error structurally impossible. For each, name the concrete action and its
status (TODO / DONE). "Add more tests" is not an action.

## 4. Systematic expansion

Where else might this problem exist? Is there a design or process flaw behind
it? What understanding did the team lack?

## 5. Knowledge capture — the actual deliverable

- [ ] update the relevant `.specrune/spec/` docs (load `specrune-update-spec`)
- [ ] add the regression test that would have caught this
- [ ] file an issue or follow-up task if the root fix exceeds this task's scope
- [ ] update a check guideline if `specrune-check` should have caught it

An analysis that stays in chat is worth nothing; the updated spec is the
output.
