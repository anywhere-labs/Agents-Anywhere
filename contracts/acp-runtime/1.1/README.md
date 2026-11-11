# 通用 Agent 能力端口与 ACP 增强

这是 ACP 传输之上的 AA 通用协调契约；Pi、Cursor 等 Agent 的原生字段不得进入公共操作参数。新操作的请求模型源为 Server `core/runtime_workflows.py`，Connector 协调入口为 `runtimes/acp/application/agent_operations.py`。此目录仅保留协调约定说明，不提供已发布的 schema/manifest；组合 Agent 专属的旧生成产物已删除。

## 身份与结果

- `operationId` 是稳定业务身份；同一会话的相同 ID 不同输入返回冲突。JSON-RPC ID 不代替业务身份。
- `expectedGeneration` 必须匹配当前执行者。发生会话替换、重连或 TUI reload 后，旧请求不能用于新的执行者。
- 结果 phase 为 accepted/running/completed/rejected/cancelled/outcome_unknown；HTTP 202 不代表完成。
- 超时和连接丢失不能证明未接纳；未知请求只查询原操作，不重新执行。
- 认证凭据不属于此协议。认证和 MCP OAuth 在执行机器完成。

## 平台 API

- `POST /api/v2/runtime-workflows/sessions/{id}/operations`：`{operation, operationId, expectedGeneration, values}`。
- `POST /api/v2/runtime-workflows/sessions/{id}/recover`：`{operationId, expectedGeneration}`。
- 配置查询响应保留 `configuration`，可附带 `ownerGeneration` 和可用 `actions: [{operation,title}]`；四端只能展示当前返回的动作。
- 通用操作包括 authentication.status、resources.get/reload、queue.get/clear、message.follow_up、session.rename/fork、directories.add 和 tools.set。存在请求类型不代表 Agent 已实现或已开放。
- 只读状态查询仍须账号和设备授权；写操作另须 takeover、有效能力和执行者代际。

## ACP 边界

标准 session/list、session/load/resume、配置、权限及表单优先使用标准 ACP。AA 业务操作通过 `_aa/operate` 传递；`_aa/read_history` 只读获取原生投影，`_aa/observe` 只调用 Agent 明确开放的观察控制。

可选 `_meta.aa.unavailableCapabilities` 为能力 ID 到原因的映射；禁止客户端因标准 prompt 方法存在便推定被关闭的写入能力可用。恢复和早期回执为独立协商能力，普通 ACP Agent 不必实现 Pi 的保证清单。

原生发现条目中的 `_meta.aa` 可标记 readOnly 和 cooperative。cooperative 只代表存在协作控制通道，不证明支持远程发消息、审批或接管。未知扩展信息保持不透明。

## 历史范围

流式与历史消息使用 Agent 的稳定 messageId/toolCallId；只有经核验的稳定身份才能跨连接去重。来源替换必须在完整回放核验后原子提交。本轮普通观察快照仍标记 partial，未发布来源替换事件，不删除平台消息或其他来源。
