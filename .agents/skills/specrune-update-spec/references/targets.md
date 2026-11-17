# Where a learned fact goes

| Learned | Target |
|---------|--------|
| implemented a feature | relevant spec file |
| design decision (X over Y) | spec, design-decisions section |
| subtle bug fix | spec, common-mistakes section |
| reusable pattern | spec, patterns section |
| gotcha ("X must happen before Y") | spec, warning callout |
| team convention | quality guidelines |
| thinking trigger ("don't forget X") | `.specrune/spec/guides/` checklist |

- "How to **write** the code" → a spec layer file.
- "What to **consider** before writing" → `guides/`, as a short checklist that
  points at specs and never duplicates them.

Spec frontmatter (scope/globs/tags) is for display only; what gets injected is
chosen by hand via `implement.jsonl` / `check.jsonl`.
