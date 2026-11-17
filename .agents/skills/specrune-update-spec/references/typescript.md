# Reference Shapes for TypeScript/JavaScript Specs

A reference in a spec survives only if a machine can still judge it after the
code moves. This file lists the shapes that hold for TypeScript and
JavaScript, and the shapes that rot silently. `specrune specs --check`
evaluates every one of them.

## Never locate with a line number

Backtick tokens shaped like `src/store.ts:210`, `src/store.ts:210-216` or
`src/store.ts:210/216` are the single worst form: the checker only warns about
the shape itself. If the file gains one line, the number now points at the
next export — or at a symbol that no longer exists — and nothing fails. Line
numbers are the only reference form with **no correctness mechanism at all**.
This is language-independent: `.ts`, `.js`, `.md`, Python — all the same.

Wrong → Correct:

```text
Wrong:   `src/store/slug.ts:41`
Correct: `src/store/slug.ts` and the exported `slugify` function
```

Write the symbol in prose; if the fact needs mechanical guarding, add a
`has-count` assertion (below).

## Prefer symbol names over file paths

`slug.ts`'s exported `slugify` beats `slug.ts`, and both beat
`slug.ts:41`. A file reference can only assert "the file exists"; a symbol
name tells the reader what matters.

For a machine-checkable handle on a symbol in this language, pin a literal the
symbol implies (its name string in code, a route, an event name) with
`has-count` — see below.

## The shapes and what guards them

| You write | Check that judges it |
|---|---|
| `req:<file>#<slug>` | anchor-ref — fails when the anchor is gone |
| backtick repo path, e.g. `` `src/store/slug.ts` `` | path-ref — fails when the file is gone |
| `assert` fence with `has-count <path> <literal> <n>` | assertion — exits 1 when false |
| `` `src/store/slug.ts:41` `` | line-anchor — warning only; never rely on it |

## Symbol assertions: not available for TS/JS

`has-symbol` is built on Go's own parser and works only for Go files —
pointing it at a `.ts` file is an error, not a skip. Do not write
`has-symbol` lines in specs about TypeScript or JavaScript code.

For facts about non-Go code, use `has-count` with a literal that is stable
across refactors:

```text
has-count src/api/routes.ts /api/v2/tasks 3
has-count src/store/slug.ts slugify 1
```

The literal is one whitespace-free token, taken verbatim — no quoting
mechanism exists, so a literal containing a space cannot be expressed; pick a
single token instead. `slugify` counts every occurrence of the name (calls
included), so it stays green while the function exists and goes red the moment
the last mention is renamed away — pair it with the prose naming the
declaration. A quoted string is not a quoting mechanism: the fence grammar
rejects quotes outright.

Symbol-level probing for other languages (counting declarations the way
`has-symbol` does for Go) is provided by **project configuration**, not by
anything in this skill. Check the project's own spec configuration for whether
such a probe exists before assuming one does.

## Same discipline as the Go guide

Everything else in [go.md](go.md) — line numbers never locate, symbol names
over paths, assertions next to the prose they pin — applies here unchanged;
only the assertion vocabulary differs.
