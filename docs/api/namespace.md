# API v2 Namespace 迁移

Agents Anywhere v2 在 `/api/v2` 下提供产品 API。

Web UI 仍可从 `/`、`/en` 这类语言路由以及 `/_next/*` 等静态资产提供。只有 API、
SSE 与 WebSocket 端点迁移。

## 路由映射

| 旧的根路径 | 新的 v2 路径 |
| --- | --- |
| `/health` | `/api/v2/health` |
| `/auth/*` | `/api/v2/auth/*` |
| `/oauth/*` | `/api/v2/oauth/*` |
| `/.well-known/oauth-authorization-server` | `/api/v2/.well-known/oauth-authorization-server` |
| `/admin/*` | `/api/v2/admin/*` |
| `/agents/*` | `/api/v2/agents/*` |
| `/connectors/*` | `/api/v2/connectors/*` |
| `/pairing/*` | `/api/v2/pairing/*` |
| `/sessions/*` | `/api/v2/sessions/*` |
| `/connector/*` | `/api/v2/connector/*` |

## Web 迁移

`AGENTS_ANYWHERE_API` 与 `NEXT_PUBLIC_AGENTS_ANYWHERE_API` 保持为服务器 origin，
而不是 API namespace：

```bash
AGENTS_ANYWHERE_API=http://127.0.0.1:8000 yarn dev
```

不要设置成 `http://127.0.0.1:8000/api/v2`。

`web-next/src/lib/api/client.ts` 通过 `apiPath()` 管理 namespace。常规 API 调用应
继续传产品路径，例如 `/auth/login` 或 `/sessions`；客户端会将其转换为
`/api/v2/auth/login` 与 `/api/v2/sessions`。

任何不经过 `ApiClient` 构造 URL 的 Web 代码必须显式调用 `apiPath()`。这适用于：

- SSE 端点，如会话事件与 dashboard 事件。
- WebSocket 端点，如连接器终端流。
- 直接的浏览器链接，如附件打开/下载 URL。

Next.js 开发代理把 `/api/v2/*` 重写到后端。不要再新增根级别的 API rewrite。

## Connector 迁移

Connector 配置仍然保存服务器 origin：

```bash
uvx anywhere-cli configure \
  --server-url http://127.0.0.1:8000 \
  --connector-id conn_xxx \
  --connector-token cxt_xxx
```

不要把 `/api/v2` 存进 `serverUrl`。

`connector.server.urls` 通过 `api_v2_path()`、`api_v2_url()` 与 `ws_url()` 负责
端点构造。Connector 的 HTTP 与 WebSocket 调用现在指向：

- `POST /api/v2/connector/auth`
- `POST /api/v2/connector/ingest`
- `WS /api/v2/connector/ws`
- `GET /api/v2/connector/sessions/{session_id}/attachments/{file_id}/content`
- `PUT /api/v2/connector/fs/transfers/{transfer_id}`
- `WS /api/v2/connector/terminals/{terminal_id}/relay`

Connector 健康探测使用 `/api/v2/health`。

服务器生成的连接器 URL，例如文件传输的 `uploadUrl` 与运行时附件的
`downloadUrl`，返回时也已带 `/api/v2`。Connector 的 URL 辅助函数对已带前缀的
路径是幂等的。

## 兼容规则

v2 中不要再新增根级别的 API 路由。只要一个路由属于产品 API、SSE 或 WebSocket，
就挂到 `/api/v2` 下。
