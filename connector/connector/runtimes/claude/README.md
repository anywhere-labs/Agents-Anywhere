# Claude Runtime 实现约束

这个目录用于实现 v2 Claude runtime。后续写代码前，先读：

- `connector/connector/runtime_protocol/`
- `connector/connector/runtimes/codex/`
- `connector/tests/test_connector_architecture.py`

Claude 不能按旧 `Adapter` 方式接入，必须遵守 v2 的 typed runtime protocol。

当前目录已被重置为文档占位状态。在 `provider.py` 和 `runtime.py` 重新实现之前，不要把 `ClaudeProvider` 注册进默认 runtime providers；如果注册表仍然 import `connector.runtimes.claude.provider`，Connector 启动会失败。

## 必须遵守的边界

- 实现 `RuntimeProvider` 和 `AgentRuntime`，不要恢复旧的 dict adapter registry。
- runtime 到平台侧的事件必须通过 `RuntimeHostClient` 发布。
- active code 不能 import `connector._reference`，也不能 import 旧根模块，例如 `connector.claude`、`connector.codex`、`connector.adapter`。
- 不要使用旧 token 或旧概念：`notification_sink`、`ClaudeSdkAdapter`、`CodexAdapter`、`backendNotifications`。
- Claude SDK 的原始对象只能留在 Claude runtime 包内部，离开本包前必须转成 `runtime_protocol` 里的 typed models。

## 推荐目录形状

参考 Codex 的拆法，但按 Claude 的实际复杂度取舍：

```text
connector/connector/runtimes/claude/
├── provider.py          # discovery、config schema、validate_config、create_runtime
├── provider_config.py   # config schema、capabilities、环境变量合并规则
├── runtime.py           # ClaudeRuntime，AgentRuntime 门面
├── sdk/                 # 包住 claude-agent-sdk 或 Claude Code 调用细节
├── turns/               # create/start/steer/interrupt/respond interaction
├── notifications/       # Claude event -> host updates
├── timeline/            # Claude event/history -> RuntimeTimelineItem
├── sessions/            # Claude session/thread -> SessionMeta/snapshot/state
└── domain/              # 纯规则：capability、selection、approval、session id
```

不要把所有逻辑塞进 `runtime.py`。`runtime.py` 应该像 Codex 一样只是门面和组合器。

## Provider 规则

`provider.py` 负责：

- runtime id 使用稳定值，预期为 `claude`。
- discovery 必须真实检查 Claude runtime/SDK 是否可用。
- `validate_config()` 返回 `RuntimeConfig`，不要在本地建立第二套持久化配置来源。
- `create_runtime()` 只创建 `ClaudeRuntime`，不要直接跑 turn 逻辑。

如果某个能力不能支持，必须在 capability 或 operation result 里明确表达 unsupported，不能静默 fallback 成普通 message。

## Runtime 规则

`runtime.py` 必须实现 `AgentRuntime` 的 v2 方法：

- `get_runtime_capabilities`
- `list_model_catalog`
- `list_permission_catalog`
- `list_sessions`
- `get_session_snapshot`
- `get_session_state`
- `get_session_notices`
- `get_session_capabilities`
- `create_and_start_session`
- `start_turn`
- `steer_turn`
- `interrupt_turn`
- `update_session_selections`
- `list_commands`
- `execute_command`
- `respond_interaction`

不支持的方法要返回明确的 unsupported result 或抛 `RuntimeUnsupportedError`，不要假装支持。

## Timeline 和 state 规则

- Claude 的消息、tool use、file change、approval、error、compact 等事件，必须转成 `RuntimeTimelineItem`。
- timeline item 的 `type/status/role/content/source/content_hash/order_seq` 要稳定。
- optimistic user message 要用 `client_message_id` 对齐 runtime echo，不能制造重复用户消息。
- session state 使用 `idle`、`waiting`、`running`、`blocked`、`error`、`disconnected`。
- approval/input 类交互要转成 `SessionNotice`，用户响应通过 `respond_interaction()` 回到 Claude。
- Connector 重启或 reconnect 后，state、catalogs、notices、commands、capabilities 要能重新读取或重新发布。

## Selections、attachments、commands

- 已有 session 的 message payload 不携带 model/permission。model 和 permission 变化走 `update_session_selections()`。
- selectors 必须来自 live model/permission catalogs，本地记忆只能作为 hint。
- attachments 通过 `RuntimeHostClient.attachment_download()` 获取，必要时使用 `runtime_protocol.attachments` 生成本地安全路径。
- commands 是独立 runtime operation。command 失败时不能 fallback 成普通用户消息。

## 测试要求

实现时至少补齐或更新：

```bash
cd connector
uv run pytest tests/test_runtime_protocol.py \
  tests/test_runtime_protocol_supervisor.py \
  tests/test_connector_runtime_host.py \
  tests/test_claude_runtime.py -q
```

还要在真实目标环境验证：

- Claude runtime/SDK discovery
- credentials 和 workspace 权限
- headless Connector 启动和关闭
- create-and-start、已有 session start_turn、interrupt
- timeline、notice、capability、catalog、selection 恢复

## 实现原则

- 先让协议边界正确，再补 SDK 细节。
- 先返回真实 unsupported，也不要写假 capability。
- 不要复制 `_reference/claude` 到 active code；只能把它当行为参考。
- 新增共享逻辑前先看 Codex 是否已有同类 pattern。
- 代码保持 headless 可运行，不依赖 GUI、前台窗口或交互式终端。
