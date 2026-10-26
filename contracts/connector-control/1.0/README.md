# Connector Control 1.0

Server 到 Connector 的请求/响应控制面使用六个领域 MeshCall 服务：
RuntimeControl、Sessions、Workspaces、Files、Shell 和 Terminals。
服务定义以同目录 `service.json` 为准，固定前缀为 `aa.remote.v1`。

服务注册名由 Connector ID 和当前连接 ID 派生，实例也绑定该连接。Bootstrap 复用
设备认证，借助旧控制连接上的 `connector.mesh.connection` 随机令牌确认连接归属，
仅授予本设备服务注册权限及调用自身 `Connection.ping` 的权限，用于探测 Router
重启和令牌失效。该内部心跳服务不计入 42 个业务方法。凭据吊销、连接替换或过期
会关闭 Mesh WebSocket。

本分支只替换内部传输：领域参数、业务处理器、对外客户端 API、通知、文件和 PTY
数据面保持现有语义；没有原生项目创建/同步、客户端界面或数据库 schema 变更。
42 个映射中，41 个在当前主线有业务处理器；`workspace.refresh` 是为原生项目同步
PR #413 保留的薄传输映射，处理器和调用入口由该 PR 提供。本契约不实现该业务。

Runtime 10、Sessions 13、Workspaces 1、Files 5、Shell 3、Terminals 10。
各服务复用现有应用分发器；并发上限和异常翻译位于传输适配器，业务校验仍由领域负责。
普通请求并发为 8；审批响应和通知读取保留独立的 2 个名额。

Server 对映射内的方法不回退到旧 WebSocket RPC。Router 返回尚未分发的
`no_instances` 时等待注册；结果不明的变更调用不会自动重放。调用方超时或断线后，
已接纳的 Connector 工作继续执行，以保持原控制面的取消边界。

Server 与 Connector 必须使用配套构建。Server 通过 `python -m agent_server.main`
启动，由父进程维护共享 Router；反向代理需支持 `/api/v2/connector/mesh` WebSocket。
上行通知继续使用原通道。可靠原生创建及其回执协议由 PR #413 单独维护。

重新生成：`cd connector && uv run python tools/generate_remote_control.py`。
