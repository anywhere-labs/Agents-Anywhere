# Agent 协作（Server 部分）

Agent 协作让一台设备上的 Agent 会话创建、驱动和监督同一账号下同一台或另一台设备上的会话。触发条件、权限和摘要都在设备上；Server 只保存下面这些事实，不保存任何会话内容：

- 账号的协作设置，下发给账号的每台设备；
- 设备为 Agent 申请的委托令牌（只存哈希）；
- 设备上报的监督关系（只有 id 和状态）和会话的创建来源；
- 被监督会话的调度信号，转发给监督方所在的设备。

## 账号设置

```text
GET /api/v2/agent-collaboration/settings
PUT /api/v2/agent-collaboration/settings
```

用户令牌。请求体和响应相同，`PUT` 整体替换，未知字段返回 422：

```json
{
  "enabled": false,
  "crossDevice": false,
  "instances": {
    "<runtimeId>": {
      "enabled": false,
      "crossDevice": false,
      "authority": { "steer": true, "interrupt": false, "respondApproval": false, "reviewPlan": false, "close": true }
    }
  }
}
```

默认全部关闭；省略 `authority` 时为 `steer`、`close` 打开，其余关闭。一个 Runtime 实例只有在账号 `enabled` 和实例 `enabled` 都打开时才启用协作；只有两级 `crossDevice` 也都打开时才能访问其他设备。

修改后 Server 立即把设置交给在线设备：设备设置命令 `device.settings.apply` 的 `settings.agentCollaboration` 是同样的结构，旁边是设备自己的设置（见[设备设置](device-settings.md)）。离线设备在下次连接时从 `LinkWelcome.desired.deviceSettings.agentCollaboration` 拿到。

## 委托令牌

Agent 通过 Server 访问其他设备时，用设备申请的委托令牌代替用户令牌。设备凭据（`/api/v3/device/auth` 的访问令牌）：

```text
POST   /api/v3/device/agent-delegations
DELETE /api/v3/device/agent-delegations/{grantId}
```

```json
{ "grantId": "grant_1", "supervisorSessionId": "sess_x", "scope": { "devices": "account" } }
```

`scope.devices` 是 `"account"`（账号的任意设备）或设备 id 列表。响应：

```json
{ "delegationId": "dlg_…", "token": "…", "expiresAt": "2026-11-18T11:00:00Z" }
```

令牌有效 1 小时。监督会话不属于调用设备、协作对该会话的 Runtime 实例未启用跨设备，或 `scope` 里有不属于该账号的设备时返回 `403 {"code": "agent_delegation_unavailable"}`。`DELETE` 吊销该授权的全部令牌，返回 `{"grantId", "revoked": <数量>}`；设备上报 `collab.grant.changed`（`state: "revoked"`）效果相同。

每次使用都会检查：令牌已吊销、监督会话或设备已删除、跨设备协作被关闭时返回 `401 agent_grant_revoked`；未知或过期返回 `401 agent_delegation_invalid`。

端到端加密启用时，Server 返回关闭的协作设置。尝试开启协作、签发或使用委托令牌，或申请 A2A 审查权限会返回 `403 agent_scope_denied`。Connector 停止注入协作 MCP 工具，并拒绝已有工具的调用。已有审查记录仍可查看。

## 委托 Agent 能调用什么

带委托令牌（`Authorization: Bearer <token>`）的请求以 Agent 身份执行，代表令牌里的监督会话。只允许：

- 客户端路由表（`contracts/device-meshcall/1.0/client-routes.json`）中 `agent: true` 的路由，例如消息、引导、中断、审批答复、规划、快照、时间线和 `create-and-start`；
- Server 自己的读接口：`GET /api/v2/connectors`（每台设备只有 `id`、`name`、`online`、`e2eeMode`）、`GET /api/v2/connectors/{id}/runtimes`、`GET /api/v2/sessions`、`GET /api/v2/sessions/list`。

其他路由一律 `403 agent_route_denied`。路径里的会话或设备不属于该账号时返回 `404 agent_target_unknown`，不在 `scope` 内时返回 `403 agent_scope_denied`；列表只返回 `scope` 内设备上的条目。

转发给设备的请求在 `ClientCallRequest.caller.agent` 里带上 `{deviceId, sessionId, grantId}`，由 Server 按令牌填写，不读请求体；命令回执记录 `actor`（`user` 或 `agent:<deviceId>/<sessionId>`）。

Agent 调用 `create-and-start` 时，新会话的 `origin` 为 `{"kind": "agent", "bySessionId", "byDeviceId", "depth"}`，`depth` 是监督会话的深度加 1；超过 8 时返回 `403 agent_depth_exceeded`。

## 监督关系与会话视图

监督方设备通过出站消息 `collab.supervision.changed` 上报监督关系。Server 只接受监督会话属于发送设备、被监督会话属于同一账号并在上报的设备上的关系；会与现有的有效关系（`active`、`paused`）形成环的关系存为 `ended` 并记录日志。更早的上报（按 `at`）不会覆盖更新的状态，`ended` 的关系不会恢复。

设备在 `session.summary` 里上报的 `origin` 只在会话还没有来源时记录，之后不再改变。

所有会话视图（列表、`meta`、快照、Dashboard）都带：

- `origin`：Agent 创建的会话的来源，否则为 `null`；
- `supervisors`：以该会话为被监督方、尚未结束的关系；
- `supervised`：以该会话为监督方、尚未结束的关系。

每条关系为 `{"supervisionId", "supervisorSessionId", "targetSessionId", "state", "createdBy"}`。

删除设备或会话（包括删除 Runtime 实例）时，相关关系变为 `ended`，相关委托令牌被吊销。

## 调度信号

被监督会话的 `status`、`headSeq`、`resetSeq`、`latestTurnEndSeq`、`planState`、`goalState` 有变化，或它所在的设备上线、离线时，Server 向每台监督方设备发一条 `collab.signal`，每条关系一个 `CollabTargetSignal`。信号可丢失：不重试、不记回执；它不在摘要入库的路径上等待。监督方设备重新上线后和每隔 30 秒，通过现有会话详情接口对照远端状态和已保存的监督状态，补获错过的回合结束或待审批事项。

## 实现并审查

任务和每次交接保存在监督方设备的 Connector。领域模型校验候选、轮次、审查结论和检查证据。应用层通过现有会话网关派活、读交付和返修，Git 只在持有所选仓库的设备执行。

主会话的时间线以固定的 `runId` 更新一个 `system` 项，`content.kind` 为 `collab_review`。`GET /api/v2/sessions/{id}/collab` 也可以返回同一结构的可选 `review` 字段。视图含当前阶段、工作设备、子会话引用、按轮次保存的 SHA、改动预览、审查结果、检查记录和待处理审批。客户端用任务阶段显示进度，用审批引用定位原会话里的请求。
