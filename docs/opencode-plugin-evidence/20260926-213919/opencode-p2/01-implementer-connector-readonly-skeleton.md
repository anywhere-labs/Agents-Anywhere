<!-- tm_board_write · 2026-09-26T17:25:55.176Z · role=implementer · session=20260926-213919 -->
# OpenCode 接入 · Connector 侧 P2 前半段（只读路径骨架）交付清单与证据

> 角色：implementer ｜ 日期：2026-09-27 ｜ 仓库：D:\Github\Agents-Anywhere
> 范围：connector/connector/runtimes/opencode/**（新增）· providers.py（注册）· connector/tests/test_opencode_*.py（新增）

## 1. 新增/修改文件与职责

| 文件 | 职责（一句话） |
|---|---|
| connector/connector/runtimes/opencode/__init__.py | 包声明：OpenCode V2 runtime provider 与 loopback bridge 适配层。 |
| .../opencode/provider_config.py | 配置 schema/默认值（registryDir、servicePid、location、startupTimeoutMs、requestTimeoutMs、maxRestartAttempts、restartBackoffMs）+ registry_dir 解析 + capability 映射。 |
| .../opencode/discovery.py | 扫 endpoints/*.json → 校验（loopback+token+pid+版本+bridgeId+locations）→ 握手探活；以握手成功为权威存活判据，清理 stale 文件；discover() 只报类型不碰注册表。 |
| .../opencode/bridge/__init__.py | 导出 BridgeClient / BridgeRpcError。 |
| .../opencode/bridge/client.py | loopback NDJSON JSON-RPC 2.0 客户端：initialize(authToken)、request/notify/close、通知派发、exit handler；拒绝 bridge 反向请求（-32601）；runtime.error 码白名单；单帧 8 MiB 上限。 |
| .../opencode/bridge/models.py | 规范项解码（capability/session_meta/state/timeline_item/notice/commands），runtime 校验为 opencode。 |
| .../opencode/bridge/sync.py | SyncRelay 骨架：begin/items/commit/notifications 分页重组 → host.timeline_sync/timeline_item_upsert/notice_upsert；检查点键 opencode/<runtime_id>/<session_id>；runtime.sync.ack。 |
| .../opencode/runtime.py | OpenCodeRuntime(AgentRuntime)：identity(runtime=opencode, runtime_id=实例ID)、attach-only start/stop、绑定 (servicePid, location) 选端点、只读路径经 bridge 转发、断链 exit_handler + 参数化重连。 |
| .../opencode/provider.py | OpenCodeProvider(RuntimeProvider)：runtime_type=opencode / display_name=OpenCode / implementation_type=local-service / instance_policy=multiple；resource_claims=opencode_bridge_registry、session_source_key=opencode_service（均仅 registryDir，不含 pid/port/token）。 |
| connector/connector/runtimes/providers.py | 仅注册：import OpenCodeProvider + 元组追加 OpenCodeProvider()。 |
| connector/tests/test_opencode_provider.py | 单元：注册表/身份/schema/校验/认领与 source key/发现不碰注册表/探活与 stale 清理/只读路径转发。 |
| connector/tests/test_opencode_bridge_client.py | 传输：握手+通知+关闭、拒绝反向请求(-32601)、拒绝非 opencode 身份、runtime.error 白名单不出敏感信息。 |
| connector/tests/test_opencode_live_transport.py | 传输：begin/items/commit 重组后发布一次、先 ingest 后 ack、notifications 转发、检查点按实例命名空间隔离。 |

## 2. 接口契约对齐（设计 §2）
- 端点文件：<servicePid>-<port>.json，字段 {version,runtime:"opencode",protocolVersion,bridgeId,host:"127.0.0.1",port,token,pid,serviceVersion,locations[],startedAt}；校验见 discovery.parse_endpoint。
- 握手：首帧 initialize，params{authToken,protocolVersion,runtime:"opencode",connectorId,sessionNamespace,clientInfo}；Hub 身份校验 runtime=="opencode" 且协议主版本=="1"。
- 反向请求一律回 -32601 METHOD_NOT_FOUND；仅接受通知。
- 通知：sync.batch（phase∈begin|items|commit|notifications）、runtime.error（data.code 白名单 isascii/alnum/_ ≤80）。

## 3. 明确假设（规格歧义处取更简单解释）
1. **写路径/审批（P3）未实现**：create_and_start_session/start_turn/steer_turn/interrupt_session/update_session_selections/respond_interaction 一律继承 AgentRuntime 默认 → RuntimeUnsupportedError；本阶段只做只读路径（dispatch 明确排除 P3）。故未创建 attachments.py（可选文件）。
2. **sync.batch 载荷形状为设计假设**：phase=begin{streamId?,throughSeq?,historyHash?,meta?} / items{items[]} / commit{throughSeq?,complete?} / notifications{notifications[]}；P0 实机核对后再收敛。
3. **通知方法的平台名**（timeline.itemUpsert / notice.upsert / session.meta.upsert / session.state.updated / runtime.capability.updated / session.capability.updated / catalog.model.update / catalog.permission.update）复用 DSH 平台词表，非 OpenCode 原生事件枚举名（不猜原生枚举）。
4. 端点选择：servicePid 缺省时取首个活端点；location 缺省或端点 locations 为空时不做 location 过滤。
5. 未做「抽取共享 loopback 基类」重构（保持零 DSH 改动）。

## 4. 验收证据（原始命令与输出）

### 4.1 opencode 单测
命令：`cd connector; uv run pytest tests/test_opencode_provider.py tests/test_opencode_bridge_client.py tests/test_opencode_live_transport.py -q`
输出：`21 passed in 7.25s`

### 4.2 全量 pytest（本机 Node/环境相关基线失败并存）
命令：`cd connector; uv run pytest tests -q`
- 改前（git stash -u 基线）：`23 failed, 818 passed, 3 skipped, 1 warning in 57.93s`
- 改后：`25 failed, 837 passed, 3 skipped, 1 warning in 65.02s`
- 增量：+19 passed，+2 failed。两条新增失败**全部**来自指定注册动作，且都在硬性约束标为**只读**的既有测试文件里（见 §5 阻塞项）。其余 23 条为环境性基线失败（Windows symlink 权限 WinError 1314、chmod 0600、codex/claude 二进制与 SDK 相关），与本次改动无关。

### 4.3 ruff（注意本机 ruff 版本默认规则异常）
- 命令 `uv run ruff --version` → `ruff 0.16.8`
- 命令 `cd connector; uv run ruff check connector tests`：改前 142 errors / 改后 142 errors（**本机 ruff 0.16.8 默认规则集远超 E4/E7/E9/F，仓库既有代码在未改动时即 142 errors**）。
- 本改动新增文件的规则增量：**0**
- 命令 `cd connector; uv run ruff check connector/runtimes/opencode connector/runtimes/providers.py tests/test_opencode_provider.py tests/test_opencode_bridge_client.py tests/test_opencode_live_transport.py --output-format concise --no-cache` → `All checks passed!`

### 4.4 providers.py diff（仅新增 import 一行 + 注册一行）
```diff
 from connector.runtimes.dsh.provider import DshProvider
+from connector.runtimes.opencode.provider import OpenCodeProvider
 
 
 def default_runtime_providers() -> tuple[RuntimeProvider, ...]:
-    return (CodexProvider(), ClaudeProvider(), DshProvider())
+    return (CodexProvider(), ClaudeProvider(), DshProvider(), OpenCodeProvider())
```

## 5. 阻塞项（需授权，未擅自改动）
注册使以下两条既有断言失效，但两文件属硬性约束中的「只读」，故未修改：
1. `connector/tests/test_dsh_provider.py:31-36` `test_dsh_is_third_default_provider` 期望 `["codex","claude","dsh"]`
2. `connector/tests/test_connector_runtime.py:1922-1929` `test_default_runtime_providers_use_new_protocol_providers` 期望 `("codex","claude","dsh")`

解除方式（各一行）：在期望列表中追加 `"opencode"`。授权后即可令全量 pytest 回到基线失败数（23 failed / 856 passed）。