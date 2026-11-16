# Device MeshCall 1.0

v3 中 Server 与 Connector 之间的契约，取代 v2 的 `/api/v2/connector/ws` 与 `/connector/ingest`。两端经 [MeshCall](https://github.com/t4wefan/meshcall)（`meshcall/1`）通信，不再有自定义的帧协议。

- **拓扑**：MeshCall Router 是独立的 Go 进程，只经反向代理对设备开放 `wss://<server>/api/v3/device/mesh`。设备在 Router 上注册 targeted 服务 `aa.device.v1.*`，`instance_id = deviceId`；Server 的每个 worker 是 Router 上的客户端，直接调用任意设备。客户端不直连 Router，仍然使用 `/api/v2` 与 protocol 1.2。
- **握手（HTTP）**：
  1. `POST /api/v3/device/hello`，请求体为 `LinkHello`。返回 `LinkWelcome`，内容包括 `seqFloors`、`e2eeMode`、期望状态、待投递命令和 `mesh` 凭据。这个 token 只能注册本设备的 `instanceId`；签发新 token 时会吊销上一个，半死的旧连接因此立即被踢掉。
  2. 设备注册服务后调用 `POST /api/v3/device/ready`（`LinkReady`）。Server 随即打开 `Link/attach` 和 `Link/outbox` 两条流。
- **在线**：以 Server 持有的 `Link/attach` 流为准。设备每 20 秒在流上发一次心跳，租约 60 秒，每次连接带一个 `connectionId` 代次；调用时放在 metadata `aa-connection-id` 里。流结束即离线：读请求返回 200 和 `deviceOffline`，命令返回 409 `connector_offline`。
- **源头**：`server/agent_server/core/device_meshcall.py`。生成命令：`cd server && .venv/bin/python -m scripts.export_v3_contracts`（加 `--check` 只检查）。生成三类产物：
  - `schemas/*.schema.json`：各个 payload 的 JSON Schema。
  - `device.meshcall.json`：MeshCall 可移植契约，可交给 `meshcall generate` 生成 Python 或 TS 客户端。
  - `mesh-errors.json`：错误映射表。

## 服务

| 服务 | 方法 | 形状 | 作用 |
| --- | --- | --- | --- |
| `aa.device.v1.Link` | `attach` | server_stream | 心跳与可丢事件（`runtime.status`、`runtime.notice.updated`、`runtime.queue.updated`、`port.listening`、`port.closed`） |
| | `outbox` | server_stream | 出站箱（`OutboxItem`）：每次打开都从最小的未确认 `oid` 开始按顺序重发 |
| | `ackOutbox` | unary | 累计确认（`OutboxAck`） |
| `aa.device.v1.Sessions` | `snapshot` | server_stream | 客户端快照，按字节预算分块（`StreamChunk`） |
| | `watch` | server_stream | 打开流即订阅，取消即退订；流项为 `ChangesEvent` |
| | `notices` / `state` / `capabilities` / `queue` | unary | 读 |
| `aa.device.v1.Store` | `read` / `changesSince` / `planDocument` | unary | 读 |
| | `readBlob` / `exportShare` | server_stream | 大块读 |
| `aa.device.v1.Runtime` | `catalogs` | unary | 读 |
| `aa.device.v1.Commands` | `<命令>`（`COMMAND_METHODS` 转成驼峰，如 `sessionQueueSendNow`） | unary | 改变状态的命令：请求为 `CommandCall`，响应为 `CommandAck`，`idempotency_key = commandId` |
| | `status` | unary | 查询命令回执（`command.status`） |
| `aa.device.v1.Secure` | `channel` | duplex | 仅加密模式使用：每个客户端通道一条调用，流项为 `SecureChannelItem {n, ct}`，Server 原样转发 |

业务方法到路由的映射见源文件的 `REQUEST_METHODS`、`command_route()`、`LINK_ROUTES`；事件与出站箱的方法名见 `EVENT_METHODS`、`OUTBOX_METHODS`。

## 加密模式（`e2eeMode: "required"`）

`e2ee-registration.json` 列出每种模式下设备注册的服务与方法，来源是 `registered_services()`：

- `required` 时只注册：
  - `Link/*`；
  - `Secure/channel`；
  - Server 自己发起、不含会话内容的方法：`Commands/status`、`runtimeApply`、`deviceSettingsApply`、`channelSwitch`、`previewOpen`、`previewClose`。
- 用户发起的读、订阅、其他命令（包括 `sessionSync`）以及 `Runtime/catalogs` 不注册，一律走 `Secure/channel`。Server 就算想发明文请求，也没有目标。
- Server 签发的 Mesh token 的 scopes 也按同一张表收窄。
- `Link/attach` 上只发 `runtime.status`、`port.listening`、`port.closed`。`runtime.notice.updated`、`runtime.queue.updated` 带有审批和排队消息的正文，只推给订阅了该会话的加密通道；列表需要的「待审批」状态由 `SessionSummary.status` 提供。
- 出站箱与命令回执不带正文：`r` 为 null，`e` 只带 `code`；展示信封必须是 `sealed`；`attachment.consumed.sha256` 用密文的摘要。Server 在存储和写日志之前，还会用 `scrub_for_e2ee()` 再清理一遍（纵深防御）。

## 持有者更换

持有 `Link/attach` 的 worker 死掉时，设备只需重新调用 `ready`，不需要重新 hello：

1. worker 的 Mesh 连接一断，Router 就向设备发送 `call.cancel`（`reason: client_disconnected`），`attach` 和 `outbox` 的 handler 随之结束。
2. 设备的 Router 连接还在时，就带同一个 `connectionId` 重调 `POST /api/v3/device/ready`，退避从 0–1 秒随机开始，上限 `READY_RETRY_MAX_SECONDS`（30 秒）。返回 401 或 409（代次过期）时才重新 hello。
3. 接到 `ready` 的 worker 成为新的持有者。在线租约 `connector:presence:{deviceId}` 记录 `connectionId` 和 `holderId`（worker id 加 attach 调用 id）。持有者清理时**按 `holderId` 比较后删除**：同一个 `connectionId` 会先后被两个 worker 持有，只按代次删除会把新的租约一起删掉。
4. 每个 `connectionId` 下，设备最多保留一条 `attach` 和一条 `outbox`。新的一条打开时，设备结束旧的那条。
5. 持有者卡住但连接没断时，设备的心跳会因为没有 credit 而写不出去。超过 `ATTACH_STALL_SECONDS`（40 秒）就结束这两条流，然后重调 `ready`。
6. 旧持有者打开的 `Sessions/watch` 随之失效，新持有者按 `session-subs` 重新打开；客户端按自己的游标补齐（`session.catchup_required`）。加密通道跟着客户端隧道 WS 走：worker 死了 WS 也会断，客户端用新的 `ch` 重新握手。

## 错误

`classify_mesh_error()` 和 `mesh-errors.json` 把 MeshCall 的错误分成三类：

- **未投递**：`call.open` 之前就失败（连不上 Router、`no_instances`、`instance_unknown`、`instance_draining`），按离线处理。
- **结果未知**：调用已经打开之后出现 `instance_lost`、`deadline_exceeded`、`cancelled`。读请求报 `device_read_timeout`，命令报 `command_outcome_unknown`。这一类**不报成离线，也不自动重发**。
- **应用错误**：设备返回的 AA 错误码。

## 会话时钟与地板值

- 每个会话有一个时钟 `headSeq`，由设备分配。完整替换、历史改写或库重建时推进 `resetSeq`。
- Server 转发 `Sessions/watch` 的流项之前，如果 `toSeq > seq_ceiling`，先把 `seq_ceiling` 持久化为 `toSeq + 1024`（`next_seq_ceiling`）。
- `seqFloor = max(head_seq, seq_ceiling)`。如果设备本地的 `headSeq` 不大于地板值（库被删、重装、从备份恢复），时钟拨到 `seqFloor + 1`，并设置 `resetSeq`。

## 不变量

- Server 不存会话正文，也不缓冲事件。`ChangesEvent.events` 已经是客户端形状（`ProtocolEventEnvelope`），Server 只包一层转发。
- 展示内容（标题、最近一条摘要、工作目录）只放在 `DisplayEnvelope` 里，Server 只存不读。
- 设备只在命令**落盘后**回 `accepted`。MeshCall 的幂等去重只在内存里、只保留 60 秒，不能代替 Server 的 `device_commands` 和设备上的持久回执。
- `unknown` 不是终态：设备经出站箱的 `command.result` 补报，Server 也可以用 `Commands/status` 查询。任何一方都不自动重新执行命令。
- 大块数据（附件、导出）仍然走 HTTP 中继，不用 MeshCall 的流。Router 的 `--max-frame-size` 与客户端统一设为 4 MiB；业务上的 `byteBudget` 默认 1 MiB。
