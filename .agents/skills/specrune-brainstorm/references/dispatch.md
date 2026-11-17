# Research dispatch — ledger and trigger

Read this when planning decides to dispatch a `specrune-research` sub-agent.

## When to dispatch

Dispatch when the investigation needs five or more files, answers outside the
repository, or reading that would crowd out this session's context. Split an
oversized question into smaller ones, one dispatch each; they can run in
parallel.

## Run the ledger first

Before each dispatch, run `specrune dispatch <slug>`. It records the
**compiled context list** (`.dispatch/<slug>.json`) — the spec entries
injected, the `priorityPkgs`, and the candidates that were cut — the ledger its
evidence card answers to. It does **not** record your prompt: the sub-agent's
task text comes from the dispatch call, so the ledger answers "what did it
read", never "what was it asked".

## Hand over the task

Put the confirmed expected task path in the child's assignment. The child
compares it with its own host-delivered task and stops on mismatch — the path
is a consistency check, never an override. Do not switch the parent task
between dispatch and the child's startup check.

Codex adds a same-task check and a required flag; read
[codex-dispatch.md](codex-dispatch.md) before the first dispatch on that host.
