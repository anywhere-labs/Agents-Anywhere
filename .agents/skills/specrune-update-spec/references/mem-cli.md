# `specrune mem` — CLI Quick Reference

`specrune mem help` is authoritative; these are the common shapes. Escalate to
`mem` only when the question is about **why** a decision was made — for "what
happened / which task / where did it leave off", `specrune session log` is
cheaper and deterministic (see the two-sources table in the skill body).

| Command | What it does |
|---------|--------------|
| `specrune mem [list]` | sessions known for this project, newest first |
| `specrune mem search "<keyword>"` | sessions whose contents mention the keyword (brief: top 3 sessions, one 200-char excerpt each; `--full` for all) |
| `specrune mem context <session-id>` | densest turns plus surrounding context |
| `specrune mem extract <session-id>` | export the cleaned dialogue |
| `specrune mem projects` | known project directories — start here when the cwd is unknown |

Flags: `--cwd <path>`; `--full` (on `search`, restore all matches and full
excerpts — the default is deliberately small); `--phase brainstorm\|implement\|all`
(on `extract`, slicing at `task create` / `task start`, default `all`);
`--grep "<keyword>"` (on `extract` / `context`); `--json`.

## Typical sequences

```bash
specrune mem projects                   # don't know anything yet
specrune mem search "缓存失效"
specrune mem extract <session-id> --phase brainstorm   # the planning half
specrune mem context <session-id>       # highest-signal part first
```

## Failure modes

- **No sessions listed** — the host stores logs elsewhere, or the project has
  not been used with an indexed host. Fall back to git history and task
  artifacts.
- **Keyword matches nothing** — search is literal, not semantic; broaden the
  term or `context` a session you know is relevant.
- **Output too large** — use `context`, or `extract --grep`.
