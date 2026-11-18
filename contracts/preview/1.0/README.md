# Port Preview 1.0

在手机上打开电脑里 `127.0.0.1:<port>` 上跑着的网页。控制面在 AA Server，数据面是 frp（frps 在 Server 侧，frpc 由 Connector 管理）。设计见 `docs/v3/09-port-preview.md`（本地设计文档）。

- 源头：`server/agent_server/core/preview.py`；生成同 device-meshcall。
- Client API：`POST /api/v3/previews`（`CreatePreviewRequest`）、`GET /api/v3/previews`、`DELETE /api/v3/previews/{id}`、`POST /api/v3/previews/{id}/ticket`。
- 设备：`Link/attach` 事件 `port.listening` / `port.closed`；命令 `Commands/previewOpen` / `Commands/previewClose`（`contracts/device-meshcall/1.0`）。
- 预览地址 `https://<slug>.<预览域名>`，预览域名必须是**单独注册的域名**；没有配置预览域名时功能隐藏，不提供路径模式。
- 配置了预览域名的实例默认开启；加密模式下也默认开启，`PreviewView.plaintextNotice = true`，客户端提示预览流量不加密（`AGENT_SERVER_E2EE_PREVIEW=deny` 可关闭）。
- 设备只转发 `127.0.0.1` / `::1` 上已确认的端口；单设备最多 8 个打开的预览；`link` 可见性必须有过期时间（最长 7 天）。
- 端口属于会话：监听进程是该会话 Agent 进程或 AA 终端的后代（启动它的 shell 退出后，同一进程仍算），或会话的工具输出、终端输出打印过它的本地地址。其他端口一律拒绝（`preview_port_not_allowed`，`details.reason = not_session`）。
- 能力：支持预览的设备在会话能力集里声明 `session.port_preview`（`supported = true`）；没有 frp 客户端时 `available = false`、`unavailableReason = preview_unavailable`。客户端只在 `supported && available` 时显示预览入口，不要求接管会话；没有声明（如 DSH 插件）时隐藏。

## Server 行为

- 没有配置预览域名或内部令牌时，创建返回 404 `preview_domain_not_configured`；加密模式且 `AGENT_SERVER_E2EE_PREVIEW=deny` 时返回 404 `preview_disabled`；v2 Connector 返回 409 `device_upgrade_required`。客户端遇到 404 隐藏入口。
- 同一设备的同一端口沿用同一个 `previewId` 和 `slug`；再次创建即重新打开。单设备超过上限返回 409 `preview_limit_reached`；设备拒绝时返回设备的错误码（如 `preview_port_not_allowed`、`preview_unavailable`），设备离线返回 409 `connector_offline`，结果不确定返回 504 `command_outcome_unknown`（`detail.previewId` 给出预览，frps 登记代理后自动变为 `open`）。
- `ticket` 只对 `opening` / `open` 且未过期的预览签发，否则 404。票据 60 秒、只能用一次。
- `port.listening` / `port.closed` 经会话 WebSocket 下发：标准事件信封，`sequence = 0`（不推进游标）。`port.listening` 的 `ports` 只含属于该会话的端口，是该会话当前的完整列表（空列表表示没有端口）；订阅会话时 Server 在 `session.subscribed` 之后补发一次当前列表；设备离线时下发空列表。
- 预览在用户停止、过期、端口关闭（`port.closed`）或设备离线超过 10 分钟时关闭。

