# Reference Shapes for Go Specs

A reference in a spec survives only if a machine can still judge it after the
code moves. This file lists the shapes that hold for Go code, and the shapes
that rot silently. `specrune specs --check` evaluates every one of them.

## Never locate with a line number

Backtick tokens shaped like `path.go:123`, `path.go:123-130` or
`path.go:123/140` are the single worst form: the checker only warns about the
shape itself. If the code gains one line, the number now points at the next
function — or at a symbol that no longer exists — and nothing fails. Line
numbers are the only reference form with **no correctness mechanism at all**.

Wrong → Correct:

```text
Wrong:   `core/internal/specrune/store.go:951`
Correct: `core/internal/specrune/store.go` and the `Slugify` function
```

Write the symbol in prose; if the fact needs mechanical guarding, add an
assertion (below). Downgrade to a bare file reference only when there is no
symbol to point at.

## Prefer symbol names over file paths

`store.go`'s `Slugify` beats `store.go`, and both beat `store.go:951`. A file
reference can only assert "the file exists"; a symbol name tells the reader
what matters and can be pinned with an assertion that fails when the symbol is
renamed or moved.

## The shapes and what guards them

| You write | Check that judges it |
|---|---|
| `req:<file>#<slug>` | anchor-ref — fails when the anchor is gone |
| backtick repo path, e.g. `` `core/internal/cli/xxx.go` `` | path-ref — fails when the file is gone |
| `assert` fence with `has-symbol <path> <symbol> <n>` | assertion — exits 1 when false |
| `assert` fence with `has-count <path> <literal> <n>` | assertion — exits 1 when false |
| `` `path.go:951` `` | line-anchor — warning only; never rely on it |

## Symbol assertions: the strongest form for Go

`has-symbol` parses the target file with Go's own AST, so it works natively on
this language. The third field is a symbol name — a Go identifier or a
receiver-qualified `Recv.Method` — not a free-text literal:

```text
has-symbol core/internal/specrune/store.go Slugify 1
has-symbol core/internal/specrune/store.go Store.CreateTask 1
```

It counts named top-level declarations: `func Foo`, `func (r *Recv) Foo`
(counted as `Recv.Foo`), `type Foo struct{}`, `var`/`const` names. It does not
count call sites, strings, comments, struct fields, or local variables. A parse
failure is an error, not a skip.

Use it when the fact is "this symbol exists (N times)"; use `has-count` for
literal occurrences such as an env key string or a flag name. Assertions are
opt-in per block — write them next to the prose they pin, never let the prose
keep the number while the fence holds a copy.

## Non-Go notes

None of this file's symbol machinery extends past Go today. For anything
outside Go, see [typescript.md](typescript.md) — symbol probing there is a
project-configuration matter, and the fallback is `has-count` on a literal.
