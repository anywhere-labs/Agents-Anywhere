# Port Preview 1.0

在手机上打开电脑里 `127.0.0.1:<port>` 上跑着的网页。控制面在 AA Server，数据面是 frp（frps 在 Server 侧，frpc 由 Connector 管理）。设计见 `docs/v3/09-port-preview.md`（本地设计文档）。

- 源头：`server/agent_server/core/preview.py`；生成同 device-meshcall。
- Client API：`POST /api/v3/previews`（`CreatePreviewRequest`）、`GET /api/v3/previews`、`DELETE /api/v3/previews/{id}`、`POST /api/v3/previews/{id}/ticket`。
- 设备：`Link/attach` 事件 `port.listening` / `port.closed`；命令 `Commands/previewOpen` / `Commands/previewClose`（`contracts/device-meshcall/1.0`）。
- 预览地址 `https://<slug>.<预览域名>`，预览域名必须是**单独注册的域名**；没有配置预览域名时功能隐藏，不提供路径模式。
- 配置了预览域名的实例默认开启；加密模式下也默认开启，`PreviewView.plaintextNotice = true`，客户端提示预览流量不加密（`AGENT_SERVER_E2EE_PREVIEW=deny` 可关闭）。
- 设备只转发 `127.0.0.1` / `::1` 上已确认的端口；单设备最多 8 个打开的预览；`link` 可见性必须有过期时间（最长 7 天）。
