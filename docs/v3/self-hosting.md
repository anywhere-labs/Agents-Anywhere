# 自托管 AA v3

本文说明如何用 `docker/v3/` 里的 Compose 在一台服务器上部署 AA v3 的云端部分：

| 组件 | 作用 | 对外地址 |
| --- | --- | --- |
| `web` | web-v3（Next.js） | `https://<域名>` |
| `control` | server-v3 轻控制面：账号、设备、隧道准入、MCP、云盘元数据 | `https://api.<域名>` |
| `router` | MeshCall Router，客户端与 Connector 之间的 RPC 转发 | `wss://router.<域名>` |
| `postgres` / `redis` | 控制面的数据库与协调 | 不对外 |
| `s3`（可选，RustFS） | 云盘对象存储，客户端直传直下 | `https://files.<域名>` |
| `caddy` | HTTPS 证书与反向代理 | 80 / 443 |

控制面只保存账号、设备、隧道和云盘文件元数据；对话、消息、附件都留在各台工作设备的 Connector 上。加密设备的流量经 Router 端到端加密，服务器看不到内容。

## 部署

前提：一台有公网 IP 的 Linux 服务器，装好 Docker 与 Compose v2；三个（启用云盘时四个）DNS 名称都指向这台服务器。

```bash
cd docker/v3
./init.sh aa.example.com --drive
```

`init.sh` 生成 `.env`：随机的数据库密码、签名密钥、首个管理员的 setup token，以及 Router 上控制面账号的口令和摘要。`.env` 已被 `.gitignore` 忽略，不要提交；它已存在时脚本不会覆盖。

```bash
docker compose --profile drive up -d --build
```

不需要云盘时去掉 `--drive` 和 `--profile drive`。要用外部 S3（Cloudflare R2、阿里云 OSS、AWS S3 等），在 `.env` 里填 `AA_S3_ENDPOINT`、`AA_S3_PUBLIC_ENDPOINT`、`AA_S3_BUCKET` 和访问密钥即可，不必启用 `drive` profile。

数据库迁移由一次性的 `migrate` 服务在 `control` 启动前执行。

## 创建管理员

第一个账号是管理员，注册时必须带 `.env` 里的 `AA_CONTROL_SETUP_TOKEN`（`init.sh` 结束时会打印完整命令）：

```bash
curl -fsS https://api.aa.example.com/auth/register -H 'content-type: application/json' \
  -d '{"email":"you@example.com","password":"…","display_name":"Admin","setup_token":"…"}'
```

之后默认关闭公开注册（`AA_CONTROL_REGISTRATION_OPEN=false`）。

## 连接工作设备

在每台工作设备上安装 Connector v3，然后用管理员账号登录 Web 拿到令牌，注册并启动：

```bash
aa-connector register --control-url https://api.aa.example.com --access-token <令牌> --name "我的电脑"
aa-connector start
```

加 `--mode encrypted` 注册为加密设备；加密设备要在设备本机用 `aa-connector pair` 生成一次性配对链接，再在客户端扫码或粘贴。

## 升级与备份

- 升级：`git pull` 后 `docker compose up -d --build`，`migrate` 会自动执行新的迁移。
- 备份：`postgres` 卷保存账号和设备；`s3` 卷保存云盘文件（云盘文件本身有过期时间，默认 7 天）。Redis 只保存在线状态和队列，丢失后会自动重建。
- `.env` 里的密钥更换后，已注册设备和已登录客户端需要重新注册或登录。

## 已知限制

- Router 目前是单实例；多实例需要 `AA_CONTROL_ROUTERS_JSON`，Compose 里没有提供。
- 推送通知（APNs / FCM）需要另外配置凭据，见 [server-v3 README](../../server-v3/README.md)。
- 本 Compose 在本机以 `*.localhost` 域名（Caddy 内部证书）跑通过：首个管理员注册、关闭注册、Web 登录页与控制面转发、Router WebSocket、真实 Connector 注册上线、Pi 对话、附件（含经云盘中转的 9 MiB 大附件）和 MCP 全流程。还没有在公网服务器上用真实证书部署过。
