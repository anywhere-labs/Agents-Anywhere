# OpenCode V2 桥接集成 — 独立验证报告（P1 Hub × P2 Connector）

> 验证者：tester · 2026-09-27 · 基线：rev3 契约裁定（`03-architect-integration-design-rev3-contract-rulings.md`）
> 范围：`opencode-plugin/`（P1）+ `connector/connector/runtimes/opencode/`（P2）的**跨语言桥接**。
> **未改任何产品代码**；仓库新增物仅 2 个测试文件。

## 0. Verdict

**通过**（两侧各自全绿 + 活体集成 6/6 通过，覆盖 rev3 全部 7 个固定字段名与主要反面路径）。
另报 **2 条非阻断契约缺口**（F1 P1 未实现、F2 P2 命名漂移）待 lead 派修；3 条 Nit；未覆盖项见 §6。

---

## 1. 各自跑通（原始输出）

| 侧 | 命令 | 原始结果 |
|---|---|---|
| P1 | `cd opencode-plugin; corepack yarn typecheck` | `TYPECHECK_EXIT=0` |
| P1 | `corepack yarn test` | `# tests 44 / # pass 44 / # fail 0 / # skipped 0 / duration_ms 5506.8` |
| P1 | `corepack yarn build` | `[server] lib\index.js 74.87 kB` · `[tui] lib\tui.js 0.20 kB` · `BUILD_EXIT=0` |
| P2 | `cd connector; uv run pytest tests/test_opencode_provider.py tests/test_opencode_bridge_client.py tests/test_opencode_live_transport.py -q -p no:cacheprovider` | `36 passed in 4.53s` |
| P2 | `uv run ruff check <4 个 opencode 测试文件> --no-cache` | `All checks passed!` |
| 合并 | 上述 3 个 P2 文件 + 新增集成文件 | `42 passed in 6.65s` |
| 回归 | 新增文件后重跑 `corepack yarn test` | `# tests 44 / # pass 44 / # fail 0`（新增 `.mjs` harness 不在 `tests/{unit,integration}/*.test.ts` glob 内，不污染 P1 套件） |

## 2. 活体集成（核心交付）

**新增测试文件**
- `connector/tests/test_opencode_bridge_live_integration.py`（6 个用例，真实 Connector 侧）
- `opencode-plugin/tests/harness/live-hub-harness.mjs`（Node 侧 harness，加载**已构建**的 `lib/index.js`，经插件自己的 `setup()` 入口起真实 Hub）

**做法（不是自造替身）**
- Hub = 出厂产物：`plugin.setup(ctx)` ×2（两个 location，第二个 `setup` 走 adopt 分支、同一 listener、同一端点文件），事件经 Hub 自己的公开 `ingest()` 注入（即 `#consume(stream)` 对每个事件的同一条调用）。
- 端点文件由 Hub 自己发布，Connector 用**真实** `discovery.resolve_endpoint()` 解析（含 `parse_endpoint` 的 12 项校验、`select_endpoint` 的 (servicePid, location) 绑定与 m6 排序）。
- Connector 侧三件真实对象：`bridge/client.py`（NDJSON/JSON-RPC 线）、`bridge/sync.py`（SyncRelay 重组）、`runtime.py`（`OpenCodeRuntime` 端到端）。

```
cd connector; uv run pytest tests/test_opencode_bridge_live_integration.py -q -p no:cacheprovider
......                                                                   [100%]
6 passed in 5.08s
```

| 用例 | 覆盖 |
|---|---|
| `test_live_hub_contract_and_connector_decoders` | initialize(location) → ping → getCapabilities(`session.discovery`+`metadata.discoveryState`) → session.list → getSnapshot → subscribe(无 hash→全量) → begin/items/commit → ack(request 应答) → subscribe(正确 hash→增量) → 过期 hash→回落全量 → 活跃 notifications(throughSeq=8) → getNotices |
| `test_live_handshake_fails_closed` | 错 token→`-32001 UNAUTHORIZED`+断链；缺 location→`-32602 INVALID_PARAMS`+断链；相对路径 location→`-32602` |
| `test_live_locations_do_not_cross` | 同端点两 location 各连一条：session.list 互不可见、跨 location 读→`SESSION_NOT_FOUND`、A 的推流帧不带 B 的 item、B 全程 0 帧 |
| `test_live_connector_rejects_a_bridge_initiated_request` | Bridge 发起 request → Connector 回 `-32601 METHOD_NOT_FOUND`（见下方说明） |
| `test_live_unknown_session_error_codes` | 4 个方法未知会话→`SESSION_NOT_FOUND`；缺 sessionId→`INVALID_PARAMS` |
| `test_live_runtime_end_to_end_ingest` | 全量→`timeline_sync(complete=True)`+`syncDiagnostics`；checkpoint 逐字持久化(`throughSeq=7`,`historyHash` 64hex,`version=1`)；重订→`complete=False`(增量)；活跃事件→`timeline_item_upsert` |

**关于 `-32601` 用例的诚实说明**：Hub 侧**不存在**任何发请求的代码路径（设计如此，P1 自己的套件也有 "the bridge only ever sends notifications" 断言），因此这一帧无法由真实 Hub 产生。该用例用真实 loopback TCP 上的**最小 peer**注入一帧 request 到真实 Connector，验证的是 Connector 的拒绝路径本身。

## 3. 契约逐项对照（静态 + 活体双证）

| # | rev3 固定项 | Hub 侧（file:line） | Connector 侧（file:line） | 判定 |
|---|---|---|---|---|
| 1 | `location` 必填 + fail-closed | `bridge-hub.ts:491-503` 非绝对→`-32602`+`close()` | `client.py:125-126` 有则带；`runtime.py:291-295` 缺则 `RuntimeUnavailableError` | ✅ 一致（活体：/ 缺 / 相对 三态） |
| 2 | `location` 规范化 | `paths.ts:16-20` realpath+去尾`/`+win32 casefold | `discovery.py:30-37` `canonical_path`(realpath+normcase)+去尾`/` | ✅ 一致（活体：两 location 同端点各自可见集正确） |
| 3 | `historyHash` 订阅前缀校准 | `sync.ts:120-130` 必须 `sequences.get(fromSeq)===hash`；`historyHashOrNull` 非法即当缺失→全量 | `sync.py:139-156` 逐字带上；`runtime.py:84-86` 与 fromSeq 同发 | ✅ 一致（活体：全量/增量/过期回落 3 态） |
| 4 | `session.discovery` + `metadata.discoveryState` | `bridge-hub.ts:959-978`（行内 metadata）、`:776-802`（capabilities.metadata 亦带） | `provider_config.py:22/131-145` 走能力位派生；`models.py:61` metadata 原样透传 | ✅ 一致（活体：partial 双向可见；无 root `sessionDiscovery` 字段） |
| 5 | `runtime.sync.subscribe` 响应形状 | `bridge-hub.ts:703-709` 恰为 `{sessionId,streamId,resume,throughSeq,historyHash}` | `sync.py:150-156` 读 streamId；resume 由 begin/commit 语义承载 | ✅ 一致（活体断言 key 集合完全相等） |
| 6 | `sync.batch` begin/items/commit/notifications | `bridge-hub.ts:671-702`(begin/items/commit)、`:319-326`(notifications) | `sync.py:180-277` 逐字段读 | ✅ 一致（活体：4 相位全采到；items 无 meta、靠 begin 的 meta —— `sync.py:184/218` 正确） |
| 7 | `commit.complete` 语义 | `bridge-hub.ts:697` `complete: mode==='snapshot'` | `sync.py:250-251` `complete or snapshotComplete` | ✅ 一致（活体：全量 True / 增量 False） |
| 8 | `runtime.sync.ack` 是 request 且必须应答 | `bridge-hub.ts:717-724` 返回 `{ok:true,sessionId,throughSeq}`；`:552-557` 在白名单 | `sync.py:366-378` 用 `client.request`（非 notify） | ✅ 一致（活体：`{"ok":True,"throughSeq":7}`；notifications 批的 ack 亦被应答） |
| 9 | `skippedEventCount` Hub 自持 | `bridge-hub.ts:664/680/701/325` begin/commit/notifications 均带 | `sync.py:52-61` 宽容解码、`:278-281` 记录、`:241` 透传（不自推） | ✅ 一致（活体：0） |
| 10 | `skippedItemCount` Connector 自持 | 从不发送 | `sync.py:98/198/206/271` 计数，`:242` 上报 | ✅ 一致（无越权） |
| 11 | `syncDiagnostics` 合并进 commit metadata | 不涉及 | `sync.py:235-252` `metadata["syncDiagnostics"]={skippedEventCount,skippedItemCount,updatedAt}` | ✅ 一致（活体三项俱全） |
| 12 | `throughSeq` 只由 durable.seq 推进、Connector 逐字持久化 | `sync.ts:229-232/94`、保证见 `sync.py:297-302` 注释 | `sync.py:283-311` 不改写 | ✅ 一致（活体：7→8，checkpoint 原值落盘） |
| 13 | 身份派生 `platformSessionId` | `protocol.ts:262-264` | 由 Hub 下发、Connector 回传 | ✅ 一致（活体按 `sha256(ns:opencode:native)[:24]` 逐字核对） |
| 14 | 端点文件契约 | `registry.ts:44-84`、`endpoint-store.ts:43-47` | `discovery.py:129-176` `parse_endpoint` 12 项校验 | ✅ 一致（活体：文件可解析、locations=2、token 43 字符=32B base64url、未服务的 proj-c 被拒） |
| 15 | Bridge 发起的反向请求 | 无任何发请求路径（`broadcast()` `bridge-hub.ts:345` 无调用者） | `client.py:315-329` 回 `-32601` | ✅ 一致（活体：注入帧被拒） |
| 16 | 错误码映射 | `-32001/-32602/-32601`+`data.code` | `client.py:27-30` `bridge_code`；`runtime.py:412-423` 映射到 platform 异常 | ✅ 一致 |

## 4. 不一致 / 缺陷清单（分类）

| ID | 侧 | file:line | 现象 | 分类 / 建议 |
|---|---|---|---|---|
| **F1** | P1（Hub） | `bridge-hub.ts:345`（`broadcast()` 无调用者）、`session-registry.ts:53`（`get partial(): true` 硬编码） | rev3 §2.3 裁定2 要求「partial→complete 时 Hub 经 `runtime.capability.updated` 重发」；`grep -rn "capability.updated" opencode-plugin/src` = **0 命中**，`broadcast()` 是死方法。且注册表恒为 partial，complete 态当前不可达 | **产品缺陷（P1 未实现，非崩溃，Minor）** → 影响：AA 永远只看到 partial，能力收敛事件永不发生。派 P1 补：partial 可翻转 + 发 `runtime.capability.updated` |
| **F2** | P2（Connector） | `runtime.py:439` vs `sync.py:387`、`sync.py:391` | 能力更新通知名两侧不一致：**直连通知**路径只认 `runtime.capabilities.update`（复数），**推流**路径只认 `runtime.capability.updated`（单数）。rev3 规范名是单数，且 `connector/server/runtime_host.py:186` 发的也是单数 → 若 Hub 将来按规范发**直接通知**，`runtime.py:439` 会**静默丢弃**（无 else 分支、不告警） | **契约漂移（P2，Minor，当前无线上故障）** → 派 P2：`runtime.py:439` 改为接受 `runtime.capability.updated`（可保留旧名兼容）；`session.capability.updated` 同查 |
| F3 | 两侧 | `bridge-hub.ts:325` vs `sync.py:181/214` | Hub 在 `notifications` 批也带 `diagnostics.skippedEventCount`，Connector 只在 begin/commit 记录（`_record_hub_diagnostics`），notifications 分支不记录 | **Nit（非违约）**：rev3 §4.1 只要求 begin/commit；但口径不齐会让两次 commit 之间的跳过计数延迟上报。建议统一（可选） |
| F4 | — | `protocol.ts:39`、`runtime.py:337-367` | `catalog.listModels/listPermissions` 不在 Hub 白名单，但 Connector 会在能力 available 时调用 | **非缺陷**：Hub 把 `catalog.model/permission` 标为 `supported=false/available=false`，Connector 门控后跳过（活体已证不会打出 `-32601`） |

## 5. P2 修复报告遗留假设 — 本人判定

**§3.1/§3.2（读路径解码失败是否该跳过）→ 判定：P2 的做法正确，不应改成跳过。**
理由：rev3 §4.1 的原文限定语是「**Hub 推流**」（`sync.batch` 的 items/notifications），且要求「skip + 计数 + 绝不抛错」的前提是**有可观测的计数器兜底**——推流侧有 `syncDiagnostics.skippedItemCount` 上报，跳过是可观测的；读路径（`getSnapshot/getState/getNotices`）是一次 request/response，静默丢弃会让平台侧**静默截断时间线**，既无计数器也无失败信号。`models.py:216-218` 的 contentHash 不符即抛 `ValueError`，经 m5 `_decode` 包装为 `RuntimeUpstreamError`，与 `runtime.py:431-432` 的对 `ValueError→RuntimeUpstreamError` 映射自洽。**结论：维持 fail-loud；若架构方另有裁定，请显式改写 rev3 §4.1 的限定语。**

**§3.3（Windows loopback「超时 vs 拒绝」）→ 判定：报告的说法在本机**实测成立**，测试策略正确且是唯一可行方案。**
实测（`asyncio.open_connection('127.0.0.1', <绑定后立即释放的临时端口>)`，6 次）：

```
TIMEOUT 2.0 / TIMEOUT 2.0 / TIMEOUT 2.0 / TIMEOUT 2.0 / TIMEOUT 2.016 / TIMEOUT 2.0
```

6/6 全部**挂起至超时**，无一次 `ConnectionRefusedError`。含义有两层：(1) 本机 D2（「连接被拒」）路径**根本不可达**，只能靠构造异常的单元测试覆盖；(2) 反过来证明 rev3 §4.2 的 K1（超时**绝不删**端点文件）是本机唯一会实际走到的分支——若按「超时即删」写，会误删活跃 Hub 的端点文件。**故 P2 的 3+1 测试策略（D1 集成、D2/D3 单测、K1 集成保留）判定为正确。**

## 6. 未覆盖项（诚实声明）

1. TUI 面 / A10 装载形态：不属桥接集成范围，未验。
2. `catalog.*` 方法：Hub 不支持，仅静态核验能力门控，未做活体。
3. 端点文件删除 D1/D2/D3 的**集成**级验证：D2 在本机不可达（见 §5），D1/K1 由 P2 单测覆盖，本次未新增活体用例。
4. 热重载 / 重复 `install` 后的重订阅（n4）与 QueueFull→resync（n3）：由两侧各自单测覆盖，未做跨进程活体。
5. `location` 在符号链接 / 大小写变体下的等价性：仅覆盖普通 temp 路径。
6. 真机 OpenCode（`opencode-cli` 2.0.18）未启动：harness 用 stub ctx 替代 `event.subscribe/permission.hook`；2 条未实证假设（A11 hook 改写 effect、A12 `Plugin.define` 等价）沿用 P0 结论。

## 7. 复核命令（可复现）

```bash
cd opencode-plugin && corepack yarn typecheck && corepack yarn test && corepack yarn build
cd connector && uv run pytest tests/test_opencode_provider.py tests/test_opencode_bridge_client.py \
    tests/test_opencode_live_transport.py tests/test_opencode_bridge_live_integration.py -q -p no:cacheprovider
cd connector && uv run ruff check tests/test_opencode_bridge_live_integration.py --output-format concise --no-cache
```
前提：`opencode-plugin/lib/index.js` 已构建（否则集成文件按 `pytest.mark.skipif` 跳过并给出原因）、`node` 在 PATH（本机 v24.19.0）。

## 8. HANDOFF

- **verdict：通过**；两侧可继续推进（P3/P4 写路径不受本次发现阻断）。
- 待派修 2 条：F1（P1，`runtime.capability.updated` 缺失 + partial 不可翻转）、F2（P2，`runtime.py:439` 通知名与规范不符）。
- 新增 2 个文件即回归网：`connector/tests/test_opencode_bridge_live_integration.py`（42→6 用例，任意一侧改动后重跑即可发现桥接回归）、`opencode-plugin/tests/harness/live-hub-harness.mjs`（不影响 `yarn test`）。
- 环境事实：Windows loopback 连接关闭端口 → **6/6 超时**（无拒绝），D2 只能单测；PID 9016（`opencode-cli`）未触碰；未改任何产品代码。
