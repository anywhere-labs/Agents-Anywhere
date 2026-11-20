# 用一个 Agent 管理子会话

在普通模式下，Connector 会在新建或恢复 Codex、Claude Code、Pi 和直连 DSH 的 ACP 会话时自动挂载名为 `aa` 的 stdio MCP。MCP 随 Connector 分发，无需单独安装或修改 Agent 的全局配置。本机派活默认开启，端到端加密部署下停用此 MCP。

例如，让 Codex 在另一台电脑上给 Pi 派活时，先用 `aa_targets` 找到目标设备的 `deviceId` 和 Pi 的 `runtimeId`，再调用 `aa_spawn`，传入这两个 ID、目标设备上已登记项目的绝对工作目录 `cwd` 和任务 `prompt`。工作目录须在目标 Connector 允许访问的范围内。返回的 `sessionId` 用于后续操作。

| MCP 工具 | 用途 |
| --- | --- |
| `aa_targets` | 查看可用设备和 Runtime，以及本会话创建且仍开放的子会话。 |
| `aa_spawn` | 创建子会话并发送第一条消息，默认在子会话结束一轮、失败或需要关注时唤醒主会话。 |
| `aa_status` | 检查子会话是否正在运行、当前进度游标、待处理通知和计划或目标状态。 |
| `aa_read` | 按 `afterSeq` 增量读取工作记录，用 `detail` 读取较长的正文。 |
| `aa_steer` | 给正在运行的子会话修改指令，是否能在本轮生效取决于目标 Runtime 的引导能力。 |
| `aa_send` | 发送追加任务，子会话忙时排队。 |
| `aa_interrupt` | 中断子会话当前一轮。 |
| `aa_wait` | 最多等待 50 秒并返回状态；长时间任务可以让主会话结束本轮，等监督消息唤醒。 |
| `aa_close` | 释放子会话，成功后结束监督。 |

### 开启跨设备派活

在同一账号下配对两台设备，让两个 Connector 都在线。用用户身份读取 `GET /api/v2/agent-collaboration/settings`，保留已有实例配置，把账号和**主会话的 Runtime 实例**的 `crossDevice` 都设为 `true`，再用 `PUT` 写回同一地址。下面的 `rti_codex` 替换为实际的主会话实例 ID。

```json
{
  "enabled": true,
  "crossDevice": true,
  "instances": {
    "rti_codex": { "enabled": true, "crossDevice": true }
  }
}
```

开启后新建或重新打开主会话以取得相应授权。普通模式跨设备调用由 Server 校验账号和父子关系，再转交目标 Connector。主会话只能管理自己创建的子会话，每个主会话默认最多同时管理 4 个子会话，最多嵌套 2 层。子会话需要用户审批时，主会话可以查看通知，审批仍由用户处理。
