# 原生会话归档同步（AA → Codex / DSH / Claude Code）

AA 里的「归档会话」原本只是 Server 数据库里的一个状态位：会话从 AA 的活动列表里消失，但对应 Runtime 自己的历史列表（Codex App / `codex resume`、DSH 侧边栏、`claude --resume`）并不知道这件事。本文描述 2.2 起的原生归档同步：AA 归档或恢复一个会话时，把同一状态镜像到该会话所属的 Runtime 原生存储，让两端看到一致的归档结果。

## 语义边界

- **AA 仍然是归档状态的发起方**。本次不改变 AA 的归档语义，也不改变「原生归档导入 AA」的既有方向（Connector 观察到原生 `sourceState=archived` 时，Server 仍按 `_source_archive_update` 的规则首次导入归档，且不会因为原生恢复可见而自动取消 AA 的归档）。
- **同步是 best-effort**。Connector 离线、Runtime 不支持、超时或任何失败都只记日志，不让 `PATCH /sessions/{id}/meta`、`POST /sessions/archive`、`/unarchive`、项目/设备 `archive-all` 失败。
- **不引入数据库 schema 变更**，不需要 Alembic 迁移。
- 互操作：新 Server + 旧 Connector、新 Connector + 旧 DSH 插件都只退化为「AA 侧归档，原生未跟进」，不报错、不重试。

## Server → Connector：`session.archive`

Server 在归档状态落库、dashboard 失效通知之后调用一次（每个会话一次）。方法沿用 Server → Connector 的 Runtime RPC：

```json
{
  "runtime": "codex",
  "runtimeId": "rti_xxx",
  "sessionId": "sess_xxx",
  "externalSessionId": "01a1b04b-...",
  "archived": true
}
```

Connector 的结果对象（`_runtime_result` 会再补 `runtime` / `runtimeId`）：

```json
{
  "sessionId": "sess_xxx",
  "externalSessionId": "01a1b04b-...",
  "archived": true,
  "native": true,
  "supported": true,
  "status": "archived",
  "reason": null
}
```

- `status` 取值：`archived` / `restored` / `skipped` / `unsupported` / `failed`；只有 `archived`、`restored` 表示原生状态已经和 AA 一致。
- `native` 表示该 Runtime 是否有真正的原生归档概念（Claude Code 为 `false`，AA 用文件移动模拟）。
- 协议错误（缺 `sessionId`、`archived` 不是布尔、Runtime 实例无法解析）才抛 `RuntimeInvalidRequestError`；预期内的拒绝一律收敛进结果对象。
- Connector 侧 `AgentRuntime.update_session_archive(session_id, external_session_id=None, archived=False)` 默认抛 `RuntimeUnsupportedError`（Pi/ACP 等），RPC 层把它转成 `supported=false` 的结果。

## 各 Runtime 的行为

### Codex

- 原生 API：app-server 的 `thread/archive {threadId}` 与 `thread/unarchive {threadId}`。
- 恢复成功后，如果 Connector 的 Codex IPC owner 在线，会向 Codex App 广播 `thread-unarchived`，让侧边栏立刻重新读到这个会话（与 AA 新建线程时的公告机制相同）。
- 降级：原生 id 未知 → `unsupported/native_session_unknown`；Runtime 未启动 → `skipped/runtime_not_running`；会话有运行中的 turn → `skipped/session_running`；线程被 Codex 桌面 App 持有写锁、线程不存在等 → `failed/session_locked`、`failed/thread_not_found` 等短原因（AA 侧归档仍成功）。
- 部署注意：Connector 启动的 Codex 必须使用用户真实的 Codex Home（默认 `~/.codex`），否则 app-server 看到的是另一份会话库，归档会报 `no rollout found for thread id`，AA 里新建的会话也不会出现在桌面 App/CLI 的历史里。如果系统 Codex 是沙箱包装的（例如 Ubuntu snap 版会把 `CODEX_HOME` 强制设为 `$SNAP_USER_DATA`），请在 Runtime 配置里同时指定二进制与 Home，例如 `{"codexExecutablePath": "/usr/lib/chatgpt/resources/codex", "codexHome": "/home/ko/.codex"}`。改用 Connector 自带的 Codex CLI 也可以（SDK 与 CLI 版本一致），但新版本 CLI 可能向前迁移 `~/.codex/state_5.sqlite` 的 schema，桌面 App 版本较旧时建议先备份副本确认兼容。

### DSH

- Bridge 协议 2.0 新增 unary 方法 `setSessionArchived`，参数 `{sessionId, externalSessionId?, archived}`；插件用原生 `ctx.workspaceRegistry.archiveSession()` / `unarchiveSession()` 写入 DSH 自己的归档集合，随后 `session.source.updated` 照常传播回 AA。
- 仍然在跑的会话不会被强制停止：Workspace Registry 的 `WorkspaceActiveSessionError` 映射为 `session_active`，Connector 报 `skipped/session_active`。
- 旧插件没有该方法时，Connector 报 `unsupported/bridge_upgrade_required`。

### Claude Code

- Claude Code 没有归档 API。AA 把原生 transcript 在 `$CLAUDE_CONFIG_DIR`（否则 `~/.claude`）的 `projects/<项目>/<session-id>.jsonl` 与 `projects-archived/<项目>/<session-id>.jsonl` 之间可逆移动，使会话从 `claude --resume` 的历史里消失或恢复。
- 这是 AA 的约定，不是 Claude 官方能力；移动不重写 transcript 内容。
- 配置目录解析顺序与 Claude 的 Plan 支持一致：Runtime 配置的 `environment.CLAUDE_CONFIG_DIR` → 进程环境变量 → `~/.claude`。
- 找不到 transcript、会话正在执行、目标已存在、权限不足都返回结构化 `unsupported` / `skipped` / `failed`，不抛异常。

### Pi / ACP

没有原生归档概念，返回 `native=false, supported=false, status=unsupported`。

## 存量归档回填

功能上线前就已经在 AA 里归档的会话，当时没有任何原生归档标记。为了不要求用户重新归档一遍，Server 会在每个 Connector 连线并完成 Runtime 发现、恢复该设备已启用的 Runtime 之后，启动一次后台回填（每个 Server 进程内每个 Connector 只做一次）：

1. 读取该 Connector 的全部会话，只挑 Server 侧 `archived=true` 的会话；
2. 用同一个 `session.archive`（`archived=true`）逐条补发，受并发上限与超时约束；
3. 回填是 best-effort，失败只记日志，不影响连线、也不改变 AA 的归档状态。

回填放在 Runtime 恢复之后，是因为 `session.archive` 需要 Runtime 实例已经启动；某台设备在连接时没有启用的 Runtime（例如关闭了该 Runtime）会被跳过，等下次 Server 重启、或用户在该设备上重新归档时再补。只回填 `archived=true`：AA 未归档而原生已归档的历史保持原样，避免替用户猜测「该不该恢复」。需要关闭时设置环境变量 `AGENT_SERVER_NATIVE_ARCHIVE_BACKFILL=0`，重启 Server 后生效。

## 验证

- Connector：`pytest tests/test_session_archive_rpc.py tests/test_codex_archive.py tests/test_claude_archive.py tests/test_dsh_archive.py`
- DSH 插件：`dsh-bridge-next` 的 `tests/unit/runtime-archive.test.ts`（含真实 Workspace Registry 往返）
- Server：`tests/test_native_archive.py`
- Codex 真实链路：用隔离 `CODEX_HOME` 起真实 app-server，创建线程并完成一轮后验证 rollout 落盘、`thread/archive` / `thread/unarchive` 与 `thread/list` 的归档列表切换。
