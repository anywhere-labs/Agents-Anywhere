---
name: specrune-spec-bootstrap
description: Create or refresh .specrune/spec/ from the codebase. Use when bootstrapping specs, reshaping boundaries by package/layer, or filling placeholders with source-backed rules.
---

# specrune-spec-bootstrap

Create or refresh `.specrune/spec/` from the codebase as it actually exists.
One agent owns the loop: analyze the repository, choose the spec boundaries,
write the docs, verify the result.

## Workflow

1. Inspect the current tree:
   ```bash
   specrune packages
   specrune specs
   ```
2. Analyze the architecture with the best tools available — language servers,
   search, direct reads, existing docs.
3. Decompose by package and layer only where that mirrors the real codebase;
   do not invent a hierarchy the repo does not have.
4. Fill each spec file with concrete patterns, file paths, examples and
   anti-patterns from this project.
5. Verify the result is internally consistent and free of placeholders.

## Reference routing

| Need | Read |
|------|------|
| Repository architecture analysis | [references/repository-analysis.md](references/repository-analysis.md) |
| Writing high-signal spec files | [references/spec-writing.md](references/spec-writing.md) |

## Operating rules

- A starting template is a starting point, not a contract: delete, rename,
  split or add files as the repository calls for it.
- Prefer source-backed rules over generic advice — every important
  recommendation points at a real file or a repeated local pattern.
- Keep a single owner; helper agents are an implementation detail, not a
  user-visible dependency.
- Do not write host-platform-specific instructions unless the project already
  standardizes on that platform.
- Leave no placeholder text, empty headings or copied boilerplate.

## Done criteria

- `.specrune/spec/` describes the project as it exists now.
- Non-applicable template sections are removed; `index.md` files match the
  final file set.
- Analysis assumptions are recorded in the relevant spec.
