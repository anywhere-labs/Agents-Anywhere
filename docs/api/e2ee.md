# 端到端加密模式（Server 侧）

部署配置 `AGENT_SERVER_E2EE=required` 打开可选的端到端加密模式。客户端与设备之间的 Noise 通道、配对、字节格式见 [`contracts/e2ee/1.0`](../../contracts/e2ee/1.0/README.md)；设备在该模式下注册哪些方法见 [`contracts/device-meshcall/1.0`](../../contracts/device-meshcall/1.0/README.md) 的「加密模式」。本页只说明 Server 对外的行为。

## 配置

| 变量 | 取值 | 说明 |
| --- | --- | --- |
| `AGENT_SERVER_E2EE` | `off`（默认）/ `required` | 部署声明。设备和客户端各自保存本机策略，Server 之后改回 `off` 也不会让它们接受明文 |
| `AGENT_SERVER_E2EE_WEB` | `allow`（默认）/ `deny` | 加密模式下是否允许使用 Web 客户端（Web 只能防被动泄露） |
| `AGENT_SERVER_E2EE_PREVIEW` | `allow`（默认）/ `deny` | 加密模式下是否保留端口预览（预览流量不在端到端加密范围内） |

取值不合法时 Server 拒绝启动。

`GET /api/v2/auth/config`（公开，登录前可读）多一个字段：

```json
{"e2ee": {"mode": "required", "web": "allow", "preview": "allow"}}
```

旧版 Server 没有这个字段，客户端按 `off` 处理；但已对某台设备开启加密的客户端，不会因为这里是 `off` 而放松。

## 拒绝明文内容路由

加密模式下，下列路由（HTTP 与 WebSocket）一律拒绝，内容改走安全通道（`WS /api/v3/tunnel`）：

- `POST /api/v2/sessions`、`POST /api/v2/sessions/create-and-start`（携带首条消息）；
- `/api/v2/sessions/{id}/` 下除 `meta`、`runtime/state`、`runtime/capabilities` 以外的全部路由：时间线、快照、事件、会话 WebSocket、命令、审批、计划、目标、Server 排队、附件、终端、文件、服务端分享快照；
- `/api/v2/connectors/{id}/fs|shell|terminals|terminals-v2/…` 与 `/api/v2/connectors/fs/…`；
- `/api/v2/runtime-workflows/…` 全部路由（准备工作区、新建向导及其答复、会话树、Agent 操作会带首条消息、答复、路径和消息树）。在它们改走通道之前，客户端在加密设备上直接提示暂不支持。

HTTP 返回 `409`：

```json
{"detail": {"code": "e2ee_required", "message": "This server requires end-to-end encryption; use the secure channel (/api/v3/tunnel)."}}
```

WebSocket 在握手完成前以 `1008`（`e2ee_required`）关闭。拒绝发生在路由之前，CORS 头照常返回。

唯一的例外是**已加密的附件上传**：`POST /api/v2/sessions/{id}/attachments` 带请求头 `x-aa-sealed: segments-v1` 时放行。上传内容是客户端用一次性密钥按 e2ee 1.0 分段加密后的密文，密钥只经安全通道交给设备。

`PATCH /api/v2/sessions/{id}/meta` 仍可修改置顶、归档等状态，但请求体带明文 `title` 时同样返回 `409 e2ee_required`：加密模式下标题只能以客户端加密后的展示信封提交。

会话目录（`GET /api/v2/sessions`、`…/meta`）、归档/已读/置顶、设备与设置、项目、用量、模型配置、Dashboard 推送、公开分享读取（密文）照常可用。Server 在加密模式下能看到的明文元数据见 `docs/v3/11-e2ee-noise.md` §10。

## 命令登记

命令（发消息、审批、计划、目标、设置等）在安全通道里，Server 读不到。客户端在发送前另发一条明文登记，Server 据此保证同一 `commandId` 只执行一次，并记录结果状态：

```http
POST /api/v3/e2ee/commands
{"commandId": "cmd_…", "deviceId": "…", "inputDigest": "hmac-sha256:…"}
```

`inputDigest` 用设备的列表密钥计算（`contracts/e2ee/1.0` 的「输入摘要」），Server 只做相等比较，无法验证猜测的输入。

| 情况 | 结果 |
| --- | --- |
| 新的 `commandId` | `200`，`duplicate: false`；客户端随后经安全通道发送命令 |
| 同一 `commandId`、同一设备、同一摘要 | `200`，`duplicate: true`，返回已有的登记与结果；客户端不要重复执行 |
| 同一 `commandId`，设备或摘要不同（含其他用户用过的 ID） | `409 command_conflict` |
| 设备不存在或不属于当前用户 | `404 not_found` |

```http
GET /api/v3/e2ee/commands/{commandId}
```

返回：

```json
{
  "commandId": "cmd_…",
  "deviceId": "…",
  "inputDigest": "hmac-sha256:…",
  "registeredAt": "2026-11-16T08:00:00Z",
  "outcome": "accepted",
  "errorCode": null,
  "finishedAt": "2026-11-16T08:00:01Z",
  "duplicate": false
}
```

`outcome` 是 `accepted`、`rejected` 或 `null`（设备还没报告）。结果由设备经出站箱的 `command.result` 报告，不含内容；以第一次报告为准。登记保留 7 天。

## 模式切换

| 场景 | Server 的处理 |
| --- | --- |
| `off → required` | 第一次以 `required` 启动时，清空所有会话的明文标题、标题来源和工作目录，以及不是密文的展示信封（设备上报的明文 `displayDevice`、普通模式改名写下的明文 `displayUser`；密文信封保留）（列表显示「加密中，设备上线后显示」），并开始拒绝明文内容路由；设备上线后用列表密钥重新写入密文展示信封 |
| 在 `required` 下重启 | 不再清空 |
| `required → off` | 不改动已存数据；已开启加密的设备与客户端仍只接受安全通道，直到在该设备上本机确认降级 |

上次运行的模式记在实例设置 `e2ee.mode` 里。

## 数据库

`v2_63` 新增 `e2ee_command_registrations`（命令 ID、用户、设备、输入摘要、时间、结果状态与错误码），不改写已有数据。

## 金丝雀扫描（E-1）

`server/scripts/e2ee_canary_scan.py` 在 Server 一侧查找事先放进内容里的随机字符串，按 UTF-8、UTF-16LE、十六进制和标准/URL 安全 base64（三种对齐）逐一匹配；WebSocket 抓包先去掩码、解压 `permessage-deflate` 再查。可以扫描：

- PostgreSQL 的所有表、Redis 当前库的所有键和值；
- 对象存储（本地文件根目录；S3 先用 `aws s3 sync` 或 `mc mirror` 镜像到本地再扫）；
- Server、Router 的日志文件；
- 抓到的 TCP 字节和单方向的 WebSocket 流（Server ↔ Router、Router ↔ 设备）。

有命中时退出码为 1：

```bash
uv run python -m scripts.e2ee_canary_scan --canary-file canaries.txt \
  --db-url "$AGENT_SERVER_DB_URL" --redis-url "$AGENT_SERVER_REDIS_URL" \
  --files-root /var/lib/agents-anywhere/files --logs server.log --logs router.log \
  --ws-capture server-to-router.bin --ws-capture router-to-server.bin
```

`server/tests/test_e2ee_canary.py` 用它在进程内做一遍：真实 MeshCall Router（`MESHCALL_ROUTER_BINARY`）前面放一个记录字节的代理，两段 Router 连接都经过它；内容以密文经隧道送到设备，附件以 `x-aa-sealed` 上传，命令按摘要登记，明文请求被拒绝；之后扫描数据库、文件、日志、两段 Router 流量和发给客户端的隧道帧。设置 `AGENT_SERVER_TEST_REDIS_URL`（指向一个空的库，测试结束后会清空它）时一并扫描 Redis。

还没有覆盖的：真实设备（A 的连接和 connector-ts 通道，测试里的设备只回显密文）、隧道 WebSocket 端点本身和 uvicorn 访问日志。被拒绝的明文请求仍会以路径和查询参数出现在访问日志里；正确的客户端在加密模式下不会发出这类请求。
