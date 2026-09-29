<!-- tm_board_write · 2026-09-26T17:32:06.032Z · role=reviewer · session=20260926-213919 -->
# OpenCode 接入 · Connector P2 只读骨架 — 正确性单维度评审

> 角色：reviewer（单维度：正确性）｜日期：2026-09-27｜仓库：D:\Github\Agents-Anywhere
> 评审基准：rev1 §2.1/§2.2/§2.3/§2.6/§3 · rev2 §6 + §2.3 三行修订 + §2.4.3 · P0 实机报告
> 范围声明：**只评正确性**；完整性/影响面由他人负责。**只读评审，未改动任何文件。**
> 原始证据：`cd connector; uv run pytest tests/test_opencode_provider.py tests/test_opencode_bridge_client.py tests/test_opencode_live_transport.py -q -p no:cacheprovider` → `21 passed in 6.25s`

## 0. 结论

**VERDICT: request changes（0 Critical, 4 Major, 5 Minor, 5 Nit）**
骨架方向正确、claims 洁净、attach-only 语义成立；缺陷集中在「rev2 §6 容忍性要求未完全落地」与「跨 location / 检查点校准两处契约缺口」。

## 1. 七项评审重点逐条结论

| # | 评审点 | 结论 | 关键证据 |
|---|---|---|---|
| 1a | 端点文件字段集 §2.1 | ✅ 通过 | `discovery.parse_endpoint` 105-152 校验 version/runtime/protocolVersion/host/port/token/pid/bridgeId，locations/serviceVersion/startedAt 可选 |
| 1b | 原子发布 tmp→fsync→replace | ⚪ **不可评（范围外）** | 该文件由 Hub 写，Connector 无写入代码（全包无 open('w')/replace） |
| 1c | 握手首帧 initialize / 8 MiB / -32601 / 只收通知 | ✅ 通过 | client.py 98-112（start() 内第一帧即 initialize）、12+212+226（8 MiB 双向）、293-307（-32601）、309-319（仅通知） |
| 1d | token 恒定时间比较 | ⚪ **不可评（Hub 侧）** | Connector 只发送 `authToken`，比较在插件侧；本次范围无对应代码 |
| 1e | identity.runtime=="opencode" + 协议主版本==1 | ✅ 通过 | client.py 119-129（两处失败均 close 并 raise，有测试 186-239） |
| 1f | 方法名/params 与 §2.3（含 rev2 三行）逐字 | ✅ 通过 | runtime.py 只发 runtime.getCapabilities / catalog.listModels / catalog.listPermissions / session.list / session.getSnapshot / session.getState / session.getNotices / runtime.sync.subscribe / runtime.sync.ack；session.list={limit,cursor}、getSnapshot={sessionId,limit} 与 §2.3 一致；写方法继承 protocol.py 154-237 默认 RuntimeUnsupportedError（P3 排除项未伪造） |
| 2① | 解码宽松：未知类型/缺字段 → 跳过并计数，绝不抛错 | ❌ **未落地（Major M1）** | models.py 191-218 + sync.py 146-155/300-318 |
| 2② | session_meta 迟到 upsert／不假设启动全量／session.list 缺项非错 | ✅ 通过 | sync.py 156-190（仅在 commit/通知到达时写 meta）、runtime.py 152-165（缺项不报错）、184（仅重复报错） |
| 2③ | 检查点只对带 durable.seq 的事件推进 | ⚠️ **Connector 侧不可判** | sync.py 186-190/200-224 无条件接受 Hub 给的任何 throughSeq；Connector 既不解析 durable 也不自行推导 → 需 Hub 契约确认（HANDOFF-2） |
| 2④ | session.list partial 语义被容忍 | ⚠️ **部分** | 容忍 ✅（缺项不报错）；但「上报 partial」未落地且布尔通道承载不了 → Minor m3 |
| 2⑤ | 每 location 实例带 location 过滤 | ❌ **未落地（Major M2）** | discovery.py 164-167 + runtime.py 197-199/260-262/274-276 + client.py 99-110 |
| 3 | claims 洁净（仅 registryDir，无 pid/port/token） | ✅ 通过（Praise） | provider.py 195-214；测试 test_opencode_provider.py 138-161 还断言 key 不含 token/pid/getpid |
| 4 | attach-only 不 spawn；start/stop 与 DSH 范式一致 | ✅ 通过 | 全包无 subprocess/create_subprocess_*；start()=连接+能力+目录+sync，stop()=关 sync→取消重启任务→关 client；断链走重连而非拉起进程（runtime.py 434-460） |
| 5 | discover() 不碰注册表；stale 以握手为权威 | ✅ 通过（清理策略见 M4） | discovery.py 56-70（有测试 164-181）；probe 189-215 只用握手结果，**不用 pid 判活** |
| 6 | 健壮性/资源泄漏 | ⚠️ 见 M1/M4/m1/m2/m4 | — |
| 7 | 测试质量 | ⚠️ 21 通过但存在假绿与盲区 | 见 §3 |

## 2. FINDINGS

### Critical
无。

### Major（必须修）

**M1｜rev2 §6① 未落地：整页解码零容忍、无跳过计数，一坏项毁一批**
`bridge/models.py:191-218`（未知 type/status/role、contentHash 不等 → raise ValueError）、`139-153`（session_meta 强制 externalSessionId）、`sync.py:146-155`（items 页逐项 `timeline_item(raw)` 无 item 级 try）、`sync.py:300-318`（run() 捕获后清空快照并重新校准）。
后果：插件版本演进出任一未知 canonical type/status，或单个 contentHash 算法漂移，都会**丢弃整页**（不是跳过该项）并触发重订阅循环；§6① 明确要求「跳过并计数，绝不抛错」，代码里既抛错也无任何计数器。
修法：
```python
# sync.py items 分支
for raw in raw_items:
    try:
        item = timeline_item(raw)
    except ValueError:
        self.skipped_items += 1          # 新增计数器，经 health/metadata 暴露
        logger.warning("opencode timeline item skipped index={}", len(page["items"]))
        continue
```
并在 commit 时把 `skipped* > 0` 计入 `runtime_health_update` 的 detail（可观测的「计数」）。

**M2｜rev2 §6⑤ 未落地：实例全程不携带 location 身份，跨 location 未隔离**
runtime.py `197-199`（getSnapshot 只带 sessionId/limit）、`260-262`、`274-276`；client.py `99-110`（initialize 无 location 字段）；discovery.py `164-167`（`not item.locations or location in item.locations` —— 端点 locations 为空即**完全不过滤**，且 location 配置本身可选）。
后果：Hub 单例 + 事件流全局（§2.4.3/§6⑤），location A 的实例会拿到 location B 的 session 列表/快照；配置里漏填 location 时会静默连到任意端点并全量读取。§6⑤ 明写「runtime 请求快照时须带 location 过滤」。
修法（需架构裁决，因 §2.3 参数表未列 location）：① initialize 增 `location`（Hub 侧按 §6① 容忍未知字段）；② 或 sessionNamespace 改为 `<connectorId>:<location>`；③ `select_endpoint` 在「已配置 location 且端点 locations 为空」时拒绝而非放行。

**M4｜超时被当作「死端点」→ Connector 删除 Hub 拥有的端点文件**
discovery.py `218-245`（`startup_timeout=2`、`request_timeout=2`，`TimeoutError` 一并 return False）→ `189-202` → `discard_stale_path` 真删文件（`177-186`）。
后果：Hub 忙（初始化握手 >2s）时其端点文件被另一进程删除，其它 Connector 将长期报「OpenCode unavailable」，且 Hub 不必然重写文件 → 需要用户重启 OpenCode 才能恢复。设计只说「清理握手失败的**残留**文件」，把瞬时超时等同于残留属于过度删除。
修法：只在「连接被拒（ConnectionError/OSError）」「文件结构无效」「握手被 Hub 明确拒绝」时删除；超时/未知异常只记 debug 并保留文件。

**M5｜检查点存了 historyHash 却从不上报，§2.6 前缀校准机制事实上失效**
sync.py `118-121`（read_checkpoint 返回含 historyHash）对比 `106-116`（subscribe 只带 sessionId/fromSeq）；runtime.py `79-81` 只用 throughSeq。
后果：§2.6 要求「Hub 回放并校验前缀 historyHash；不一致则 phase:begin 全量重建」。Connector 不发送哈希 → Hub 无法判定前缀是否漂移，只能盲信 fromSeq → 历史被截断/重复时**静默续推**，时间线错乱。
修法：`subscribe(session_id, from_seq, history_hash)` 时把 `historyHash` 放进 params（Hub 若不识别忽略即可）；若架构裁定由 Hub 单方判定，需在 §2.3 参数表写明并在报告中登记（当前实现报告未提及此缺口）。

### Minor（应修，非阻塞）

- **m1｜`_checkpoint` 对缺 `historyHash` 键的合法 JSON 抛 KeyError**：sync.py `41-47`，守卫用 `value.get("historyHash")` 允许缺键，第 47 行却 `value[key]` 直取 → 外部/旧版 sync_state 值会让 `read_checkpoint` 抛 KeyError 而非返回 None。改：显式 `{k: value.get(k) for k in (...)}` 或对 historyHash 也做存在性校验。
- **m2｜空行即断链**：client.py `223-229`，`json.loads("")` → JSONDecodeError → 关闭连接并触发 exit_handler。NDJSON 的 keepalive 空行/尾随换行会打掉整条链路。改：`if not line.strip(): continue`。
- **m3｜`sessionDiscovery` 硬编码 True**：provider_config.py `135`，相邻键都从 `enabled` 派生而它写死 → Hub 上报不可用时描述符仍宣称支持。另：RuntimeTypeDescriptor.capabilities 是 `Mapping[str, bool]`（instance_models.py `169` + `_validate_capabilities 144`），**布尔通道承载不了 "partial"** → §2.3 rev2「上报 sessionDiscovery:'partial'」需架构裁定落点（建议 metadata["sessionDiscoveryState"]）。
- **m4｜`features` 非 dict 时 AttributeError 逃逸**：runtime.py `353-354`，`result.get("features", {})` 在 `features: null` 时 `.get` 抛 AttributeError，而 `_request`(408) 与 `start()`(101) 的 except 列表都不含它 → 未捕获异常且不触发重连。改：`(result.get("features") or {})` + isinstance。
- **m5｜解码异常未按契约包装**：runtime.py `163-165`/`263`/`277`，`models.*` 的 ValueError 在 `_request` 之外抛出 → 平台侧收到裸 ValueError 而非 RuntimeUpstreamError（与 `_request` 415-416 的处理不一致）。
- **m6｜多活端点选取任意**：discovery.py `76`（字典序排序，`10-` 排在 `9-` 前）、`163-168`（无 servicePid 时取首个）。建议按 startedAt 降序或先握手优选。

### Nit（可选）

- **n1**：端点文件名 `<pid>-<port>` 只校验形状（discovery.py `13`），未与文件内 pid/port 交叉校验。
- **n2**：`client.py:212-213` 本地帧超限抛 ValueError，被 runtime.py 415-416 映射成 RuntimeUpstreamError（把本地错误归咎上游）。
- **n3**：`sync.py:83-95` QueueFull 时静默丢弃新批次并 restart，无日志；建议至少 logger.warning + 计数。
- **n4**：`sync.py:89-95` restart() 只清状态不重订阅，恢复依赖宿主调用 `resynchronize()`（runtime.py 71-83）——当前靠 Hub 继续主动推批自愈，语义未在报告中写清。
- **n5**：token 未校验长度/base64url（discovery.py 121-123），与 §2.1「32 随机字节」不对齐（Hub 侧才是权威，影响小）。

### Praise

- claims 洁净：`resource_claims`/`session_source_key` 严格只由 registryDir 派生，测试还反向断言不含 token/pid/getpid（provider.py 195-214 / test 138-161）。
- `probe()` 以握手而非 pid 判活，直接规避 DSH pid 复用误判教训（discovery.py 189-215）。
- `runtime.error` 只记录白名单码、绝不打日志原生 message（client.py 286-292，测试 242-278 验证不含 PRIVATE_SESSION_JSON/private-token）。
- 解除反向请求、8 MiB、identity 校验均有正向测试，不是纸面实现。

## 3. 测试质量（21 个新测试）

覆盖到的：握手+通知+断链不误报 exit、-32601 反向请求、非 opencode 身份拒绝、runtime.error 脱敏、begin/items/commit 只发布一次、先 ingest 后 ack、notifications 转发、检查点实例隔离、discover 不碰注册表、probe 清理 stale、inventory 重复/游标循环拒绝、snapshot 跨页一致性、只读转发方法名序列。

盲区与假绿：
| 类型 | 位置 | 问题 | 建议 |
|---|---|---|---|
| 假绿风险 | test_opencode_live_transport.py 38-49 | host 用 `SimpleNamespace`/AsyncMock 伪造 → `timeline_sync(..., complete=, metadata=)`、`session_meta_upsert(...)` 的**关键字签名写错也不会失败**（AsyncMock 接受任意签名）。已人工核对 host.py 114-123 与 sync.py 177-185 一致，当前无错位，但防护为零 | 改用 `AsyncMock(spec=RuntimeHostClient)` 或真实 ConnectorRuntimeHost |
| 断言过弱 | test_opencode_bridge_client.py 186-239 | 只断言 `"identity" in str(exc)`；**协议主版本不匹配（identity.protocolVersion="2.0"）路径零覆盖**（client.py 123-129） | 补一条 protocolVersion="2.0" 用例 |
| 断言过弱 | test_opencode_provider.py 258-275 | 「不 spawn」只用私有属性 `runtime._restart_task is not None` 佐证，未断言未创建子进程 | monkeypatch `asyncio.create_subprocess_exec` 为 fail |
| 盲区 | — | 无任何解码失败路径测试（未知 type/status/contentHash 漂移 → 当前行为是整页丢弃，见 M1）；无空行/超大帧断链测试（m2）；无 `_checkpoint` 非法值/缺键测试（m1）；probe 只测了「连接被拒」，未测「握手超时是否删文件」（M4） | 每个 Major/Minor 补一条回归用例 |
| 盲区 | — | 无 location 隔离用例（M2）、无 historyHash 上报用例（M5） | 契约确认后补 |

## 4. 明确区分

**违反规格（必须改）**：M1（§6①）、M2（§6⑤）、M5（§2.6）、m3（§2.3 rev2 partial 上报）。
**风险型缺陷（强烈建议改，规格未直书）**：M4（超时删文件）、m1、m2、m4、m5。
**改进建议（可选）**：m6、n1-n5、测试加固项。
