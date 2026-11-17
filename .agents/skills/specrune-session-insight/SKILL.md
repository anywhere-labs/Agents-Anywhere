---
name: specrune-session-insight
description: Recall earlier sessions through two sources with different jobs — `specrune session log` (the committed session records — what was done, which task it belonged to, how it ended, where it left off) and `specrune mem` (raw host conversation logs — why a decision was made). Use whenever the user asks "how did we solve X last time", "have we discussed this before", "what was the decision on X", "where were we", "上次怎么解的", "之前讨论过吗", when starting a brainstorm that overlaps prior work, debugging a familiar bug, continuing a task across sessions, or doing a finish-work retrospective.
---

# specrune-session-insight

Cross-session recall has **two sources** here, and they answer different
questions. Choosing wrongly is the actual failure mode: `mem` will cheerfully
return a week of unrelated sessions when you asked "who touched this", and a
session record will confidently summarize how a decision turned out without ever
saying why it was made.

It is a **capability skill, not a workflow**: no output file, no required
write-back, no "always run at finish-work" rule. What to do with what you find
is a judgement call made in the moment.

## The two sources

| Question | Source | Why that one |
|---|---|---|
| What did we do, which task was it, how did it end, where do we pick up? | `specrune session log` | Committed to the repo, distilled when recorded, survives session-store cleanup, present on every machine and every host |
| What did we decide, and **why**? | `specrune mem` | Only raw dialogue carries the reasoning; a session-record summary is a deliberately lossy one-paragraph digest |
| What rule does the team follow? | `.specrune/spec/` | Neither — specs are normative, both sources are descriptive |
| What is this task meant to deliver? | the task's `prd.md` | — |

## Order matters

Start with `session log`. Escalate to `mem` only when the question is really
about reasoning.

- `session log --grep` is a text scan over committed markdown: cheap,
  deterministic, nothing to rank or argue with.
- `mem search` ranks across every session on this machine from every host.
  Recall is good, but a keyword like `config` matches a hundred sessions and
  none of them may be the one you want.

This order means the common questions — "what did we do with this", "where
were we" — cost one cheap command, and only genuine *why* questions pay for a
search.

## `session log`, concretely

```bash
specrune session log                 # last 3: title, task, status, next step
specrune session log -n 10           # more of them
specrune session log --grep slug     # scan every session, oldest first
specrune session log --session 37    # one session in full
specrune session log --json          # structured
```

Entries carry **Next Steps** — the "pick up here" breadcrumb written when that
session ended. Entries recorded before that field existed simply lack it;
their absence is normal, not a defect to go back and backfill.

The recent sessions are also injected into your context automatically (the
`RECENT SESSIONS` block), so the last few sessions are usually already in
front of you — run the command when you need more than three, or when the
injected list is stale.

## `mem`, concretely

```bash
specrune mem search "<keyword>"          # sessions mentioning a keyword
specrune mem list                        # what sessions exist
specrune mem extract <session-id> --phase brainstorm   # or --grep "<keyword>"
specrune mem context <session-id>        # densest turns + surrounding context
specrune mem projects                    # known project directories, then narrow
```

`--phase brainstorm|implement|all` slices a session at the `task create` /
`task start` boundaries: brainstorm recovers planning, implement recovers the
execution loop. Most subcommands accept `--cwd <project>` and `--json`.

Reach for `mem` **only when the reasoning is the answer**. It reads the
platform's own session stores — single-machine, per-host, and gone once those
stores are cleaned or rotated. That asymmetry is why `session log` is the
default and `mem` is the escalation: the questions worth asking about a repo
should be answerable from what is in the repo.

## When NOT to reach for either

- The context is already in this turn, `prd.md`, recent `git log`, or the
  open files.
- The question is about a fact in the code — `grep` / reading the file is
  faster and more authoritative than either source.
- You are a sub-agent whose dispatch prompt already carries the curated
  `implement.jsonl` / `check.jsonl` context; piling recall on top just
  clutters it.
- The user said not to dig through history.

## What to do with the result

Raw material, not a deliverable:

- **Quote inline** and cite the session number (or id) so the user can verify.
- **Fold a load-bearing decision into `prd.md` / `design.md`** — surface the
  proposed edit first.
- **Append to task notes** when it belongs to this task's record but not the
  PRD.
- **Promote to `.specrune/spec/`** via `specrune-update-spec` when it is a
  project-wide rule — this skill ends at the discovery.
- **Just absorb it** and answer better. Often right for one-off recall.

## Out of scope

- Neither source edits code or files; any write-back is your moment's decision.
- `mem` is read-only over the platform stores and never pushes to a remote.
- Neither replaces `specrune-update-spec` (promoting a finding) or the
  task/spec workflow itself.
