# 证据恢复台账（2026-09-27）

本目录是 `VERIFICATION.md` 所引用的隔离实测报告。**它们原先不在这里**：原来落在
`.git/opencode-team/20260926-213919/` 下，而 `.git/` 不受版本控制——2026-09-27 一次误删
把整棵工作树连同 `.git/` 一起毁掉时，这批文件与 8 个未推送提交同时丢失，远端、fork、PR 上
一份都没有。放在可跟踪目录里、并推出去，是这次事故换来的处置。

## 恢复方法与可信度分级

代码与未提交改动来自 OpenCode 自己的**每条消息工作树快照**
（`~/.local/share/opencode/snapshot/<projectID>/<worktreeHash>/`，一个 `core.worktree` 指向本仓库的真
git 库；SHA 取自会话库 `session_message.data → $.snapshot.start|end`，844 个快照覆盖到删除前约 1 小时）。
本目录的报告**不在**那些快照里（`.git/` 不被快照），只能从 OpenCode 会话库
（`~/.local/share/opencode/opencode.db`，只读）里重建。报告的正文来自写黑板的那次 `execute`
调用——`input.code` 里嵌着完整的 JS 模板字面量，返回值给出确切落盘路径与写入字节数；
黑板会在正文前加一行信封：

```
<!-- tm_board_write · <ISO 时间> · role=<角色> · session=20260926-213919 -->
```

**每一份都用黑板自报的字节数对账**，不匹配的一律标出来，不静默放行。

| 级别 | 判据 | 份数 |
| --- | --- | --- |
| A | `execute` 正文 + 同文件 `read` 页取到的**原始信封**，字节数与黑板自报**逐份相等** | 14 |
| B | 同 A，但无 `read` 页可取信封，信封按该次工具调用时刻**重建**（长度固定，字节数仍逐份相等；仅信封时间戳可能与原值差几秒） | 5 |
| C | 只有 `read` 分页可拼（无黑板字节数可对）；用 `VERIFICATION.md` 已引用的行号与章节逐条反查确认 | 4 |
| D | 只有 `tm_board_write` 入参、返回值未捕获 ⇒ **文件名按正文自称的角色重建** | 1 |
| E | 黑板入参但拿不到字节数，且正文偏短 ⇒ **疑为摘要，不作判据引用** | 2 |

合计 26 份报告。

- **B**：`opencode-credential/01-general-credential-contract-fix.md`、
  `opencode-research/01-researcher-connector-runtime-architecture.md`、
  `opencode-research/02-researcher-opencode-plugin-capabilities.md`、
  `opencode-research/03-researcher-opencode-multi-plugin-coexistence.md`、
  `opencode-selfhost/01-implementer-selfhost-report.md`
- **C**：`opencode-design/01-architect-integration-design.md`、`opencode-p0/01-implementer-spike-results.md`、
  `opencode-p2/03-implementer-fix-rev3.md`、`opencode-p5/01-implementer-server-web-implementation.md`
- **D**：`opencode-verify/01-tester-bridge-integration-verification.md`（正文首行自称"验证者：tester"，
  故取此名；`VERIFICATION.md` 没有引用它）
- **E**：`opencode-bridge-handshake/board-report.md`（461 B）、`opencode-spawn/board-findings.md`（750 B）

## 引用行反查结果（级别 A/B/C 的症状层判据）

| 台账引用 | 反查到的内容 |
| --- | --- |
| `opencode-p2/03:36` | `36 passed in 4.70s` |
| `opencode-p2/03:42` | `23 failed, 853 passed, 3 skipped, 1 warning in 56.70s` |
| `opencode-p5/01:60` | `uv run --with tzdata pytest -q tests/test_auth.py tests/test_plug…` |
| `opencode-design/02` L83 / L109 | A12 `Plugin.define(...)` 与 `export default {id, setup\|effect}` 等价性（待核验项） |
| `opencode-research/03` L117 | `8. 零运行时依赖：不依赖 v2 SDK（Plugin.define 是恒等…）` |
| `opencode-p0/01` §0–§10 | 含被引用的 §3.4、§4、§6、§8 全部在位 |

级别 B 的 `opencode-selfhost/01` 另有一次**不依赖恢复脚本**的独立复核：本轮开头从残骸里读到过它的原文，
恢复后逐条回查 5 处独有内容——`便携 PostgreSQL 16.4 @55432`、一次性
`setup-token: uUP9Ve9yQRa5iDQdhtFL5i2K`、关闭命令 `Stop-Process -Id 30492,9128`、
`Redis-8.10.2-Windows-x64-msys2`、`README 的 head（v2_35）与实际（v2_38）` —— 全部命中（158 行 / 9744 字节）。
该文件也是任务「真机端到端复验」所需的自建实例启动配方。

## 已知不完整处

1. 早期现场记录里出现过 `opencode-dist/02-implementer-implementer-load-isolation-and-verification.md`
   与 `…-load-isolation-verification.md` 两个近似名，本次只恢复到一个（内容覆盖 `dist/02` 的 §0/§2/§3 引用）。
   若确实是两次不同 topic 的写入，另一份的正文没有被 `execute` 调用捕获。
2. 级别 C 的 4 份没有字节数硬对账，靠引用行与章节结构确认；若将来与别处副本冲突，以别处为准。
3. 恢复用的脚本是一次性取证工具，未留在仓库里（方法足以照本文件复现：只读打开会话库 →
   取 `session_message` 中 `type='assistant'` 的 `content[]`，按上文的键路径解析）。
