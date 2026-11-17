# `specrune mem` — CLI Quick Reference

Run `specrune mem help` for the authoritative option list; this file covers
the shapes used most.

| Command | What it does |
|---------|--------------|
| `specrune mem [list]` | list sessions known for this project (newest first) |
| `specrune mem search "<keyword>"` | sessions whose contents mention the keyword |
| `specrune mem context <session-id>` | drill into one session: densest turns plus surrounding context |
| `specrune mem extract <session-id>` | export the cleaned dialogue of one session |
| `specrune mem projects` | list known project directories — start here when you don't know the cwd |

Common flags:

- `--cwd <path>` — operate on another project's history instead of the
  current directory.
- `--phase brainstorm|implement|all` (on `extract`) — slice the session at
  `specrune task create` / `specrune task start` boundaries. Default `all`.
- `--grep "<keyword>"` (on `extract` / `context`) — narrow to matching turns.
- `--json` — machine-readable output when you are going to post-process.

## Typical sequences

```bash
# 1. Don't know anything yet: find the project, then the session.
specrune mem projects
specrune mem search "缓存失效"

# 2. Got a session id: recover the planning half of it.
specrune mem extract <session-id> --phase brainstorm

# 3. Got an id but want the highest-signal part first.
specrune mem context <session-id>
```

## Failure modes

- **No sessions listed** — the host may store logs outside the default
  location, or the project hasn't been used with an indexed host yet. Not an
  error; fall back to git history and the task artifacts.
- **Keyword matches nothing** — broaden the term (search is literal-ish,
  not semantic), or use `context` on a session you already know is relevant.
- **Output too large** — use `context` instead of `extract`, or `extract
  --grep` to cut to the relevant turns.
