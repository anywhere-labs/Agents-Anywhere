# Codex dispatch

Read this only when the host is Codex and you are about to dispatch a
`specrune-research` sub-agent. Every other host uses plain
`specrune dispatch <slug>` and ignores this file.

## Same-task rule

Codex dispatch requires the session's effective binding to match the dispatch
target:

- Run `specrune dispatch <slug> --codex [--task <ref>]`. `--codex` demands a
  Codex session identity and rejects another platform's context key. Resolve
  explicitly with `--task` when the session pointer is not reliable; the
  resolved Codex session — with or without `--task` — is held to the same
  check.
- The task must exist with a resolvable `task.json` whose `status` is a
  non-empty string. Missing identity, conflicting identity, no binding, or a
  target different from the current task all fail **before** context
  compilation, snapshot writes, and the dispatch ledger.
- A failed dispatch stops the dispatch. Do not retry under another identity,
  and do not switch tasks automatically to make the check pass.

## Hand the task path to the child

Launch the research agent only after dispatch succeeds, and put the confirmed
expected task path in its assignment. The child compares that path with its own
Hook Active task and stops on mismatch — the path is a consistency check, never
an override.

Do not rebind the parent session before the child's startup check finishes.

## Do not repair with `task start`

`specrune task start` binds **and activates**: it may advance a planning or
canceled task to `in_progress`. That is a state change, not a fix for a dispatch
error — never reach for it to clear a mismatch during planning research.

The full contract lives in `req:subagents#codex-dispatch-consistency`; the
research-side counterpart is the `specrune_research` agent template.
