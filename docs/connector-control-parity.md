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
