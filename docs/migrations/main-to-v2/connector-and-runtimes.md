# 连接器和运行时迁移

v2 Connector 用 typed runtime 协议替换了 `main` 的 adapter registry，并把 transport、runtime 和 local operation 代码拆成单向依赖的层。

## 架构映射

| `main` 概念 | v2 概念 |
| --- | --- |
| dict 形态的 `Adapter` protocol | `AgentRuntime` 抽象 runtime 契约 |
| `build_default_adapters()` | `RuntimeProvider` discovery 和 lifecycle composition |
| Adapter `notification_sink` | `RuntimeHostClient` callbacks |
| `BackendRpcClient` 持有 adapters 和 runtime 细节 | Server-layer client 协调 `RuntimeSupervisor` 和 runtime RPC mapping |
| 根目录下的 `runtime.py`、`adapter.py` 和 runtime-specific packages | `core/`、`server/`、`runtime_protocol/` 和 `runtimes/*` |
| SQLite sync-state store | 通过 host sync-state methods 写入原子 JSON state |
| Runtime-specific dict probing 跨层传递 | typed dataclasses，以及 runtime package 内部的 SDK-specific parsing |

依赖方向是：

```text
Connector app -> server transport -> runtime protocol
server transport -> runtime host mapping
runtimes/* -> runtime protocol + native SDK details
```

通用 Connector 代码不能 import Codex 或 Claude 的实现模块。

## 两个协议方向

`AgentRuntime` 表示 Connector 到 runtime 的操作，包括：

- 通过 `RuntimeProvider` 进行 discovery/configuration lifecycle；
- live capabilities、model/permission catalogs、session state 和 notices；
- session discovery 和 timeline snapshots；
- create-and-start、send、steer、interrupt 和 selection updates；
- runtime command listing/execution 和 interaction responses。

`RuntimeHostClient` 表示 runtime 到平台侧的 effect，包括：

- session metadata 和 live-state updates；
- capability 和 catalog updates；
- timeline snapshot/item writes；
- notice updates 和显式 runtime errors；
- attachment downloads 和本地 sync-state reads/writes。

Runtime 集成应该返回明确的 unsupported result 或 error。不能静默 fallback 到另一条 message path，也不能把旧 adapter contract 恢复回来。

## 运行时支持矩阵

| Runtime | `main` | v2 基线 | 迁移影响 |
| --- | --- | --- | --- |
| Codex | 本地 CLI/app-server adapter，带 IPC 相关集成 | 使用 `openai-codex` 的原生 provider；active code 只走 SDK | 从部署和配置中移除 `CODEX_BIN`、app-server 和 IPC 假设。 |
| Claude | Claude SDK adapter | 原生 `ClaudeProvider`/`ClaudeRuntime` | 重新验证声明的 capability 子集；不支持的行为必须保持可见。 |
| Gemini ACP | 内置 ACP 清单 | 没有 active provider | 如果用户依赖它，就阻断正式切换；或者先实现 v2 provider。 |
| Cursor ACP | 内置 ACP 清单 | 没有 active provider | 同上。 |
| Grok Build ACP | 内置 ACP 清单 | 没有 active provider | 同上。 |
| CodeBuddy ACP | 内置 ACP 清单 | 没有 active provider | 同上。 |

`connector/_reference/` 下的旧实现只是参考材料，不是 runtime fallback。生产代码不能 import 它们。

## 服务端 URL 和命名空间

`serverUrl` 只保留 origin：

```json
{
  "serverUrl": "https://agents.example.com"
}
```

不要存 `https://agents.example.com/api/v2`。Connector URL helpers 会为 auth、ingest、WebSocket、attachment、transfer、relay、pairing 和 health 调用添加 namespace。

## 本地数据迁移

默认数据位置从 `~/.agent-server` 改为 `~/.agents-anywhere`。

| `main` | v2 |
| --- | --- |
| `~/.agent-server/connector.json` | `~/.agents-anywhere/connector.json` |
| `stateDbPath` | `statePath` |
| `AGENT_CONNECTOR_STATE_DB` | `AGENT_CONNECTOR_STATE_FILE` |
| `connector-state.sqlite3*` | `connector-state.json` |
| 没有 data-root override | `AGENT_CONNECTOR_DATA_DIR` |

第一次访问时，v2 会把文件从 legacy directory 移到 canonical directory；如果有命名冲突，会加 `.legacy-N` 重命名；同时删除已经废弃的 Connector SQLite sync-state 文件，并移除空的 legacy directory。

这是一个自动的、会改动本地文件的迁移。第一次启动 v2 前：

1. 停止所有使用 legacy directory 的 Connector 进程。
2. 备份完整的 `~/.agent-server` 目录。
3. 记录任何显式的 `AGENT_CONNECTOR_CONFIG` 或 `stateDbPath` override。
4. 先启动一个 v2 Connector，并检查 `~/.agents-anywhere`，再扩大部署。
5. 在支持 POSIX mode 的平台上，确认 config 文件仍然是 `0600`，data directory 仍然是 `0700`。

旧的 SQLite sync cursor 故意不导入。v2 Connector 可以从 runtime 和 Server state 重新同步 session metadata/timeline。

## 运行时配置迁移

Runtime configuration 归 Server 所有。Connector 通过 supervisor 校验 provider config，并启动或停止 runtimes；它不能在本地建立第二个持久化配置来源。

每个 Connector 升级后：

1. 调用 runtime discovery。
2. 确认只列出了预期的 native providers。
3. 从 Connector-scoped runtime endpoint 读取每个 runtime config schema。
4. 重新应用并验证迁移后的配置。
5. 激活 runtime，并验证返回的 effective config。
6. 启用 UI action 前，读取 runtime 和 session capabilities。

不要从 runtime 名字推断支持范围。attachments、catalogs、send、steer、interrupt、approvals 和 commands 都要看 declared capabilities。

## 会话行为变化

- `session.create` 是对已有外部 session 的 bind/import 操作。
- 新用户任务使用 create-and-start，这样 Server 会先分配 platform session id，然后 runtime 才发出 timeline events。
- 已有 session 的 message 不包含 model 或 permission 字段。
- Commands 是独立的 runtime operations；lookup 或 execution 失败时，不能把它们变成普通用户消息。
- Timeline items 在离开 runtime package 前必须已经是 platform types。SDK method names 和 objects 留在对应 package 内部。
- Runtime state、selections、notices、catalogs 和 capabilities 都是实时事实。Connector reconnect/discovery 后必须重新发布它们，或者让它们可读。

## 连接器验证

至少验证：

```bash
cd connector
uv run pytest tests/test_runtime_protocol.py \
  tests/test_runtime_protocol_supervisor.py \
  tests/test_connector_runtime_host.py \
  tests/test_codex_runtime.py \
  tests/test_claude_runtime.py -q
```

然后再用目标 Connector host 上实际安装的 runtime SDK 版本测试。单元测试不能证明本地 credentials、runtime binary/SDK discovery、workspace permissions 或 headless 行为没问题。
