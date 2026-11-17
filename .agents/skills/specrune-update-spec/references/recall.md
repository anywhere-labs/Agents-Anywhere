# Recall — `session log` vs `mem`

Read this when step 3's search turns into pure recall ("how did we do X last
time", 上次怎么解的, 之前讨论过吗) or when the choice between the two sources
is unclear.

## Two sources, two jobs

| Question | Source |
|---|---|
| What did we do, which task, how did it end, where to pick up? | `session log` |
| What did we decide, and **why**? | `mem` |
| What rule does the team follow? | `.specrune/spec/` — neither source is normative |

Start with `session log` (committed markdown, cheap, deterministic); escalate
to `mem` only for reasoning — it ranks across every session on this machine
from every host, so a keyword like `config` matches a hundred sessions and none
may be the one. `mem` is also per-host and gone once those stores are cleaned;
questions about a repo should be answerable from the repo. The last few
sessions are usually already injected as `RECENT SESSIONS`; run the command
when you need more or that list is stale.

Command shapes: [mem-cli.md](mem-cli.md).

## Recall modes

Stop after the sources answer the question. Then either quote the session
number inline, fold a load-bearing decision into `prd.md` / `design.md`
(surface the edit first), promote a project-wide rule here, or just absorb it.
Neither source edits files, and `mem` never pushes anything.

Skip the search when the context is already in this turn, `prd.md`, recent
`git log`, or open files — or when you are a sub-agent whose dispatch prompt
already carries the curated manifests.
