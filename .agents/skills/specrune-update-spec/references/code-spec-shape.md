# Code-Spec Shape

A spec block answers one question: **what must the code do that a reader could
not guess from the code itself?** Everything below serves that question, and
anything that does not is prose the next reader pays for on every injection.

Two tiers, not a checklist to fill.

## Required four

Every triggered block carries these. They are the contract; a block missing any
of them is not a spec yet.

1. **Scope / Trigger** — one line: when does this block apply. Not a history of
   how the block came to exist.
2. **Signatures** — types, function signatures, command surface, with
   `file:line`. Real anchors, re-checked, not inherited.
3. **Contracts** — the rules, one per line, each with an anchor or a number that
   has a source.
4. **Validation & Error Matrix** — `condition → result → who detects it`. At
   least one failure path; a contract with only the happy path is half a
   contract.

## Optional three

Add a section only when **getting it wrong is expensive and hard to self-check**.
Otherwise leave it out — an omitted section is not a gap, it is a decision.

| Section | Add it when |
|---|---|
| Good / Base / Bad cases | the wrong shape is plausible and would pass review |
| Tests Required | the behavior can silently regress and no existing test would catch it |
| Wrong vs Correct | the mistake is mechanical enough that a before/after pair settles it faster than a paragraph |

The pair in Wrong vs Correct is the part readers consult first — when you write
it, make both sides real code, not a description of code.

## What never belongs in a block

- The decision process — what was tried, rejected, or voted on. One pointer to
  the session record is the whole allowed form.
- Unfixed findings and "noticed along the way" lists. Those become their own
  task, or a line in `task.json`'s `notes`.
- Self-reports of absence: "not yet reviewed", "to be completed later". If a
  fact is unverified, say what you checked; do not record that you are unsure.

## Length

A block should be readable in one screen. If it does not fit, it is two
contracts sharing a heading — split it before adding another subsection.

## Example

```markdown
## 契约：`cache.Get` 不得返回过期项 {#cache-get}

**范围**：任何调用 `cache.Get` 的路径。

**签名**：`func (c *Cache) Get(k string) (Value, bool)`（`cache/cache.go:44`）

**契约**
- 过期项视同不存在，返回 `(zero, false)`，不触发回源。
- TTL 单位为秒，0 表示永不过期。

**校验与错误矩阵**

| 条件 | 结果 | 谁发现 |
|---|---|---|
| key 不存在 | `(zero,false)` | 调用方 |
| 已过期 | 删除并返回 `(zero,false)` | 本函数 |

**Wrong vs Correct**
...
```

Note what the example does **not** have: a background section, an alternatives
section, or a test-requirements section. None is required; add one only if the
rules above say it pays for itself.
