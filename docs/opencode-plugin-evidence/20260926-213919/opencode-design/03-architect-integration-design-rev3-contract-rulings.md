<!-- tm_board_write · 2026-09-26T17:34:03.663Z · role=architect · session=20260926-213919 -->
<!-- rev3 · 契约裁定 delta -->
# OpenCode V2 接入 — 集成设计 rev3（契约裁定 delta）

> 基线：rev1 `01-architect-integration-design.md` + rev2 `02-...-rev2-p0-delta.md`。
> 输入：P2 正确性评审（4 Major / 5 Minor / 5 Nit）。
> **只动 §2.2 / §2.3 / §2.6 + 新增「契约补充（rev3）」**。未改三条已批架构决策、§5 账号验证、§3 正文（P2 已实现，改动以契约补充表达）。

## 0. 变更清单

| # | 章节 | 动作 | 一句话 |
|---|---|---|---|
| 1 | §2.2 | initialize 参数表 **+location 行** | location 是 opencode 连接的必填身份，Hub fail-closed 过滤 |
| 2 | §2.3 | subscribe **+historyHash**；capability 新增 `session.discovery` metadata | 前缀校准；partial 走 metadata 布尔恒真 |
| 3 | §2.6 | 补「throughSeq 语义由 Hub 保证」 | Connector 逐字持久化、不推导 |
| 4 | 新「契约补充（rev3）」 | 新增 | 跳过计数器所有权 + 端点删除规则 + Nit 裁定 |

## 1. §2.2 修订 — initialize 增 `location`（裁定 1／评审 M2）

| 方向 | method | params | 备注 |
|---|---|---|---|
| C→B | initialize | authToken, protocolVersion, runtime, connectorId, sessionNamespace, clientInfo, **location?** | opencode runtime 必填；Hub 侧按 §6① 容忍未知字段 |

- **字段名**：`location`，string，绝对目录。
- **可选性**：JSON-RPC 层可选；**runtime=="opencode" 时必填**。Hub 收到 opencode 连接但 `location` 缺失/空/非绝对路径 → initialize 回错误并 **close**（fail-closed，杜绝串台）。非 opencode 桥缺省=无过滤（兼容）。
- **规范化（两侧同规则）**：realpath + 去尾分隔符 + 反斜杠统一为 `/`；win32 再 casefold，其余精确匹配。匹配对象 = 事件信封 `location.directory`。
- **Hub 过滤规则**：只把规范化后 `location.directory == 连接 location` 的会话/事件纳入该连接；`session.list / getSnapshot / getState / getNotices` 与 `sync.batch` 推流一律按此过滤；其它 location 的会话对该连接不可见。
- **Connector 传值规则**：`values["location"]`（provider_config.py:38-43 已有）→ initialize；并把 location 升为 opencode 实例必填（缺则 start() 拒绝 + health `runtime_unavailable`）。同步修 `select_endpoint`（discovery.py:164-167）：已配置 location 且端点 `locations` 为空或不含该 location → **拒绝返回 None**，不再放行。
- **为何不选 (b) sessionNamespace 编码**：sessionNamespace 供 `host.session_namespace` 派生平台会话身份（host.py:43-46 / runtime.py:289-291），编进路径会改会话身份与 claims 语义、并泄漏路径 → 违反 A9。选 **(a)**。

## 2. §2.3 修订 — subscribe 增 `historyHash`；partial 走 metadata（裁定 2/3／评审 M5、m3）

| 方向 | method | params | 备注 |
|---|---|---|---|
| C→B | runtime.sync.subscribe | {sessionId, fromSeq?, **historyHash?**} | 触发 sync.batch；historyHash 用于前缀校准 |
| B→C | runtime.getCapabilities | — | 新增能力行 `session.discovery`，其 `metadata.discoveryState` 承载 partial |

**裁定 2（partial 载体）**：新增常量 `CAPABILITY_SESSION_DISCOVERY = "session.discovery"`；用该能力行的 `metadata`（RuntimeCapability.metadata，models.py:151）承载：`metadata.discoveryState ∈ {"complete","partial"}`，可选 `metadata.blindSessionCount:int`。partial→complete 时 Hub 经 `runtime.capability.updated` 重发（Connector 已处理 sync.py:264-267）。**AA 零改动**：AA 只读 supported/available/allowed（provider_config.opencode_capabilities:123-147），metadata 不影响。不选新布尔能力：布尔通道仅承载 supported/available/allowed，新布尔会被 AA 误当可 gate 的能力。

**裁定 3（historyHash）**：`subscribe` 增可选 `historyHash`（string，64 位小写 hex，同 checkpoint 校验）。Connector 从 `read_checkpoint` 取哈希，与 `fromSeq=throughSeq` 一并发。Hub 语义：
- 有 fromSeq+historyHash 且前缀一致 → **增量续推**（begin 带 `resume:"incremental"`）。
- 前缀不一致 / fromSeq 有而 historyHash 缺 / fromSeq 越界 → 发 `phase:begin` **全量快照**（complete:true）。
- 二者皆无 → 全量快照。Hub 不识别该字段必须忽略（不报错）。
- **硬性**：Hub 绝不只凭 fromSeq 静默续推。

## 3. §2.6 修订 — 检查点责任显式划给 Hub（评审 §6③）

- `throughSeq` 语义 = 「本连接已投递、且**仅由 durable 事件推进**的最大 `durable.seq`」。**由 Hub 保证**（Connector 不可判）；非持久事件不得推进该值。
- `fromSeq` 语义 = 「严格从该 durable.seq 之后续推」。
- Connector：checkpoint **逐字持久化、不推导**；仅在 ingest 回调完成后写（保持 sync.py:214-224 现状）。

## 4. 契约补充（rev3）

### 4.1 跳过计数器所有权（裁定 4／评审 M1）
**契约级**：未知项/item 级 **skip + 计数 + 绝不抛错**（rev2 §6①）。models.py:191-218 的校验改为「返回失败 → SyncRelay 跳过并计数」，sync.py:151-155 加 item 级 try；通知解析同样宽容。

| 计数器 | 归属 | 理由 | 禁则 |
|---|---|---|---|
| `skippedEventCount` | **Hub 自持** | 只有 Hub 看得到原生 OpenCode 事件 | Hub 不得发 skippedItemCount |
| `skippedItemCount` | **Connector 自持** | 只有 Connector 跑规范解码器 | Connector 不得推导 skippedEventCount |

- **Hub→Connector**：`sync.batch` 增可选顶层 `diagnostics:{skippedEventCount:int≥0}`（begin/commit 均带，按流累计）。Connector 宽容解码，缺省忽略。
- **Connector→AA**：合并进 commit 时 `host.timeline_sync(..., metadata=...)` 已有 metadata → `metadata["syncDiagnostics"] = {"skippedEventCount":int|null,"skippedItemCount":int,"updatedAt":iso8601}`。AA 无需改动（自由 metadata）。**不用 runtime_health_update**：其语义是实例健康，非会话计数，误用会伪造健康态。

### 4.2 端点文件删除判定（评审 M4）
- **可删**：D1 文件不可解析（parse_endpoint 抛错，永不能认证）；D2 连接被拒（ConnectionError/OSError，无任何响应）且 pid 非存活；D3 协议主版本确定性不匹配。
- **只记 debug 保留**：K1 **握手超时（Hub 忙）——绝不因 2s 超时删除**；K2 瞬时 IO/未知异常。
- 补充：Hub 应启动/周期自清并重写自身端点文件；Connector 删除仅为兜底。

### 4.3 Nit 裁定
- **升为契约**：n3 QueueFull 必须 warning + 计数 + 触发 resync（不得静默丢批）；n4 `restart()`／任何内部恢复后必须重订阅（resynchronize）并重校准。
- **保持实现自由**：n1（文件名↔内容交叉校验，仅诊断）、n2（本地超大帧不得映射为上游错误——属缺陷非契约）、n5（token 长度校验，Hub 为权威）。
- **实现缺陷（非契约）**：m1 `_checkpoint` 缺键 KeyError、m2 空行误断链、m4 features=null、m5 解码 ValueError 未包装。M2 在当前契约下属**规格违反**（本 rev3 生效）。

## 5. 两侧实现要点

**P1 Hub（插件侧）**：① initialize 解析 location，opencode 缺则报错 close；② 按 location.directory 规范化过滤 per-connection 视图；③ `session.discovery` 能力行 metadata.discoveryState，翻转发 capability.updated；④ subscribe 读 historyHash 做前缀校准，不一致→全量 begin，绝不凭 fromSeq 盲续；⑤ throughSeq 仅由 durable.seq 推进；⑥ begin/commit 带 diagnostics.skippedEventCount；⑦ 自清/重写端点文件。

**P2 Connector（已交付，需按本 rev3 修订）**：① initialize 带 location（必填）+ provider_config 校验 + select_endpoint 拒绝修正；② subscribe 带 historyHash；③ item 级 try + skippedItemCount + 通知宽容 + 发布 syncDiagnostics metadata；④ 透传 Hub 的 skippedEventCount；⑤ 修 m1/m2/m4/m5；⑥ QueueFull→warning+计数+resync，restart 后重订阅；⑦ 端点删除按 D1/D2/D3，超时不删；⑧ claims/source_key 不变（仅 registryDir）。
