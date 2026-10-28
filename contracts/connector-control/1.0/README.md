# Connector Control 1.0

## 通道选择与安全回退

基础连接同时声明 `X-AA-Control-Transport: meshcall/1.0` 和
`X-AA-Control-Fallback: websocket/1.0` 时，支持 Mesh 优先及一次 WebSocket 回退。
新标记表示两条入口共享普通8/关键2执行器、基础连接生命周期及64 MiB控制帧预算。
未声明新标记的连接固定使用原 WebSocket 业务入口，即使已经发布 Mesh route。
presence 新增可选 `controlFallbackCapable: true`，缺省为 false，不新增 Redis key。

每次请求固定 connectionId、controlCallId 和绝对 deadline。没有匹配 route 时不等待
注册；仅在 Mesh 明确未分发时允许回退一次，提交后的超时或结果未知均不重放。
两条通道仍校验基础连接身份及认证时的凭据版本。WS 请求新增可选 metadata，使用
`aa-control-call-id`、`aa-connection-id` 关联日志；错误增加可选 details，不改变领域参数。
`workspace.refresh` 仍为预留方法，不提供 WS 回退。

Server 到 Connector 的请求/响应控制面使用六个领域 MeshCall 服务：
RuntimeControl、Sessions、Workspaces、Files、Shell 和 Terminals。
服务定义以同目录 `service.json` 为准，固定前缀为 `aa.remote.v1`。

服务注册名由 Connector ID、基础连接 ID 和 Mesh link ID 派生。Bootstrap 复用
设备认证，借助旧控制连接上的 `connector.mesh.connection` 随机令牌确认连接归属，
签发 900 秒的代理授权；实际接收 Mesh WebSocket 的 Server 为本机 Router 签发
只允许注册该 link 服务的 token。Bootstrap、基础 WebSocket、Mesh WebSocket 和
业务 API 可以位于不同实例，无需负载均衡粘性会话。凭据吊销、基础连接替换或过期
会关闭 Mesh WebSocket。`Connection.ping` 为内部探针，不计入 42 个业务方法。

Redis presence 租约继续表示基础连接的 owner。另一个 60 秒租约记录 Mesh link 的
Router 与 worker，每 20 秒续期；只有预期服务全部注册后才能发布。发布时原子校验
基础连接与 bootstrap 代次，清理和续期比较完整 link 身份。Router 相同时直接调用；
跨 Router 复用原 Redis 请求/响应中转到目标 worker，再调用 MeshCall，不再递归路由。
超过256 KiB的内部请求和响应在原 worker 频道上分片；接收端每次只拉取一片，
原业务信封完整重组后才提交。小消息经过原通道，不排在大帧后等待。
分片不使用 Redis 存储 key，不自动重传业务。订阅断线时丢弃部分帧并重新订阅，
已提交调用的结果保持未知，不重放变更。
无 Redis 的单进程模式使用同语义的本地记录。新增记录均为可重建的临时协调信息，
不保存业务操作结果，也不改变现有 Timeline、锁、终端或通知的 Redis 职责。

签发代次和发布水位合并在 `connector:mesh-state:{connectorId}:{connectionId}` Hash 中：
`issuedGeneration` 在签发时递增，`publishedGeneration` 仅在路由发布成功时推进。
签发 Lua 原子分配代次、保存 grant 并设置到期时间；发布 Lua 原子检查连接、两个
水位与路由所有权。Hash 使用 900 秒保护期，成功签发或发布只能延长、不缩短已有
保护期；路由删除或续租不清理或续期该状态。状态缺失/损坏时发布失败，旧授权不能
在较新路由消失后倒退占位；已签发更新授权但尚未发布时，较早授权仍可按原规则发布。
本修订不兼容旧格式 Server 混跑，不双写旧 `mesh-generation` / `mesh-published` key；
切换时先退出旧格式 Server，统一运行新构建，旧 key 自然过期。Connector 接口不变。

本分支只替换内部传输：领域参数、业务处理器、对外客户端 API、通知、文件和 PTY
数据面保持现有语义；没有原生项目创建/同步、客户端界面或数据库 schema 变更。
42 个映射中，41 个在当前主线有业务处理器；`workspace.refresh` 是为原生项目同步
PR #413 保留的薄传输映射，处理器和调用入口由该 PR 提供。本契约不实现该业务。

Runtime 10、Sessions 13、Workspaces 1、Files 5、Shell 3、Terminals 10。
各服务复用现有应用分发器；并发上限和异常翻译位于传输适配器，业务校验仍由领域负责。
普通请求并发为 8；审批响应和通知读取保留独立的 2 个名额。
保持原有排队策略，不通过 SDK 的额外 inflight 上限提前拒绝请求。执行器和任务由
基础连接生命周期持有，Router 重连或授权更新不会重置额度。

能力标记按基础连接固定，Server 先升级、Connector 后升级。缺少或未知回退标记的
旧 Connector 固定使用原 WebSocket RPC。新 Connector 无 route 时立即使用 WS；
提交 Mesh 业务前显式连接 Router，连接预算为剩余期限的一半且最多1秒。
只有确定未分发的白名单原因允许一次 WS 回退；Redis 查询异常、参数/帧错误、
凭据失效、连接替换、业务拒绝及提交后的超时/响应丢失均不能触发回退。
两路使用同一个请求期限与关联 ID。调用方超时不取消已接纳工作；基础连接结束时取消该代次
排队与执行中的控制任务，保持旧 WebSocket 的取消边界。

新回退连接两种封装均按编码后64 MiB控制帧预算检查；旧连接下行预算为1 MiB，
超限在提交前返回资源限制错误。通知大小和附件、PTY 数据面不变。
owner 将同一次设备认证所用凭据的摘要仅保存在内存；后台缓存检查约每秒更新授权
快照，单次最多5秒。业务提交前与响应后都校验原连接，凭据撤销同时关闭基础连接。
发送锁内重新核对有效授权，等待锁不能继续沿用过期快照。ready 发布前即绑定授权
入口，首次快照未完成时等待检查。基础会话清理持有独立任务，停止/取消不跳过传输收尾。
执行器关闭后拒绝所有新任务，停止接纳状态独立于连接代次；候选链路固定签发前的
基础会话身份，Bootstrap 或服务启动完成时再次校验。停止基础连接会结束旧链路的
排空等待，但不会取消 SDK 的底层 stop；连接和 worker 释放后才记录链路关闭完成。
启动中的 SDK 任务同样由链路持有；注册失败或取消时，在释放 binding 前清理部分注册，
重复取消不能留下 Router 实例。授权缓存的容量淘汰独立于凭据失效，在途结果直到最后
一个等待方取走前仍受撤销检查保护。代理握手总预算10秒，收尾中的 Redis 路由删除、
Router 连接和客户端 socket 关闭各最多等待5秒，失败不会跳过其余资源清理。
Router 运行期故障时 `/health/ready` 保持 ready 并报告 `checks.mesh=error`，
`/api/v2/health/mesh` 仍返回503；Redis、路由订阅、Timeline 或授权订阅故障仍阻断就绪。

Server 通过 `python -m agent_server.main`
启动，由父进程维护共享 Router；直接使用 ASGI/uvicorn 时由应用生命周期维护每个
worker 的 Router，跨 Router 仍通过 Redis 协调。反向代理需支持
`/api/v2/connector/mesh` WebSocket，并将内部 `/connector/mesh/status` HTTP 请求正常
转发。Connector 通过该状态接口检测链路，不额外建立可能落到另一 Router 的自调用
WebSocket。Router、SDK 与代理使用 SDK 默认的 64 MiB 编码后帧限制；控制请求在 Redis
中转前检查同一预算。直接调用 uvicorn 时使用 `--ws-max-size 67108864`。超大附件仍使用数据面。
上行通知继续使用原通道。可靠原生创建及其回执协议由 PR #413 单独维护。

重新生成：`cd connector && uv run python tools/generate_remote_control.py`。
只读检查：`cd connector && uv run python tools/generate_remote_control.py --check`。

业务完成条件、迁移前后对照与直接探针见
[控制传输迁移说明](../../../docs/connector-control-transport.md)。
