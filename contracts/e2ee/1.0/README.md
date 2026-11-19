# E2EE 1.0（可选的端到端加密模式）

部署配置 `AGENT_SERVER_E2EE=required` 启用端到端加密。生产隧道与配对 RPC 见 [device-meshcall 1.0](../../device-meshcall/1.0/README.md)。这里定义展示信封、附件、输入摘要和身份标识的应用层字节格式。

## 不变量

- 只有设备能改信任列表；Server 的任何声明都不改变本地记录。
- 撤销立即生效并轮换列表密钥（`DirectoryKeyGrant` 新纪元）。
- 设备和客户端本地记住「必须加密」，Server 改配置不能让它们接受明文（降级保护）。
- 客户端钉住设备公钥；公钥变化报 `device_pin_mismatch`，必须重新配对。

## 标识与绑定

- `clientId = "cli_" + base32小写(SHA-256(label("client-id") ‖ 0x00 ‖ 客户端身份公钥))[:26]`。由身份公钥算出，所以 Server 改不了「哪个公钥对应哪个 clientId」。设备在握手后核对。
- `label(…)` 指 `aa-e2ee/1.0` 加上各字段，用 NUL 连接后取 UTF-8 字节。所有绑定都用它：Noise prologue、展示信封的 AD、密文分段的 AD、输入摘要的子密钥。
- 指纹：取 SHA-256(公钥) 的前 32 个十六进制字符，每 4 个一组，共 8 组，用来人工比对（§7.2 批准新客户端时用）。
- 配对二维码为 `aa-pair://<base64url(PairingPayload)>`。客户端钉住二维码内的 Connector 公钥，Connector 只允许使用本机生成且未过期的邀请，并持久化客户端授权。

## 内容与订阅

设备接受会话订阅后先发送 `session.subscribed`，其 `sequence` 和 `payload.eventCursor` 表示设备当时的会话游标，`payload.clientId` 表示订阅客户端。之后按请求的 `afterCursor` 重放事件并推送实时更新。终端订阅仍以终端的回放和输出事件为准。

实时会话页可经通道读取 `runtime/state` 和 `runtime/capabilities`，设备创建的会话在同步到 Server 的目录前即可读取。设备在会话状态变化时向订阅者发送 `runtime.state.updated`。强制加密模式下，这两个 HTTPS 路径从 Server 已保存的元数据返回结果。新建会话所用的设备 Runtime 模型和权限目录也可经通道读取。

文件下载：`GET /api/v2/connectors/{deviceId}/fs/read?root=…&path=…&offset=…&length=…`（普通模式的查询参数再加 `offset`、`length`），`length` 按协议最多可请求 8 MiB，MeshCall 响应最多返回 2 MiB 原始字节，响应体是 `TunnelFileChunk {encoding: "base64", data, offset, size, eof}`。大文件按块依次读取，每块都是一条普通的通道消息。浏览目录、读文本文件（`fs/list`、`fs/readText`）与普通模式相同，只是经通道发送。

信任管理同样用 `request`，路径在 `/e2ee/v1/` 下（`TRUST_ROUTES`）：

| 路径 | 请求 | 响应 |
| --- | --- | --- |
| `GET /e2ee/v1/trust` | — | `TrustListResponse` |
| `POST /e2ee/v1/trust/revoke` | `RevokeClientRequest` | `TrustListResponse` |
| `GET /e2ee/v1/directory-key` | — | `DirectoryKeyGrant` |

## 加密的存放内容

- **展示信封**（`DisplayEnvelope`，`mode: "sealed"`）：
  - `payload = base64url(nonce12 ‖ AES-256-GCM(列表密钥, nonce, 明文 JSON, AD))`；
  - `AD = label("display", deviceId, sessionId, slot, keyId)`，`slot` 取 `device` 或 `user`；
  - nonce 每次加密时随机生成。AD 绑定了信封所在的行，Server 没法把一个会话的标题挪到另一个会话。
  - 明文 JSON 的字段：`displayDevice` 是 `{title?, cwd?, preview?}`（原生标题、工作目录、最近一条的短摘要），`displayUser` 是 `{title}`（用户改的标题）。字段都可缺省，客户端忽略不认识的字段。普通模式的 `mode: "plain"` 用同样的字段。
  - 显示规则（加密模式，即至少一个信封是 `sealed`）：标题取 `displayUser.title`，没有再取 `displayDevice.title`；工作目录取 `displayDevice.cwd`。这时旁边的明文信封和 Server 的明文 `title` / `cwd` 都只可能来自 Server，一律忽略。
  - 普通模式（没有 `sealed` 信封）：标题先取 `displayUser.title`，没有再取 `displayDevice.title`，两者都没有才用 Server 的明文 `title`；工作目录先取 `displayDevice.cwd`，没有再用明文 `cwd`；`preview` 只来自 `displayDevice`。因此普通模式改名时，新标题必须进 `displayUser`（`plain`），只改明文 `title` 会被 `displayDevice.title` 盖住。
  - `mode` 既不是 `plain` 也不是 `sealed` 的信封一律忽略，当它不存在，再按上面两条处理。
  - 客户端按信封的 `keyId` 找对应纪元的列表密钥；找不到或解不开时显示「加密中」占位，不报错，也不回退到 Server 的明文 `title` / `cwd`（加密模式下它们为空）。客户端应保留最近几个纪元的密钥（Web/Desktop 保留 4 个），设备在轮换后会用新密钥重新密封 `displayDevice`。
- **附件与分享**（分段密文）：
  - 每个对象一把随机密钥，明文按 64 KiB 分段，空对象算一个空段；
  - 第 i 段的 nonce 为 4 字节 0 加上 i 的 8 字节大端编码，`AD = label(purpose, objectId, i) ‖ 0x00 ‖ final`，`final` 用来防截断；
  - 附件：
    - 上传：`POST /api/v2/sessions/{id}/attachments`，请求头 `x-aa-sealed: segments-v1`；上传时文件名统一写 `attachment.bin`、类型统一写 `application/octet-stream`，真实的文件名和类型放进 `SealedAttachmentKey.name` / `mimeType`，经通道传输；上传仍是普通模式的 multipart，只有一个文件部分，其内容是各段密文按顺序直接拼接，除最后一段外每段 64 KiB + 16 字节，Server 记录的 `sha256` 是整个上传体（密文）的摘要；
    - 加密时 Server 还没分配 `fileId`，所以分段 AD 的 `objectId` 用明文的 SHA-256（十六进制小写），即 `label("attachment", sha256, i) ‖ 0x00 ‖ final`；
    - 密钥只存在客户端内存里，不落盘；上传后如果客户端重启，就重新加密、重新上传；
    - 发消息的请求体照常在 `attachments` 里引用 `fileId`，并在同一请求体里加 `sealedAttachmentKeys: [SealedAttachmentKey]`。整个请求体经通道传输，密钥不经过 Server；
    - 设备从 Server 取回密文，按 64 KiB + 16 切段解密，核对 `size` 与 `sha256` 后再交给 Runtime；
  - 分享链接是 `/s/{shareId}#k=<base64url 密钥>`，`#` 后面的部分不会发给 Server。
- **新建会话**：加密模式下 Server 拒绝 `POST /api/v2/sessions` 与 `/sessions/create-and-start`（首条消息、标题都是内容）。客户端把同一个请求（路径、请求体与普通模式相同）经通道发给所选设备，由设备创建并运行会话，再经出站箱把元数据同步给 Server；首条消息与其他消息一样先登记命令。首条消息暂不支持附件（上传前还没有会话）。
- **附件以密钥为准**：消息请求体里 `attachments` 的名称、类型、大小可能是客户端改写后的真实值，也可能是 Server 记录的通用值；设备一律以 `sealedAttachmentKeys` 中同一 `fileId` 的 `name`、`mimeType`、`size`、`sha256` 为准，并在解密后核对 `sha256`。
- **Runtime workflow**：准备工作区、新建向导、答复、会话树、Agent 操作（`/api/v2/runtime-workflows/…`）在加密模式下由 Server 整组拒绝；改走通道之前，客户端在加密设备上直接提示暂不支持。
- **会话归属项目**：加密模式下工作目录（`cwd`）在密封的展示信封里，Server 不能再按它归属项目。规则：
  - `SessionSummary` 增加可选的明文 `projectId`（Server 发的 ID，不是内容）。设备经通道收到的 `create-and-start` 请求体里本来就有 `projectId`，设备记下并在上报中带上；Server **只在首次建行时**用它归属，之后不覆盖（归属是用户字段，唯一写者是客户端）。
  - 设备自己发现的会话（导入、扫描）没有 `projectId`：Server 照常建行，`projectId` 为空；能解密 `displayDevice` 的客户端按解出的 `cwd` 匹配项目，经 `PATCH /sessions/{id}/meta {projectId}` 指定（Server 只校验项目属于同一用户、同一设备）。
  - 普通模式不变，仍按明文 `cwd` 归属。
- **重命名**：标题是内容。加密模式下 Server 拒绝带明文 `title` 的 `PATCH /sessions/{id}/meta`。设备侧支持之前，客户端在加密设备上直接提示暂不支持；之后改为把同一请求经通道发给设备。
- **命令登记**：
  - 客户端先发 `POST /api/v3/e2ee/commands`（`CommandRegistration`），再经通道发命令；
  - `inputDigest = "hmac-sha256:" + base64url(HMAC(HMAC(列表密钥, label("input-digest")), 请求体原始字节))`；
  - 用的是带密钥的摘要，Server 只能比较两次是否相同，没法拿猜测的内容来验证（例如「同意」这样的短回复）；
  - 列表密钥在两次重试之间轮换时，摘要会不同，这种情况按冲突处理。

## 测试向量

`vectors/aa-formats.json` 固定 clientId、指纹、展示信封、分段密文、输入摘要和配对 URI 的字节格式。仓库也保留退役隧道的互操作测试向量。生产加密握手与帧格式由 MeshCall SDK 实现。
