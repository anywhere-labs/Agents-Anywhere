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

流式与历史消息使用 Agent 的稳定 messageId/toolCallId；未核验的 messageId 只在当前连接或当前历史替换投影内关联消息，只有经核验的稳定身份才能跨连接去重。来源替换必须在完整回放核验后原子提交。本轮普通观察快照仍标记 partial，未发布来源替换事件，不删除平台消息或其他来源。

### Codex IPC 完整历史替换（可选）

具备完整时间线替换消费者的 ACP 连接才在 initialize 的 `_meta.codexIpc.historyReplacement` 声明 `true`。这不改变普通观察快照的 partial 语义。

1. Agent 反向请求 `_codex/session/history_reset`，参数为 `{sessionId, revision, phase:"begin"}`；Connector 核验原生会话身份和连接代际后返回 `{revision, ready:true}`。revision 是本次替换的非空唯一字符串，不是消息修订号。
2. 后续该会话的标准 `session/update` 暂存为完整回放，既不输出增量，也不作为当前输入已执行的证据；其他会话不受影响。暂存最多 100,000 条更新、64 MiB JSON，超过限制按失败处理。
3. 同名通知 `phase:"commit"` 与当前 revision 匹配时，以新投影构造完整历史，在一个本地事务中替换已保存的投影并写入 `timeline.sync`（`complete:true`）出站记录；包括空历史，Server 和客户端沿用已有完整快照替换语义。
4. `phase:"abort"`、回放无效、提交失败或连接关闭时丢弃暂存，旧时间线保持不变，会话标记需要恢复；此后忽略该连接上失去历史基线的增量。恢复重新连接原会话，不重发结果未知的输入。
5. 错误会话、过期代际、重复 begin、已完成 revision 和不匹配的 commit/abort 不得提交替换。连接本身没有完整替换消费者时不协商该扩展。
