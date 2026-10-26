# Runtime Operations 1.0

首期操作为 `workspace.create`。用户端继续使用 `/api/v2/projects` 和
`/projects/operations/{id}`；Server 持久接收后立即返回 pending，不等待原生调用。

## 身份与隔离

请求身份包含 operationId、type、server、userId、connectorId、runtimeId、runtime、
configRevision、name、path。operationId 在所有跳保持不变，传输重试携带由 operationId 和规范化参数派生的同一幂等键（避免 Router 缓存掩盖参数冲突）；
相同身份不同参数必须拒绝。userId 与目标从 Server 已授权的数据库记录生成，不信任客户端提供的路由。

Server 每次派发重新校验设备归属、授权、Runtime 配置代次。远程服务名由 Server
为 Connector 当前 WebSocket connectionId 派生，token 只可注册该服务并调用自身 ping（不开放业务读取或管理调用）；每次调用必须指定 instance。
响应按 operationId 和完整请求绑定校验，不接受其他设备或旧派发尝试覆盖结果。

## 操作服务

`ping()` 查询协议版本，不读取业务数据。
`submit(request)` 为变更：持久接收后返回 OperationRecord；执行由独立 worker 持有。
`get(operationId)` 为查询：返回本地回执，不存在返回 null。
`ackResult(operationId)` 为变更：仅确认上游已收到终态，不删除防重记录。
相同接口用于远程 Connector 服务及本机 `aa.dsh.v2.Operations`。

状态为 queued、accepted、running、reconciling、succeeded、failed、unknown。
accepted 必须落盘；running 在原生副作用前落盘。取消 RPC 不撤销已接收操作。
unknown 不代表失败，不能自动以新 ID 重做。原生成功与项目投影就绪分别表示。

## 跨网络入口

POST `/api/v2/connector/mesh/bootstrap`，Connector access token 鉴权，正文
`{connectionToken, protocolVersion:"1.0"}`；返回 protocolVersion、path、service、
instanceId、connectionId、token、expiresIn（900 秒）。提前 60 秒续期。
连接令牌用现有 `workspace.connection` RPC 与当前连接绑定。
WebSocket `/api/v2/connector/mesh` 只接受 bootstrap 签发的限时凭据，转发到回环 Router。
检查设备凭据指纹、连接租约和令牌期限；失效关闭并撤销 Router token。

## 升级与恢复

新创建只走 MeshCall，旧 project.create 返回升级错误，不回退。
旧 pending/unknown 记录迁为 reconciling，不自动执行；旧回执查询保留用于核对。
新记录在无接收证据时可重复提交同一 operationId；设备已接收却丢失回执时保持 unknown。
本机 JSON 回执禁止静默降级内存。队列每设备 256，最多并发 4 个 Runtime，同 Runtime 串行。
首期不删除防重记录。持久投递使用带期限的领取和 generation，迟到回包不能覆盖新尝试。
