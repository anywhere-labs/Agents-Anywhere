---
name: specrune-spec-health
description: On-demand semantic health review of .specrune/spec — contradictions, stale assertions, unpaged concepts, missing cross-refs, data gaps. Use for 规范体检/规范健康度检查, before a rewrite, or periodically. NOT a CI gate.
---

# specrune-spec-health

An on-demand read of the spec tree for semantic problems the mechanical gate
(`specrune specs --check`) cannot see. The gate proves references point at
things that exist; this looks for things that exist but are wrong,
contradictory or missing.

Not a CI gate: semantic judgement has false positives by construction. The
output is a per-item, human-auditable report; it never changes an exit code.

## What to look for

| Signal | Shape |
|---|---|
| Contradiction | the same contract stated two ways in two places (numbers, defaults, ordering, wording) |
| Stale assertion | a paragraph asserting X while a later block supersedes X, with no stale marker |
| Missing page | a concept referenced repeatedly but owned by no section |
| Missing cross-reference | two contracts that depend on each other and neither links the other |
| Data gap | a claim settleable by reading code, a file or the web, left as prose |
| Orphan | already covered by `index-orphan` in `specs --check` — point at the gate, do not re-report |

## Process

1. **Scope it** — the layer or topic the user names. Read
   `.specrune/spec/<layer>/index.md` for the file inventory.
2. **Read whole files, not grep hits** — contradictions live between files.
3. **Open the code behind every `file:line` you doubt** — an anchor is a claim;
   inherited anchors are stale until re-checked.
4. **Report per item**: what is wrong, the locations (`file:line` or `req:`
   anchors), why it matters, and a suggested resolution — without applying it.
5. **Separate observation from claim** — "X and Y disagree" is an observation;
   "Y is correct" is a claim, say how you verified it.

## Rules

- Never edit specs as a side effect; findings feed a normal
  `specrune-update-spec` pass.
- "No contradictions found in <scope>" is a valid result. Do not invent
  findings.
- No mechanical replacement — a contradiction is a semantic judgement.
- Read the surrounding section first: many "contradictions" are intentional
  de-duplication or version notes.
