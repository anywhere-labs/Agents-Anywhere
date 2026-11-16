# ACP Runtime 2.0（AA 在 ACP 之上的约定）

在 1.1 的协调约定之上，v3 Connector（TypeScript）把 Codex、Claude、Pi、Hermes、DSH 与通用 ACP Agent 都作为 ACP Agent 驱动。

## 协商

- 支持 ACP v1 与 v2，按 `initialize` 协商；未协商到的扩展一律视为不支持，体现为能力 `supported=false`。
- 正向扩展（Client → Agent）与反向扩展（Agent → Client）都在注册表里登记，注册表随 Connector 发布。

## 能力映射（ACP → AA 能力 ID）

| AA 能力 ID | ACP 来源 |
| --- | --- |
| `session.send_message` | 总是支持；`available` 由会话状态决定 |
| `session.queue` | 由 Connector 合成（队列在设备，DSH 插件路由交给 host） |
| `session.steer` | `_session/steering`（Codex、Claude、Pi）或方言文本命令（Hermes `/steer`） |
| `session.interrupt` | `session/cancel` |
| `session.interaction.approval` | `session/request_permission`；表单 `elicitation/create` |
| `session.commands` | `available_commands_update` |
| `runtime.attachment` | `promptCapabilities.image/audio/embeddedContext`，MIME 由方言补充 |
| `catalog.model` / `catalog.effort` / `catalog.permission` | `configOptions`（category `model`、`thought_level`，方言识别 `mode`、`collaboration_mode`） |
| `session.planning` / `session.plan_document` / `session.plan_review` | Codex：`collaboration_mode` + `plan_update`；Claude：ExitPlanMode 协调器 + `plan_update` |
| `session.goal` | `_session/goal` |
| `session.configuration.read/update` | `configOptions` |
| 会话列表、归档、改名 | `session/list`、`_session/list/subscribe`、`_session/archive`、`_session/rename` |

## 扩展注册表（初版）

| 扩展 | 方向 | 来源 |
| --- | --- | --- |
| `_session/steering`、`_session/goal`、`_session/list/*`、`_session/archive`、`_session/rename` | C→A | codex-acp、claude-agent-acp |
| `_codex/session/read`、`_codex/session/inspect`、`_codex/ipc/sessions` | C→A | codex-acp |
| `_meta.codexIpc.mode: auto\|follow\|daemon` | C→A | codex-acp |
| `_dsh/session/turn`、`_dsh/session/continue`、`_dsh/interaction/resolved` | A→C / C→A | AA 的 DSH 插件 3.0（`contracts/dsh-bridge/3.0`） |
| `_meta.aa.timelineItem` | A→C | Timeline 条目 ID 优先规则（`contracts/identity-vectors/1.0`） |

## 不变量

- ACP 类型不越过 Connector 的 Runtime 适配器边界，也不进入 Server 契约。
- 结果不确定时不自动重发。
