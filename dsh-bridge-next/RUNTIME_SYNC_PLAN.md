# DSH 会话过滤、Timeline 过滤与事件同步实施方案

状态：**用户已确认，进入实施。** 本轮增加官方项目同步和纯文本发送；附件单独实现。

日期：2026-09-07。基于当前分支 `feat/benson-0905`、读取阶段提交 `02046ec9`；目标安装依赖为 DSH `0.1.2-rc.1`。

本文件覆盖一起交付的修改：官方侧栏规则过滤会话、丢弃内部 notice、项目及归属同步、首次历史校准、实时事件与断线恢复，以及从平台发送纯文本。用户已确认本文中的可见性、投影撤销和完整快照替换语义。

## 1. 交付目标与边界

- 只有符合 DSH 官方侧栏可见条件的会话进入 AA。过滤发生在插件 Host，早于生成平台会话和 Timeline、传输及数据库写入。
- 被过滤会话不创建占位行，不发送归档会话元数据让 Server 代为隐藏，也不允许绕过列表接口读取其详情。
- DSH 内部运行记录不进入统一 Timeline，也不换个字段塞进 `details`、`source` 或 `metadata`。
- DSH 的正常同步改为首次建立基线、持续事件推送、连接异常后的补偿。正常空闲时不定期枚举会话或全量读取历史。
- DSH 事件解释、可见性和 Timeline 转换留在插件；Python DSH adapter 只做协议转换、顺序交付与恢复。
- 本期接入从 AA 发纯文本、创建会话与继续已有会话，并沿用 DSH 官方 Agent 生命周期。附件、模型设置和审批应答不在本次实现范围；能力声明必须与实际实现一致。
- 沿用当前分支。其他 Runtime 的扫描策略、Desktop Workbench、登录和 onboarding 业务不在修改范围。

## 2. 已核实的现状

| 位置 | 当前行为 | 本期需要解决的问题 |
| --- | --- | --- |
| `src/host/dsh-runtime/router.ts` | `listSessions()` 全部返回，每条都标记 `changed=true` | 归档、空会话和子代理进入同步；每轮重复读历史 |
| `src/host/dsh-runtime/history.ts` | 非人类的 user-role 文本及兜底事件变成 `system / notice` | 内部队列、提示词、技能目录等落入 Timeline |
| `src/host/dsh-runtime/server.ts` | 鉴权后的请求/响应，没有主动订阅和推送 | 无法及时响应新会话、归档和消息变化 |
| `connector/connector/server/runtime_sync.py` | 所有 Runtime 共用循环，一轮结束后默认等 30 秒 | DSH 没有独立的事件同步模式 |
| `connector/connector/runtimes/dsh/runtime.py` | 有分页读取与重连；通知只转发少量类型 | 缺少完整的基线、生命周期及恢复流程 |
| `connector/connector/server/ingest.py` | 同步 `ingest_notifications()` 可检查服务端拒绝；普通后台队列失败会丢弃通知 | 取消扫描后不能依赖这个队列兜底补齐 |
| Server `session.source.updated` | 可能补建会话行，再记录归档等来源状态 | 不能用它实现“过滤会话不入库” |
| Server `timeline.sync` | 完整快照可以替换已有 Timeline | 可用于清理旧 notice，但必须完成分页并建立事件顺序屏障 |

本机诊断样本共 14 条会话：4 条归档、3 条非当前空会话、1 条子代理，剩余 6 条与截图中 DSH 侧栏一致。数字只是验收样本，不能写进实现。

## 3. 会话过滤：精确复现官方函数

官方代码位于 `packages/client/ui-workspace/src/client/tree.ts` 的 `sessionVisible()`。工作区模式与平铺模式都使用它：

```ts
return session.origin !== 'subagent'
  && !archived.has(session.id)
  && (!session.blank || session.id === current)
```

### 3.1 三个条件的数据来源

| 条件 | 读取方式 | 必须保留的语义 |
| --- | --- | --- |
| 子代理 | 原生 `SessionHeader.origin` | 只有 `origin === 'subagent'` 隐藏；普通 fork 即使有父会话仍可见 |
| 归档 | `ctx.workspaceRegistry.archivedSessionIds` | 使用官方工作区服务；不靠标题、目录或自建归档文件猜测 |
| 空会话 | 原生日志是否曾出现 `turn/start` | 没有标题不等于空；执行设置命令也不一定使会话变为非空 |
| 当前选择 | 官方客户端 `ctx.sessions.list` 快照的 `current` | 当前选中空会话是官方明确保留的例外 |

冷会话只在建立基线、恢复或该会话发生相关变化时读取必要的元数据/事件。允许借助本版官方查询能力确认是否出现 `turn/start`；缓存的 `blank=true` 必须核实，不能因旧缓存误过滤已开始的会话。

过滤只影响 AA 投影，不修改 DSH 原生日志。读取失败、归档服务未就绪和客户端基线未就绪都不当作“没有会话”；此时不能提交用于删除旧投影的完整空清单。

### 3.2 当前空会话的前端状态

不能在 Host 中凭空生成 `current`，也不能悄悄省略官方的这个例外。本方案包含一小段不带 UI 的客户端状态桥接：

1. 插件客户端挂载时订阅官方 `sessions.list`，通过独立的 runtime presence 接口上报 `clientId / revision / currentSessionId`。
2. 它不依赖手机连接 Modal 是否打开，不把 runtime 状态接口挂在 onboarding manager 上。
3. Host 自己读取会话 origin、归档和 blank；客户端只报告当前选择，不能提交任意“可见会话清单”。归档和子代理始终优先过滤。
4. 选择变化立即上报；旧 revision、旧连接的迟到报告不能覆盖新状态。客户端重连后重新上报。
5. 优先绑定官方网关的连接生命周期；若目标安装版没有可用的连接级销毁通知，使用独立 presence 租约兜底：15 秒续租、45 秒过期，卸载主动释放。该心跳仅续租当前选择，不扫描会话或历史。
6. 无界面运行时，没有客户端选择，`current=undefined`，按原函数过滤所有空会话。

**多客户端拟定规则**：同一 DSH Host 同时有多个在线客户端时，以各客户端应用官方函数后的可见集合之并集作为同步集合；即任一在线客户端选中的空会话可以出现。单客户端与该侧栏完全一致。官方不存在跨客户端唯一 `current`，这是本方案明确提出的聚合规则，供用户确认。

### 3.3 所有读取与事件使用同一道门

新增 `visibility.ts`，供这些入口共用：首次清单、`session.list`、详情/状态读取、事件发布、重连补偿及历史迁移。

- 列表先过滤再分页，游标绑定这一份可见集合；空会话与归档数据不穿透到 Connector。
- 详情入口重新校验可见性。会话变为不可见时，立即撤销其历史分页捕获，不继续返回之前捕获的后续页面。
- `session/created` 先纳入本地观测，不直接导入。首次 `turn/start` 或客户端选择变化使它符合规则时，才发布平台会话。
- 普通 fork 要读取它继承的历史；继承内容不会逐条重新发 `session/event`。
- 被过滤子代理仍可在父会话的真实工具调用中出现；不为其另建平台会话或同步子会话详情。
- 归档集合由 `domain/changed` 的 `workspace` 全局状态变更驱动。使用事件携带的已提交新值比较前后集合，只处理受影响的会话，避免读到尚未更新的服务缓存。
- `session/disposed` 表示退出 live store，不表示归档、删除或隐藏；是否仍可见要考虑原生持久化。

## 4. 过滤后不留业务记录：首次过滤、状态变化、旧数据

### 4.1 从未导入的会话

插件直接忽略，不发 `session.meta.upsert`、来源状态、Timeline 或占位数据。必要的原生筛选和本地同步控制状态不属于平台业务数据。

### 4.2 曾可见、之后归档或失去空会话例外

按本次“不进数据库和业务逻辑”的要求，本方案采用**撤销 AA 同步投影**：删除该 Runtime 导入的会话行、Timeline 和关联的派生缓存/索引，而不是只打 `archived` 标记保留它。

为已发布过的 ID 发送最小的 `session.projection.remove` 控制操作；它不能创建不存在的会话，也不携带被过滤会话的标题或消息。原始 DSH 会话和文件不变。以后官方状态使该会话重新可见时，再以稳定 ID 读取并导入。

需要一个通用的 Server 投影撤销能力，因为当前来源状态接口不能满足此语义。所有操作受已认证的 `connectorId + runtimeId` 约束，并验证会话归属。不会清除其他 Runtime、设备、用户或工作区。

### 4.3 已被当前版本误导入的数据

新版本的首次完整基线同时承担一次迁移：

1. 生成本 Runtime 的准确可见清单，形成待撤销的旧投影 ID 报告。
2. 在完整、成功的可见清单提交后，撤销该 Runtime 以前导入、现在不在集合中的同步投影。
3. 对仍可见会话，用新投影版本的完整快照替换旧 Timeline，清除已存的 notice。
4. 保存本次投影版本的完成标记。普通重连不重复做版本迁移，但仍核对当前可见清单。

读取失败、清单分页未完成或归档状态未知时禁止批量撤销。当前这轮只写计划，不执行迁移或删除。历史投影清理也是用户确认后拟实施的范围。

## 5. Timeline：内部事件在源头丢弃

将 `history.ts` 的“未匹配事件一律生成 notice”改为显式支持的事件集合。历史与实时流共用一个投影器，避免历史干净、实时又插回内部记录。

| 原始内容 | 本期处理 |
| --- | --- |
| `approval/policy` | 不生成 Timeline |
| `agent/inbox/spliced` | 不生成 Timeline |
| 环境、系统提示词、技能目录等注入的 `user/message` | 不生成 `system / notice`；不伪装成人类消息 |
| `session/title-llm-request` | 不生成 Timeline |
| `command/run`、`command/done` 等本轮截图中的设置命令流水 | 不生成 Timeline |
| 原有 quiet events、未知信息事件 | 不生成兜底 notice；本地只记录受控事件类型计数，不输出原始内容 |
| `session/title` | 更新会话标题，不进入 Timeline |
| 真正用户消息、assistant 文本、reasoning | 保留，并沿用真实来源与稳定 ID |
| tool call/result、错误结果、嵌套工具调用 | 保留既有结构化映射 |
| 历史 `approval/asked` / `approval/decided` | 保留结构化授权记录，不产生新的可操作审批 |
| turn/start、turn/end、compaction | 保留轮次、结束原因和上下文压缩语义 |

不能简单删除所有 `system` 类型，因为 reasoning、轮次结束及部分有效记录也使用它。也不能按显示文字是否包含 `notice` 过滤。

非人类 `user/message` 不能全部冒充用户；本期按已核实来源明确跳过内部注入。其他原生业务来源只有建立明确映射和测试后才能输出，禁止恢复通用 JSON notice 兜底。

原始序号仍用于补偿与去重：跳过某个事件的显示，不代表序号不存在。标题事件虽然不进 Timeline，也必须推动会话元数据更新。

## 6. 事件驱动的总体流程

```text
DSH 官方事件 / 工作区状态 / 客户端 current
  → 插件 NativeObserver
  → VisibilityGate
  → SessionProjection（历史和实时同一转换器）
  → SyncFeed（有序、限量、可确认）
  → Connector DSH adapter（仅标准协议）
  → Connector 可靠同步交付
  → Server 提交数据库并确认
  → 客户端列表和 Timeline 失效通知 / 增量更新
```

DSH 插件不建立第二份持久化会话内容库。DSH 仍是原始内容来源；插件只使用有上限的内存投影/队列，Connector/Server 保存必要同步游标和提交状态。

### 6.1 首次连接：先订阅，再建立基线

1. 插件启动时在 Host 根作用域监听 `session/created`、`session/event`、`session/disposed`、`agent/status` 及 `domain/changed`，确保包含在 DSH 客户端创建的会话。
2. Connector 订阅后，为该订阅建立 stream 和有界事件缓冲，进入 `baselining` 状态。
3. 读取原生清单、归档集合、当前选择快照，应用官方过滤条件；只对允许的会话读取历史。
4. 每份历史捕获记录原生末尾 `seq`、投影版本和可见性 revision；分页沿用同一捕获。
5. 按会话提交元数据和完整的新 Timeline。首次同步允许读取正在运行的会话：取到哪一个 seq，就把之后的事件留给缓冲。
6. 每个会话只重放基线 seq 之后的缓冲事件。基线期间发生归档、当前选择变化或新建时，按可见性 revision 再校正；不可见历史不能继续发布。
7. 完整可见清单成功提交后，才允许 Server 撤销旧投影。然后进入 `live`。

这解决“先读取，稍后才监听”造成的漏消息，以及“先推新事件，又被旧完整快照覆盖”的竞态。

### 6.2 正常运行：只处理变更

- 新会话进入可见集合：先发会话元数据和该会话基线，再发布后续增量。
- 文本/reasoning 流片段：按稳定 item ID 合并更新，建议 50 ms 合并窗口；消息结束、工具结果、turn/end 立即冲刷。
- 工具：call/result 归并到同一工具项；不能每收到一个片段就重新折叠整份历史。
- 改名、运行状态、归档与可见性变化：即时处理，不等待 30 秒。
- 最终消息丢弃的未执行工具草稿，需要标准 `timeline.item.remove` 或等价的有序替换操作；仅 upsert 无法删除已经推送的草稿。
- 安静的 Runtime 没有枚举清单和全量历史读取。批次合并计时器、重试退避和客户端 presence 租约不承担扫描任务。

投影器按单会话顺序消费事件，纯同步监听回调只入队，不等待网络，不能阻塞或抛错干扰 DSH。只为需要的 live 会话保留投影状态，闲置状态可回收；重新活跃时按事件触发单会话重建。

### 6.3 断线、重载和游标缺口

| 情况 | 恢复行为 |
| --- | --- |
| Connector 与 Server 断开 | 不推进提交游标；按顺序重试尚未确认批次 |
| Connector 与插件断开 | 重新发现、鉴权和订阅；从已确认位置恢复，并重新核对可见清单 |
| 插件重载或 DSH 重启 | 旧 stream 失效；以原生持久化和 live 状态建立恢复基线 |
| 新建/归档发生在离线期间 | 重连时比较完整可见清单；新增补导入，已导入但不再可见的撤销 |
| 原生 seq 不连续、投影状态已回收 | 停止该会话增量，按需读取该会话完整快照后继续 |
| 缓冲达到上限或订阅太慢 | 标记需要重建基线并关闭该流，不能静默丢数据后宣称同步完成 |
| 读取失败或超时 | 保留尚未确认状态并报告错误；不能提交伪造空历史或空清单 |

有完整投影状态时按 seq 读取缺失事件；没有状态时，只有原始 seq 不足以恢复未完成的工具/流片段，必须读取该会话快照。恢复是故障/连接事件触发，不恢复固定的周期扫描。

## 7. 可靠交付：取消 scanner 的前置条件

目前“写入 WebSocket 成功”或“进入后台队列”不表示已写入数据库。事件同步必须使用可等待提交结果的交付路径。

### 7.1 两段确认

1. 插件向 Connector 发送标准化、有序的批次，包含 `streamId / batchSeq / projectionVersion`，必要时包含各会话 `throughSeq`。
2. Connector 的该 Runtime 使用单一有序消费队列。现有 BridgeClient 的并行通知 task 不能直接承担这个顺序契约。
3. Connector 走同步 ingest 提交并检查所有拒绝结果；不能把新的事件流丢进当前失败即丢弃的普通 flush 队列。
4. Server 完成持久化后返回确认。Connector 才保存 checkpoint，再向插件确认此批次。
5. 超时、部分失败或确认丢失时重试同一批次；投影操作按 stable ID、revision 和批次标识幂等。

### 7.2 Server 需要的最小通用扩展

- 在现有 Connector ingress 路径增加事件同步的代次/批次确认能力；DSH 相关的原生过滤条件不进入 Server。
- 按认证 Connector 与 Runtime instance 分配同步 `generation`；旧连接的迟到批次不能覆盖新连接的基线，也不能在归档撤销后重新创建会话。
- 增加一份小型同步状态记录，保存 generation、已提交批次/投影版本。它不是新的原始事件内容库。
- 本期事件批次内的数据库变更与 checkpoint 在同一事务中确认；收到拒绝不返回成功 ack。已有其他 Runtime 的 ingress 行为保持兼容。
- 大快照继续分页、限制帧大小。完整替换必须等同一快照所有片段到齐再提交；如跨 HTTP 批次暂存，按 snapshotId 隔离并清理未完成暂存，不能逐页执行 `complete=true`。
- 撤销、基线提交与后续增量共享同一代次和顺序屏障；需要与现有 Timeline 写缓冲互斥并清缓存，避免延迟写把删除项恢复。
- 投影撤销完成后通过现有 dashboard/session 推送渠道通知客户端移除记录、退出已打开的失效会话；需要时补小范围 Web 缓存处理，不做页面重设计。

现有同步 ingest 的 HTTP 返回和拒绝检测可以复用；代次隔离、事务确认以及撤销操作是新增能力，不能描述成现在已经具备。

## 8. 协议与 Connector 接入

以下方法名为本方案拟新增的规范名，批准实施时连同 schema、fixtures 和跨语言测试一起提交：

| 层 | 扩展 | 用途 |
| --- | --- | --- |
| DSH bridge handshake | `syncMode: events`、事件协议版本、projectionVersion | 新 Connector 识别推送能力，旧客户端不订阅 |
| DSH bridge request | `runtime.sync.subscribe` | 首次订阅/恢复，返回 stream 标识 |
| DSH bridge notification | `runtime.sync.batch` | 基线、增量和生命周期操作的统一有序批次 |
| DSH bridge request | `runtime.sync.ack`、`runtime.sync.unsubscribe` | 确认持久化、释放订阅 |
| 通用同步 operation | 会话 meta/state、Timeline snapshot/upsert/remove、会话 projection.remove、可见清单 begin/complete | 全部为标准平台语义，不传原始 DSH 事件 |
| RuntimeProtocol | 显式 `polling / events` 同步模式、事件同步生命周期和交付确认 | 按 Runtime 决定是否参与周期扫描 |
| Connector → Server | generation 开启及带批次上下文的确认提交 | 可靠交付、旧流隔离与幂等撤销 |

协议原则：

- 不把 DSH 分支写死在 `RuntimeSyncRunner`；由 Runtime 声明同步模式，默认为 polling。
- 事件能力就绪后 DSH 退出周期扫描，首次基线由订阅流程拥有，避免两套初始化同时写库。
- Python 只校验并转发约定操作；不接触 `origin`、`turn/start`、内部 notice 分类等规则。
- schema 扩展在 `contracts/dsh-bridge/1.0/` 与平台协议目录维护。新增可协商能力使用 1.x 小版本，不能静默修改旧方法语义；不兼容字段若出现则升级 major。
- 旧 Connector 连新插件仍可读过滤后的快照；新 Connector 连旧插件保留旧 polling 模式并报告版本限制，不能宣称已经满足过滤/推送验收。
- 普通发现探针只 initialize/ping，不自动订阅、建立业务基线或触发清理。
- 某 Runtime 的事件基线正式提交后，Server 对这个 Runtime 启用代次校验，同时拒绝旧版本未携带同步上下文的写入；否则旧 scanner 仍可能把刚清除的数据写回来。其他 Runtime 和尚未启用事件模式的实例不受影响；回退旧同步模式必须是显式操作。

## 9. 拟调整的代码结构

```text
dsh-bridge-next/src/
  client/runtime/selection.ts           # 官方 current 的轻量上报，无新增页面组件
  contracts/runtime-presence.ts         # 插件 client ↔ Host 专用状态契约
  host/dsh-runtime/
    index.ts                           # 装配官方服务及生命周期
    visibility.ts                      # 官方过滤条件、状态缓存和门禁
    presence.ts                        # current 上报、连接/租约生命周期
    observer.ts                        # 官方 session/domain/status 事件监听
    projection.ts                      # 可逐事件推进的统一投影器
    history.ts                         # 完整快照调用同一投影器，删除 notice 兜底
    sync.ts                            # 基线、缓冲、事件流、ACK、恢复
    router.ts                          # 过滤后的读取及订阅请求
    server.ts                          # 有序批次发送、限流、取消和连接释放

connector/connector/
  runtimes/dsh/runtime.py               # 薄转发，订阅/恢复/确认
  runtimes/dsh/bridge/{client,models}.py # 有序消息入口与标准数据校验
  runtime_protocol/{protocol,host,instance_binding}.py
                                       # 通用同步模式与生命周期/确认入口
  server/runtime_sync.py               # 周期 runner 跳过 events 模式
  server/event_sync.py                  # 通用有序交付与重试（新模块）
  server/{client,ingest,sync_state}.py   # 生命周期、确认路径及 checkpoint

server/agent_server/
  api/connector_ingress.py              # 事件同步代次/批次的入口契约
  services/connector_notifications.py   # 原有 handler 的可复用部分
  services/runtime_sync.py              # 事务确认与投影撤销编排（新模块）
  services/repository_ports.py          # 最小仓储接口扩展
  infra/db/                            # checkpoint、快照提交与投影撤销实现

contracts/{dsh-bridge,protocol}/         # 对应 schema、fixtures 和协议说明
```

文件按责任拆分，不要求每个概念都建独立目录。若已有模块能承载同一责任就复用；不扩展到其他 Runtime 的原生实现。精确数据库方法按当前仓储实现增加，不能绕过仓储直接拼散落 SQL。

## 10. 实施顺序

| 阶段 | 实施内容 | 完成标准 |
| --- | --- | --- |
| A：冻结契约 | 固定过滤真值表、current 聚合、丢弃/保留事件、ACK/代次与投影撤销语义 | TS/Python/Server 对同一 fixtures 达成一致 |
| B：统一过滤 | visibility + presence；历史投影去掉内部 notice；所有读取入口加门禁 | 基线只输出合规会话和 Timeline |
| C：可靠交付 | 通用同步模式、Server 确认/撤销、checkpoint、Connector 有序重试 | 可证明 ACK 对应提交，旧流无法恢复已撤销数据 |
| D：接入实时事件 | 原生监听、增量投影、先订阅后基线、流式合并与按需恢复 | DSH 原生操作能及时更新 AA |
| E：切换与清理 | DSH 退出 scanner；新完整基线撤销旧过滤会话、替换旧 notice | 原生与平台数据按规则对齐，DB 无过滤副本 |
| F：项目与文本 | 官方项目列表/事件、稳定归属、纯文本创建/续聊、发送去重 | 能从平台发文本，DSH 与平台同步显示回复 |
| G：联调验收 | 真实官方服务组合、两个进程协议、Server 数据库与客户端更新 | 下表全部通过，提交仅含任务文件 |

开发过程中每个重要节点保留 Git 提交，保持当前分支与其他人的文件。正常本地服务不自动启动或重启；headless 测试使用临时目录、临时端口和独立数据库。需要用户实机验收时给出明确步骤。

## 11. 验收清单

### 会话过滤和迁移

- 真值表覆盖：普通、归档、子代理、普通 fork、空/非空、当前/非当前；当前状态不能让归档和子代理穿透。
- 标题为空但有 turn 的会话保留；有标题/命令但没有 turn 的会话仍按空会话处理。
- 单客户端精确复现当前空会话例外；多个客户端按约定聚合；关闭/断线/旧 revision 不留下永久空会话。
- 没打开 Modal、未登录插件、无 AA Desktop 或有 AA Desktop，runtime 规则相同；headless 不依赖客户端服务。
- 对过滤 ID 的列表、详情、旧游标及事件订阅均不返回业务内容；归档发生在分页中途也生效。
- 本机 14 条诊断样本在当前选择不变时只导入 6 条；既有 8 条多余投影按范围清理。
- 全量清单失败/截断不会清空已有会话；旧 generation 的迟到 upsert 不能恢复已撤销记录。

### Timeline

- 截图中的 policy、inbox、系统/技能注入、title 请求、设置命令流水均不出现在传输或数据库 Timeline 中。
- 用户/assistant、reasoning、tool、授权历史、轮次与压缩仍正确；工具错误不被 notice 过滤吞掉。
- 历史折叠与同一事件流逐步折叠的最终结果相同，包括稳定 ID、顺序、内容哈希和中断后删除草稿。
- 投影版本迁移清掉旧 notice，之后不会被旧基线、旧客户端或延迟队列写回。

### 首次同步、实时与补偿

- 基线读取同时插入新消息/创建会话/改名/归档，最终无漏项、重复或状态回退。
- running 会话首次可读，后续文字与工具实时到达，无需等 turn 结束或 scanner。
- 恢复/fork 的 seed 历史正确，不能只靠新事件导致继承消息缺失。
- Server 离线、插件断线、Connector 重启、确认丢失、请求重复/乱序、部分拒绝、缓冲溢出均能恢复。
- Server 提交前杀进程不推进 checkpoint；提交后确认前杀进程可幂等重传；新 generation 排斥旧请求。
- 大历史跨页不重复、不缺页；不完整快照不会覆盖完整历史；新事件不会被较旧快照回滚。
- 正常空闲超过两个旧扫描周期，不调用 DSH `listSessions/readSession`；其他 Runtime 保持原同步行为。
- 本地健康链路的创建/归档/改名目标为 1 秒内反映到客户端；这是验收目标，不是跨网络时延保证。

## 12. 官方依据与当前代码指针

- 官方侧栏：`deepseek-harness/packages/client/ui-workspace/src/client/tree.ts`，`sessionVisible()`、`deriveGroups()`、`deriveFlat()`。
- 官方空会话语义：`packages/host/apiproxy/src/api-proxy.ts`，`sessionBlank()` 与 `sessionListMetadata`。
- 官方客户端选择：`packages/client/runtime/src/client/sessions/service.ts`，`sessions.list.current`。
- 官方事件：[`docs/subsystems/session.md`](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/session.md)。`session/event` 为提交后的只读观察；恢复和 fork seed 不重发全部历史。
- 官方归档：[`docs/subsystems/workspace.md`](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/workspace.md)；`packages/storage/storage-domain/src/events.ts` 的 `domain/changed`；官方 Host 由它发出归档集合变更。
- 目标安装 SDK：`node_modules/@deepseek-ai/dsh-session`、`dsh-session-query` 的版本与导出类型，以实际安装版为执行边界，不能把官方 master 的新 API 直接用于 rc.1。
- 现有实现说明：[RUNTIME_READS.md](./RUNTIME_READS.md)。它描述当前代码；本文件描述确认后要实施的变更。

## 13. 已确认的产品语义

1. 官方“当前空会话”例外按本方案保留，并通过客户端 current 上报；多客户端采用可见集合并集。若只想同步开始过对话的会话，需要明确改成不保留此例外，不能称为逐项一致。
2. “过滤会话不留数据库”按本方案包含撤销此前导入的 AA 同步副本，以及后续归档后的投影撤销；保留 DSH 原始内容。仅隐藏 AA 页面不足以满足本次要求。

用户已确认以上语义，按 A–G 顺序完成实现和验证。

## 14. 本轮补充：项目、稳定身份及纯文本发送

### 项目

- 首次通过官方 `workspaceRegistry.list()` 获取 `id/title/path/sessionIds`。以原生 workspace ID 加 Runtime 命名空间确定项目身份，名称改变不创建新项目。
- 官方 `sessionIds` 已按原生头部的规范化 cwd 校验；与当前有效会话集合取交集后上报。空项目也可同步，无归属会话保留为未分组。
- 监听 workspace 的 `domain/changed`，同步新增、标题、移除、顺序及会话归属。移除工作区只撤销注册关系，不删除该目录或仍可见的会话。
- 项目使用标准协议传输，Connector 不解释 DSH 工作区记录；前端使用明确的原生项目关联，兼容其他 Runtime 现有 cwd 分组。

### 快照与稳定 ID

- 完整历史校准使用 `timeline.sync complete=true` 的语义：同一数据库事务替换该会话 Timeline，完全相同的快照不重复写入。分页失败不能提交完整替换。
- 会话 ID 基于稳定命名空间和原生 session ID；用户消息基于原生 message ID 与原生块序号；助手正文/思考基于原生 turn/step 起始 seq 与块序号；工具调用与结果共用 call ID。
- 历史与实时共用投影器，过滤内部事件不重编号。文本变化更新内容哈希与版本，不改变 item ID。
- DSH `assistant/chunk` 在运行中逐片段发布。建议约 50ms 合并为一批标准 Timeline 更新，结束立即提交；实际时延包含网络和前端渲染。

### 纯文本发送

- 平台发送通过 RuntimeProtocol 和 DSH bridge 到插件，插件调用目标安装版官方 Agent API；不在 Python 重实现 DSH agent 业务。
- 支持有效已有会话的接管/恢复后续聊，以及在选定本地目录创建会话后发送首条文本；沿用官方 preset、权限和运行环境。
- 请求携带稳定客户端请求 ID；重试检查原生用户消息标识，不能重复发起同一条消息。成功表示官方会话接受输入，回复通过同一事件同步链路送回。
- 运行状态、错误、终止和原生授权等待要诚实上报；不自动批准工具操作，不绕过原生审批。
- 不支持的附件请求明确拒绝，不静默丢弃；能力声明禁用附件。
- 验收覆盖：已有/冷会话续聊、新建、重复请求、并发输入、运行中生成、断线重连和历史/实时 ID 一致性；使用临时官方组合及模拟模型，避免触发用户真实 Agent 的工具执行。
