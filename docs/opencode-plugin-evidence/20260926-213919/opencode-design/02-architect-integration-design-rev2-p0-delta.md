<!-- tm_board_write · 2026-09-26T17:24:58.009Z · role=architect · session=20260926-213919 -->
<!-- tm_board_write · role=architect · session=20260926-213919 · delta rev2 -->
# OpenCode V2 接入 — 集成设计 rev2（P0 实证 delta）

> 基线：`01-architect-integration-design.md`（rev1）。本文件只改 §2.3 / §2.4 / §2.5 / §4（含 §4.1/§4.2）/ §8.3，并新增 §6「对已开工实现的潜在影响」。
> **未改动**：三条已批架构决策（插件 ctx 数据面 / 插件 spawn Connector / 单 bridge 注册表）、§5 账号验证方案、§3 Connector 模块划分。
> 实证来源：`..\opencode-p0\01-implementer-spike-results.md`（opencode-cli 2.0.18）。档位：【已实证】=P0 实测；【设计假设】=待验，见 §8.3。

## 0. 变更清单

| # | 章节 | 动作 | 一句话 |
|---|---|---|---|
| 1 | §2.3 | 改 3 行 | session.list 数据源改 Hub 自持注册表；getSnapshot 投影源=实测事件集；steerTurn 维持 false |
| 2 | §2.4 | **重写** | TUI 面改为 api.client + api.state.session.*；会话发现新方案（裁定①，见 §2.4.3） |
| 3 | §2.5 | **整表替换** | 源列=实测事件清单；新增投递规则行；6 事件不在 SDK 类型内 → 防御式解析 |
| 4 | §4 | 改 | 导出契约写成实测 `export default {id, setup|effect}`；TUI 入口按 A10 |
| 5 | §8.3 | 改 | A3 证伪；A4 升已验证；新增 A10/A11/A12 |
| 6 | 新 §6 | 新增 | 对已开工（P2 §3）实现的潜在影响 |

## 1. §2.3 JSON-RPC 方法表 — 3 行修订

（表其余行不变，仅替换下表 3 行。）

| 方向 | method | params | V2 差异 / 备注（rev2） |
|---|---|---|---|
| C→B | session.list | {limit,cursor} | **改**：数据来源 = **Hub 自持会话注册表**（全局 `event.subscribe` 增量填充，见 §2.4.3 方案①）；**不再经 TUI `ctx.rpc`**（TUI 侧无 rpc，A3 证伪）。注册表未完整时 `runtime.getCapabilities` 上报 `sessionDiscovery:"partial"`。 |
| C→B | session.getSnapshot | {sessionId,limit} | **改**：投影输入 = **§2.5 实测事件集**（session.text.* / reasoning.* / tool.* / step.*）；检查点序号取 `durable.seq`（仅可持久 session 事件携带 durable）。投影全在插件侧。 |
| C→B | session.steerTurn | {sessionId,content} | **维持**：capability=false。实测 `ctx.session` 方法集 = create/get/prompt/interrupt/update/move/wait/switchModel/switchAgent/context/generate/command/synthetic，**无 steer、无 list**。 |

## 2. §2.4 — 两条数据通道（重写）

### 2.4.1 能力面【已实证】
- **服务端 ctx**：有 session/prompt/create/interrupt/permission/event.subscribe/**rpc**，**无 session.list、无 client**。
- **TUI 面**：`api.client`（完整 `OpencodeClient`，HTTP SDK，含 `session.list`、`permission.reply`）+ `api.state.session.{get,messages,status,permission,todo,diff,count}` + `api.event`（`TuiEventBus.on(type,handler)`）。**`form.reply` 在 TUI API 中不存在** → 原 §2.4 记述作废。
- **ctx.rpc**：服务端存在（函数带 `.register`），但 **TUI 侧无 rpc** → 「TUI↔服务端经 rpc 对账」不成立（A3 证伪）；rpc 真实对端待 P1 确认。

### 2.4.2 会话发现候选
| 方案 | 机制 | 代价 / 缺陷 | 依赖 |
|---|---|---|---|
| ① Hub 自持注册表 | 单次全量 `event.subscribe`，按 type + location.directory 增量填表 | 冷启动盲区：插件加载前已存在的会话不可见，直到其再发事件 | 无（仅依赖已实证的全局事件流） |
| ② TUI 写文件 + Hub 读 | TUI 插件定期把 `api.client.session.list` 结果原子写文件，Hub 轮询/读 | 依赖 TUI 入口成功装载（A10 **未通过**）；引入文件轮询 | A10 |
| ③ Hub 直连服务端 HTTP | 插件用 loopback 调服务端自身 session HTTP API（与 api.client 同源） | base URL/端口发现方式未实证；可能触发鉴权 | P1 探针 |

### 2.4.3 裁定：**方案① 为 P1 绑定方案**
- **理由**：仅依赖【已实证】的全局事件流，零新进程/零新通道，不被 A10 阻断；会话按 `event.location.directory` 归属到各 location，天然支持「每 location 一 runtime」。
- **代价**：冷启动盲区；无 cost/hierarchy（那两项仅在 TUI/HTTP 侧）。
- **降级行为**：注册表标记 `partial`；`session.list` 只回已知集合；AA 侧展示可能不全；会话一旦发事件即出现。**可选增强**：P1 探针 ③，成功则补冷启动与 cost。
- **方案②定位**：A10 解决后的增强通道，**不作为 P1 依赖**。

## 3. §2.5 — 事件→timeline 投影映射表（整表替换）

**投递规则（新增行，必须写死）**：`ctx.event.subscribe()` **必须单次全量订阅**；**传入 type 不过滤**（同一事件被所有订阅者收到）；插件侧按 **`event.type` + `event.location.directory` 双重过滤**；事件流**跨 location 全局**。信封：`{id,created,type,durable?{aggregateID,seq,version},location{directory,workspaceID},data}`。

| 实测源事件 | AA type | status | role | 说明 |
|---|---|---|---|---|
| session.next.prompted / session.inbox.enqueued / session.execution.started | message / turn.start | done | user | 用户投递/回合开始 |
| session.text.started / session.text.delta / session.step.streamed | message | inProgress→done | assistant | 文本增量累加，落 contentHash |
| session.reasoning.started / session.reasoning.delta | message | done | assistant | metadata.reasoning=true（data 含 ordinal/state） |
| session.tool.input.started / input.ended | tool | pending | tool | 工具名/参数成形 |
| session.tool.called | tool | running | tool | `executed` 区分「仅生成未执行」 |
| session.tool.progress / success / failed | tool | running/done/failed | tool | 结果/错误见 content/error |
| permission.asked | —（不进 timeline） | — | — | → SessionNotice(interaction)，§6 |
| permission.replied | —（不进 timeline） | — | — | 应答后关闭通知 |
| session.execution.interrupted / session.step.failed / session.error | turn.end | cancelled/failed | — | 结束态 |
| session.idle / session.step.ended | turn.end | done | — | 正常结束；step.ended 带 cost/tokens/snapshot |
| session.created / session.deleted | turn marker | — | — | 注册表增减 |
| session.usage.updated / session.status / session.instructions.updated | —（记账/忽略） | — | — | 可选：成本/状态缓存 |
| shell.created / shell.exited / shell.deleted | tool(shell) | running/done | tool | 与 session.tool.* 去重 |
| provider/model/agent/command/skill/reference/integration/plugin/websearch.updated、models-dev.refreshed（data={}） | —（忽略） | — | — | 域目录变更，不进 timeline |

> **类型定义不可信**（【已实证】）：实测至少 6 个事件名在 `sdk/dist/v2/gen/types.gen.d.ts` 与 `sdk/dist/gen/types.gen.d.ts` **0 命中**——`session.step.started`、`session.step.ended`、`session.tool.called`、`session.tool.success`、`session.reasoning.delta`、`shell.exited`（另有 `message.updated` 只在类型里、实测未发射）。
> **⇒ 解析规则**：**不得依赖 SDK 类型定义**；以运行时刻实测清单为准 + **防御式解析**（未知 type / 缺字段 → 跳过并计数，绝不抛错）。旧表「用 hook 而非事件保证可靠」作废：V2 已无 `tool.execute.*` hook。
> **计数核对**：报告自述「27 种 session.*/shell.*/permission.*」；逐条清点为 session.* 24 + permission.* 2 + shell.* 3 = **29 个名字**（另有 10 个 *.updated 域事件）。P1 以运行时刻重新 dump 为准并固化白名单。

## 4. §4 插件包结构 — 修订

- **导出契约【已实证】**（宿主原文：`Plugin must export a default definition with an id and an effect or setup function`）：
  ```ts
  export default { id: "agents-anywhere-opencode", async setup(ctx) { /* ... */ return () => cleanup() } }
  ```
  - 必须是**对象**，含 `id` + `setup|effect`；`setup()` 的**返回值被当作 cleanup**（A4）。
  - V1 形状 `export const X = async (input) => ({...hooks})` 在 V2 **加载失败**（quota@latest 同类问题坏掉，旁证）。
  - 文档中 `Plugin.define({id, setup|effect})` 是否与直接 `export default {id, setup}` 等价 → **未实证，P1 核验**（A12）。
- **TUI 入口**：`export default { id, tui }`（类型已证 `TuiPluginModule`，**装载未实证**）。`cli.json` 写本地绝对路径**两次均未初始化 TUI 模块**（日志有 `role=cli ... plugin reconciliation ... plugins=12` 但无 TUI 输出）→ 按 **A10** 处理，P1 对照 `opencode plugin add` / npm spec / package.json 包装三形态。
- `src/server/index.ts` 与 `src/tui/index.ts` 按上式替换；其余文件职责不变。

### 4.1 / 4.2 增补（不改原条目）
- §4.1-**5（审批中立）**【已实证】：`hook("evaluate", cb)` 单参 payload（`{sessionID,agent,action,resources,metadata,source,effect}`），cb 结果被 `Promise.resolve` 包裹（**可异步**）；返回 `undefined` → effect 保持 `ask`、请求未被自动放行。**补一句**：返回字符串能否改写 effect **未测**（A11），**P1 证实前远端放行/拒绝路径不得依赖该改写**。
- §4.1 **新增**：事件处理**必须先按 `location.directory` 过滤**（流跨 location 全局，实测）。
- §4.1-**1（绝不抛错出链）**：hook 链抛错中断整链**未测**，仍为【设计假设】。
- §4.1 **新增（命名不校验）**：`permission.hook(name, cb)` **任何名字都注册成功** → **不得用「注册成功」判断 hook 名有效**，能力探测须以实测触发为准。
- §4.2 **热重载【已实证】**：写被 watch 的文件 → 旧实例 `setup` 返回的 cleanup 被调用（`17:17:54.976 setup.invoked → 17:18:54.611 cleanup.called → 54.614 setup.invoked`，同 pid，2 次）→ 从假设升为事实。

## 5. §8.3 未决假设清单 — 修订

| # | 假设 | 置信/判定 | 验证方法 |
|---|---|---|---|
| A1 | V2 事件枚举名与字段 | 【已实证·名称层】 | P0 已 dump；**不得以类型定义核对**（6 名 0 命中）；P1 固化运行时刻基线 |
| A2 | `permission.reply` 签名与 hook 语义 | 【大部分已实证】 | 运行时 ctx 实测（类型 1.18.24 不含 ctx.permission/event/rpc）；evaluate 已触发；返回串改写待测（A11） |
| A3 | `ctx.rpc` 作 TUI↔服务端通道 | **【通道不成立（已证伪）】** | 服务端 ctx.rpc 结构存在但 **TUI 侧无 rpc**；改走 `api.client`；rpc 真实对端 P1 确认 |
| A4 | 热重载重放 hooks + dispose | **【已验证】** | P0 触发热重载 2 次（cleanup+重放，同 pid） |
| A5 | 一 service 进程内多 location 各初始化实例 | 【高】 | 用户已实测 |
| A6 | ctx.storage 不适合跨工具共享密钥 | 【高】 | 文档 + 复用语义 |
| A7 | `session.list`/成本/层级仅 TUI(+HTTP) 可用 | 【高·细化】 | 实测 server ctx 无 session.list；数据面 = api.client / api.state.session |
| A8 | 32B endpoint token + 原子发布对齐 DSH | 【高】 | 复用 DSH 已验证实现 |
| A9 | `instance_policy="multiple"` 承载「每 location 一实例」 | 【高】 | 契约 instance_models.py:16,210-216 |
| **A10** | `cli.json` 装载本地路径/包形态 | **【新增·未通过】** | P1 三形态对照：`opencode plugin add` / npm spec / package.json 包装 |
| **A11** | `permission.hook` 返回字符串能否改写 effect | **【新增·未测 → 远端放行禁用】** | P1 隔离沙箱实测 allow/deny 返回值；未证前远端走 `permission.reply`，不走 hook 改写 |
| **A12** | `Plugin.define(...)` 与 `export default {id,setup|effect}` 等价 | 【新增·中】 | P1 读 @opencode-ai/plugin 2.x dist + 实测装载 |

## 6. 对已开工实现的潜在影响（不改 §3 正文，P2 正在实施）

| 位置 | 影响 | 建议动作 |
|---|---|---|
| §3 `bridge/models.py`（解码） | 事件名不在 SDK 类型内（6 名 0 命中）→ 严格 schema 会误拒 | 解码保持**宽松/版本化**：未知字段/类型跳过并计数，**绝不抛错** |
| §3 `runtime.py` / `sync.py` | Hub 会话发现为 **partial**（冷启动盲区）→ 会话会中途出现 | 允许 `session_meta` **迟到 upsert**；不假设启动即全量；`session.list` 缺失项不视为错误 |
| §3 `sync.py`（检查点） | 序号源确认为 `durable.seq`（仅可持久 session 事件）；非全部事件带 durable | 检查点只对带 durable 的事件推进；其余按位置/时间兜底 |
| §2.3 session.list 语义 | 数据源换为 Hub 自持注册表（非 TUI） | Connector 侧契约不变（仍 C→B），**无需改 §3 模块**；仅语义上的 partial 需容忍 |
| §2.4 每 location 实例 | 事件流全局、Hub 单例 → 归属靠 `location.directory` | runtime 请求快照时须带 location 过滤；Hub 按 location 归表 |

> **确认不受影响**：三条已批架构决策（插件 ctx 数据面 / 插件 spawn Connector / 单 bridge 注册表）、§5 账号验证、§3 模块划分与注册点均无需改动。
