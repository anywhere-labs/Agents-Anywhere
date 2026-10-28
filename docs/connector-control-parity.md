# #441 迁移对照清单

迁移对照基线为 PR head `b3a28b6` 与主线 `b4210b5c`；本轮 Hash 收拢在已合入
主线 `4ccfe15e` 的同一 PR 工作区验证。旧、新传输最终调用同一 `RuntimeRpcHandler` / `LocalRpcHandler`；
下表用于检查业务参数、结果和收尾条件，不把 Mesh 注册成功视为业务验收。

流程、Redis 职责和运行方式见 [控制传输说明](connector-control-transport.md)。

## 共同规则

- `R` 表示原有 `runtime + runtimeId`；`S` 表示原有 `sessionId`，读取或续发时保留
  `externalSessionId`。表内是关键字段索引，完整解析规则仍由
  `connector/server/runtime_rpc_params.py` 和 `connector/local/` 持有。
- 所有输入字典原样送入 dispatcher；不把省略字段改成 `null`，不补模型、权限或 cwd。
  结果仍由原有 payload 转换器生成；保留 `ok:false`、`accepted:false`、`cancelled:false`。
- 普通请求共用 8 个额度；仅 `session.notices`、`interaction.respond` 共用 2 个关键
  额度；超过额度排队。Router 重注册不重置额度，SDK 不另设 inflight 拒绝阈值。
- 超时沿用每个业务调用点传入的期限，路由等待和 Redis 中转都消耗该期限。
  调用方超时不取消已接纳工作；基础 Connector 连接结束取消对应排队和执行任务。
  后台同步、上传、Shell task 和 relay 仍由原来的领域生命周期持有。
- 领域异常保留原 code/message，包括与 MeshCall 保留错误码同名的领域错误。
  常规文件/Shell 的原服务映射仍为离线 409、超时 504、上游错误 502；会话和终端
  继续走各自原有映射。新增内部 `deliveryState` 不改公开 API。
- 响应不是 Timeline 落库确认：最终事实分别由 Runtime、文件/PTY、Server 记录及
  Timeline revision 持有。旧连接的返回不能绑定新连接，结果未知不自动重放。

## 41 个业务方法

| 方法 | 原参数关键字段 | 原结果与完成条件 |
| --- | --- | --- |
| `runtime.discover` | 空字典 | `runtimeTypes`；发现查询完成 |
| `runtime.configSchema` | R | `configSchema`；provider schema |
| `runtime.config` | R | `running/config`；当前实例配置，未启动可为 null |
| `runtime.validateConfig` | R、name、config、configRevision | `valid`；配置校验，不启动实例 |
| `runtime.start` | R、name、config、configRevision | `status/error/phase`；原 supervisor 返回 |
| `runtime.stop` | R | `status:stopped`；原 supervisor 停止完成 |
| `runtime.capabilities` | R | `capabilitySet`；有效能力查询 |
| `runtime.commands` | R、limit | `commands`；实例级命令查询 |
| `runtime.modelCatalog` | R、query、limit | `catalog`；保留 revision 和 selectionId |
| `runtime.permissionCatalog` | R、query、limit | `catalog`；保留 revision 和 selectionId |
| `session.discover` | R、limit、cursor、force | 原发现列表与分页；原 host 通知照常发送 |
| `session.create` | R、S、content、title、cwd、selections、attachments、clientMessageId、runtimeOptions | 原 RuntimeOperationResult；成功需核对 native 绑定与首条消息，回合结束另看事件 |
| `session.sync` | R、S、limit | `accepted/background`；接纳同步任务，不代表历史已落库 |
| `session.state` | R、S | `state` 或 null；保留原 host 状态通知 |
| `session.capabilities` | R、S | `capabilitySet`；会话有效能力 |
| `session.notices` | R、S、limit | `notices`；关键额度，查询不解决审批 |
| `session.selections.update` | R、S、selections | 原 RuntimeOperationResult；不重写 Runtime 拒绝 |
| `session.commands` | R、S、query、limit | `commands`；会话命令查询 |
| `session.command.execute` | R、S、command、raw、args | 原 command result；保留领域接受/拒绝 |
| `interaction.respond` | R、S、noticeId、actionId、inputData | 原 RuntimeOperationResult；关键额度，后续运行状态另看通知 |
| `session.send_message` | R、S、content、cwd、selections、attachments、clientMessageId | 原 RuntimeOperationResult；接收与回合结束分开 |
| `session.steer` | R、S、content、attachments、clientMessageId | 原 RuntimeOperationResult；保留运行中 steer 的拒绝条件 |
| `session.interrupt` | R、S、reason | 原 RuntimeOperationResult；中断响应与最终 idle 分开 |
| `fs.prepareDownload` | root、path、sessionId | name/size/sha256/mediaType；读取元信息 |
| `fs.uploadPreparedDownload` | root、path、sessionId、transferId 及原上传授权字段 | `transferId/uploadStarted`；后台上传接纳，数据仍走 HTTP |
| `fs.writeFile` | root、path、content、encoding、ifMatch、sessionId | bytesWritten/sha256；实际文件写入或原异常 |
| `fs.readDir` | root、path、sessionId | entries/truncated/targetPath/targetType；原排序和最多 500 条 |
| `fs.readText` | root、path、maxBytes、sessionId | content/sha256/truncated/binary；默认 1 MiB，最多读取 4 MiB |
| `shell.exec` | root、cwd、command、timeoutMs、sessionId | exitCode/timedOut/stdout/stderr；原每流 64,000 字符截断 |
| `shell.task.start` | root、cwd、command、timeoutMs、taskId、sessionId | taskId/status；任务已启动，完成仍走原通知 |
| `shell.task.cancel` | taskId、sessionId | `cancelled`；不存在返回 false，不能改成传输异常 |
| `terminal.create` | root、cwd、terminalId、sessionId、shell、command、args、env、cols、rows、label、persistent、outputTransport | 原终端 view；PTY 创建，relay 连接另有接纳和等待 |
| `terminal.write` | terminalId、dataBase64 | bytesWritten；PTY 输入提交 |
| `terminal.resize` | terminalId、cols、rows | 尺寸或 closed；保留原边界夹取 |
| `terminal.close` | terminalId | closed；原终端回收 |
| `terminal.rename` | terminalId、label | 原终端 view；保留原不存在异常 |
| `terminal.setPersistent` | terminalId、persistent | 原终端 view；保留租约语义与不存在错误 |
| `terminal.list` | sessionId（可省略） | terminals；保留查询范围 |
| `terminal.release` | terminalId | released；释放输出接收者，不等于关闭 PTY |
| `terminal.snapshot` | terminalId、fromSeq | terminal/baseSeq/seq/dataBase64/增量；保留 512 KiB scrollback |
| `terminal.relay.connect` | terminalId、sessionId、token、mode 及原 relay 参数 | `connecting:true`；接纳连接任务，不代表已连通，原 broker 继续等待 |

`workspace.refresh` 单列为预留方法，不计入 41 个已实现业务。

## 拓扑与共享状态

| 检查项 | 保留/补齐的机制 |
| --- | --- |
| 单进程无 Redis | 内存 presence/临时授权/路由；本机 Router |
| 单 Server 多 worker | Redis presence，父进程 Router，任意 worker 可调用 |
| 多个独立 Server | 每个 Router 独立；Redis 中转到 Mesh link 所在 worker |
| 四个入口分散 | 基础 WS、bootstrap、Mesh WS、业务 API 可分别落在不同实例 |
| presence owner | 仍是基础 WS owner；Mesh route 不覆盖它 |
| link owner | connectorId/connectionId/linkId/routerId/workerId/generation；60 秒租约，20 秒续期 |
| 旧链路清理 | 按完整路由身份条件删除/续租；旧 generation 不覆盖新记录 |
| 代次共享状态 | `connector:mesh-state:{connectorId}:{connectionId}` Hash；签发/发布水位分别更新，共同保留 900 秒 |
| 授权 | 900 秒代理 grant 可在共享 Redis 验证；实际接收端签发本机 register-only token |
| Router/worker 崩溃 | Router 重启、Connector 重新认证注册；强制 worker 退出时旧路由最多等待租约失效；不重放变更 |
| Redis 故障 | 不切换到另一通道重新执行业务；恢复后沿用原连接与协调恢复 |
| Timeline/广播/锁 | 原实现和存储结构均保留；不新增操作数据库或全局落库屏障 |

## 已确认的原有问题

文件保存的 `ifMatch` 与磁盘 hash 不符时，Connector 原本抛 `code=stale`，但 Server
`services/workspace.request_connector` 将其转为 `ConnectorUpstreamError`，当前 API
返回 502。原模型注释写 412，与实现不符。新旧传输保留该错误与拒绝写入；此次不改
公开 HTTP 状态。后续修复应覆盖服务层错误分类、API 及各端冲突提示，独立于 #441。

真实会话在切换临时本机状态配置、Connector 重启和原生历史同步后出现重复用户条目。
将 Server 控制最后一跳切回原 WebSocket 后，同一流程也将两条用户消息同步成四条；
原生回复没有因此重新执行。仅普通同步以及一次未切换状态配置的重启没有复现。
这是已在旧传输复现的历史投影问题，尚未隔离状态配置与同步时机各自的影响；后续
应检查 Codex 实时/历史条目的身份及 clientMessageId 去重，不在 #441 改写 Timeline。

## 验证证据的层次

工具目录探针使用真实 Router/Redis/HTTP/WebSocket 和多 worker，认证、领域处理器
为受控实现；41 个方法逐个比较参数/结果、业务拒绝及异常 code，另检查 8+2 排队、
超时后继续执行、丢响应不重放、大帧、授权和连接替换。它不宣称覆盖每种 Runtime
的所有业务分支。现有领域自动化与真实 Codex/文件/PTY/Electron 检查分别记录，不能
把这三类证据互相替代。

### 上轮传输迁移本地检查（2026-10-27）

| 检查 | 结果 |
| --- | --- |
| Connector 现有完整测试 | 1278 通过；1 条已有 Pydantic 序列化 warning |
| Server 现有完整测试 | 976 通过、14 跳过；最终相关检查另有 24 通过 |
| DSH `yarn check` | 类型检查、构建与构建检查通过；222 个测试通过 |
| Web | 415 个测试、typecheck、protocol:check 通过 |
| Desktop | 148 个 main 测试、renderer:typecheck 通过 |
| 控制契约只读生成检查 | 41 个已实现方法、1 个预留方法一致 |
| 真实传输探针 | 跨实例 14 组、无 Redis 单进程 11 组通过；含 41 方法逐项成功/拒绝/错误对照 |
| 真实 Runtime | Mesh 下 Codex 创建、续发、审批执行、中断、idle 收尾及中断后续发通过；旧 WS 下另建 Codex 会话与续发通过 |
| 文件/Shell/PTY | 旧新最后一跳分别通过文件读写与独立磁盘 hash、Shell 输出、终端创建/重命名/持久化/resize、relay stream 和 snapshot |
| Electron 开发实例 | OAuth 登录、本机启停/重启、配置状态、运行日志显示、会话页面、文件保存/刷新及独立 UTF-8 磁盘 hash 通过 |

全量 Ruff 仍报 Server 420 条、Connector 114 条诊断；逐一对照本次修改文件与主线，
没有新增 Ruff 诊断，新增传输模块、生成器和探针的 Ruff 检查通过。没有为清理旧
lint 问题修改业务代码或测试。所有数据库检查均使用本轮专用 QA PostgreSQL，清表
测试只连接一次性测试库；故障注入使用独立 Redis namespace 和专用容器。

### 本轮 mesh-state 收拢检查（2026-10-27）

| 检查 | 结果 |
| --- | --- |
| 代次专项探针 | Redis 13 组、无 Redis 内存 10 组通过 |
| 原传输探针 | 跨实例 14 组、无 Redis 单进程 11 组通过 |
| Server 完整现有测试 | 976 通过、14 跳过 |
| DSH `yarn check` | 类型、构建及构建检查通过；222 个测试通过 |
| 只读契约检查 | 41 个业务实现、1 个预留映射一致 |
| Ruff 与差异 | 收拢涉及的源文件及新探针检查通过；Server 全量仍为 420 条基线诊断，本轮新增 0；`git diff --check` 通过 |

代次探针直接执行真实 Redis Lua，验证 64 次并发签发、水位推进、较新授权未发布时
旧授权仍可发布、路由删除/过期后旧授权迟到、同代次所有权、精确整数边界、损坏状态
和缺失 TTL、连接替换、Redis 错误及 Lua 提交后响应丢失。共同到期基准覆盖所有并发
签发的 grant；延长保护期不缩短已有期限，读取/路由续租/删除/失败发布不刷新状态。
短 TTL 只在探针内注入。旧格式计数器以冲突数值预置后，新状态仍独立分配，旧 key
保持原值；生产代码没有旧格式读写或过渡双写。原授权校验和 Connector 传输源码
相对本轮开始时保持不变。

### 生命周期与故障验收矩阵（2026-10-28）

每项同时核对正常路径、失败路径和恢复后的下一次请求。调用超时后结果未知时不
切换通道重放；基础连接结束时才取消已接纳业务。资源清理失败要可观察，不能以
清除本地引用或写出完成日志代替真实关闭。

| 阶段 | 必须保持的约束 | 检查入口 |
| --- | --- | --- |
| 基础连接与能力协商 | 旧版本固定 WS，新版本共享执行器后声明回退能力；身份按连接固定 | fallback 探针、现有 Connector/Server pytest |
| SDK 启动 | 注册前后取消、注册后错误、清理中重复取消均不留下 Router 实例、连接、binding 或 worker | control_edges 启动矩阵 |
| 本地 Router 启动 | 取消不会丢弃仍运行的启动线程；关闭等待启动结束，迟到的启动不能重新发布地址或留下进程环境 | control_edges 真实 Router 启动矩阵 |
| Bootstrap 与注册交错 | 基础会话关闭/替换后，迟到的 Bootstrap 或 SDK 注册不能归入新连接 | control_shutdown 探针 |
| 并发与排队 | 普通8、关键2，共享额度；轮换不重置额度，引导握手不占业务队列 | renewal 探针、现有 executor pytest |
| 选路与交付状态 | 明确未分发才允许单次 WS 回退，未知结果、领域错误和业务拒绝不重放 | mesh/fallback 探针、现有 transport pytest |
| 跨 worker/Server | 基础连接 owner 与 Mesh owner 可不同；定向执行不递归选路，旧连接响应不能绑定新连接 | Redis mesh/fallback 探针 |
| deadline | 同一预算覆盖查询、排队、连接、发送和等待；调用方结束等待不取消已接纳任务 | request_limits 探针、现有 deadline pytest |
| 正常轮换与授权过期 | 新链路发布后排空旧链路；持续 Bootstrap 失败时独立提前排空，旧调用完成，新请求回退 | renewal/expiry 探针 |
| Redis 状态机 | issued/published 独立单调，旧路由消失不会允许代次倒退，内存与 Lua 行为一致 | mesh_state 探针、现有 routes pytest |
| 授权缓存容量 | 4097个并发读取只加载4097次，已完成缓存最多4096条；容量淘汰不触发凭据重查循环 | control_edges 容量检查 |
| 撤销与结果消费 | SQL 完成后、等待方恢复前即使结果被淘汰，撤销仍有效；旧加载不能覆盖新凭据 | control_edges 撤销交错、mesh_auth 探针 |
| 授权依赖故障 | SQL 失败不视为授权成功；订阅关闭失败仍可重订阅，恢复前拒绝使用缓存 | control_edges、mesh_auth 探针 |
| 授权订阅启动 | 关闭与首次订阅共用生命周期锁，排队的启动在关闭后拒绝；清理中重复取消不能遗留监听任务 | control_edges 订阅启动矩阵 |
| 组合时序 | LRU、单设备/全局撤销、调用方取消组合运行，不返回已撤销结果，不遗留加载任务 | control_edges 的10组固定种子交错 |
| 大帧与订阅恢复 | 原64 MiB控制预算不撑断Redis32 MiB输出缓冲；分片丢失不执行业务，恢复不重放 | rpc_frames 探针、独立磁盘hash |
| 代理握手与关闭 | 共用握手期限；删除路由或关闭连接停滞不能阻止其他收尾步骤；重复取消不丢子任务 | control_edges 代理矩阵 |
| 连接释放 | 注销、心跳过期、旧连接替换和Server关闭均有释放期限；Redis异常仍关闭原socket | control_edges 释放矩阵 |
| 日志 | 不输出正文或凭据；慢sink不阻塞业务，清理失败不记录成功完成 | control_logs/request_limits/control_shutdown 探针 |
| 本机控制与多端契约 | 本机 Control/Logs、DSH交接继续可用；41个已实现方法和1个预留映射保持一致 | Desktop/DSH/Web现有检查、只读契约生成器 |

上述工具位于 `server/tools/probe_connector_*.py`，具体命令见
[控制传输说明](connector-control-transport.md#复核方式)。统一边界和关闭探针已纳入
CI；它们最终检查所有自有后台任务已回收，并检查真实 SDK worker 已退出。

### 本轮完整检查结果（2026-10-28）

集成主线 `af8cbcff` 后运行完整 Server 回归；其余检查与受影响的真实传输探针也已通过。

| 检查 | 结果 |
| --- | --- |
| Server 完整 pytest | 1118 通过、14 跳过，0 失败 |
| Connector 完整 pytest | 1295 通过；1 条已有 Pydantic warning |
| DSH `yarn check` | 类型、构建及构建检查通过；222 测试通过 |
| Desktop | 157 个 main 测试、renderer typecheck 通过 |
| Web | 415 个测试、typecheck、protocol check 通过 |
| 单进程、分布式和故障探针 | 177 个场景通过，含 28 个启动、授权与收尾边界场景 |
| 真实 PostgreSQL 授权查询 | 同一缓存周期 100 次读取产生 1 次指纹 SELECT |
| 只读控制契约 | 41 个实现、1 个预留映射一致 |
| 修改文件 Ruff | 53 个 Python 文件对照主线，23 条已有诊断，新增 0 |
| 工作流与差异 | actionlint、`git diff --check` 通过 |

DSH 检查中复现了 fixture 删除日志目录早于停止 Connector 导致的 `ENOTEMPTY`。
获得用户单文件例外授权后，仅调整 `local-ownership.test.ts` 清理顺序，等待所有
Connector 子进程关闭后再删除目录；原断言保持一致，完整检查重新通过。
