# Planning artifacts — manifest commands

A manifest entry is what a sub-agent actually receives. Before
`specrune task start`, both manifests need at least one real spec/research
entry:

```bash
specrune task add-context <task> implement <spec-or-research-file> "<reason>"
specrune task add-context <task> check <spec-or-research-file> "<reason>"
specrune task list-context <task>
```

`specrune task start` refuses an empty manifest unless you pass
`--allow-empty-context` — every sub-agent would otherwise run with zero spec
context.

Artifact depth:

- `prd.md` covers goal and value, confirmed facts, requirements, checkable
  acceptance criteria, out of scope, and blocking open questions.
- `design.md` (complex tasks) covers architecture and boundaries, data flow
  and contracts, compatibility/migration notes, trade-offs, and rollback.
  The `## 备选方案` / `## Alternatives considered` section is mandatory.
- `implement.md` (complex tasks) is an ordered checklist with validation
  commands, risky files / rollback points, and pre-start checks.

Lightweight tasks may stay PRD-only. Complex tasks need all three artifacts.
