# Connector Control 1.0

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

基础连接通过 `X-AA-Control-Transport: meshcall/1.0` 声明控制能力，该标记随原 Redis
presence 租约共享。未声明能力的旧 Connector 继续使用原 WebSocket RPC，保留升级
期间的调用能力；已声明的连接对映射内的方法不回退到旧 WebSocket RPC。Router 返回尚未分发的
`no_instances` 或明确未分发的旧路由时，在原期限内等待注册；结果不明的变更调用
不会自动重放。调用方超时不取消已接纳工作；基础 Connector 连接结束时取消该代次
排队与执行中的控制任务，保持旧 WebSocket 的取消边界。

启用远程 MeshCall 控制时请先更新 Server；旧 Connector 未声明 Mesh 能力时继续走原 RPC。
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
