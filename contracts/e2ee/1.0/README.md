# E2EE 1.0（可选的端到端加密模式）

部署配置 `AGENT_SERVER_E2EE=off|required`，默认 `off`。开启后客户端与设备之间建立 Noise 安全通道，客户端在 `WS /api/v3/tunnel` 上发 `ClientTunnelFrame`，Server 经 MeshCall duplex `aa.device.v1.Secure/channel` 原样转给设备（`contracts/device-meshcall/1.0`），只读 `route` 与 `n`。设计见 `docs/v3/11-e2ee-noise.md`（本地设计文档）。

- 源头：`server/agent_server/core/e2ee.py`；生成同 device-meshcall。
- 首次配对：`Noise_XXpsk0`，psk 来自二维码 `aa-pair://<base64url(PairingPayload)>`，10 分钟有效，只能用一次。
- 重连：`Noise_KK`。每 1 小时或 2^20 帧重新协商密钥（Noise `REKEY`）。
- 套件（S8 结论）：`Noise_XXpsk0_25519_AESGCM_SHA256`、`Noise_KK_25519_AESGCM_SHA256`，见下文「套件与实现」。三端共用 `vectors/` 下的测试向量。
- 通道内是与普通模式相同的客户端 API：`TunnelRequest` / `TunnelResponse` / `TunnelEvent`。
- Server 能看到的只有：路由头、帧大小与时间、`CommandRegistration`（命令 ID、设备、客户端计算的输入摘要）。

## 不变量

- 只有设备能改信任列表；Server 的任何声明都不改变本地记录。
- 撤销立即生效并轮换列表密钥（`DirectoryKeyGrant` 新纪元）。
- 设备和客户端本地记住「必须加密」，Server 改配置不能让它们接受明文（降级保护）。
- 客户端钉住设备公钥；公钥变化报 `device_pin_mismatch`，必须重新配对。

## 标识与绑定

- `clientId = "cli_" + base32小写(SHA-256(label("client-id") ‖ 0x00 ‖ 客户端身份公钥))[:26]`。由身份公钥算出，所以 Server 改不了「哪个公钥对应哪个 clientId」。设备在握手后核对。
- `label(…)` 指 `aa-e2ee/1.0` 加上各字段，用 NUL 连接后取 UTF-8 字节。所有绑定都用它：Noise prologue、展示信封的 AD、密文分段的 AD、输入摘要的子密钥。
- 指纹：取 SHA-256(公钥) 的前 32 个十六进制字符，每 4 个一组，共 8 组，用来人工比对（§7.2 批准新客户端时用）。
- Noise prologue：
  - 配对：`label("pair", deviceId, pairingId, clientId, ch)`；
  - 重连：`label("connect", deviceId, clientId, ch)`。
  
  两端各自用自己认为的值构造 prologue，Server 改写任何一个路由字段，握手的第一条消息就会失败。
- `ch`：`[A-Za-z0-9_-]{1,64}`，由客户端选。每条通道只对应一次握手，断线后用新的 `ch` 重新握手，不恢复旧的会话密钥。

## 通道的建立

客户端在 `WS /api/v3/tunnel` 上发出某个 `(deviceId, clientId, ch)` 的第一帧后，接到 WS 的 worker 打开 `Secure/channel {clientId, ch}`，之后双向原样转发 `{n, ct}`。

**握手阶段**：`ct = base64url(utf8(json(HandshakeEnvelope)))`，`n = step`。

| 场景 | step 0（客户端 → 设备） | step 1（设备 → 客户端） | step 2（客户端 → 设备） | 之后 |
| --- | --- | --- | --- | --- |
| 扫码配对 `XXpsk0`（带 `pairingId`） | 空 payload | `PairingDeviceHello`。客户端核对 `deviceId`，并核对消息里的设备静态公钥与二维码一致，否则报 `device_pin_mismatch` | `PairingClientHello` | 设备原子地消费 `PairingSession`、写入授权，然后发 `pair.committed`，再发 `ready` |
| 重连 `KK` | 空 payload | 空 payload | — | 设备重新检查授权与策略后发 `ready` |

设备侧的检查：

- `XXpsk0`：`pairingId` 必须存在、处于 open 状态且未过期；握手后 `client_id_for(rs)` 必须等于 `SecureChannelOpen.clientId`。
- `KK`：在信任列表里查 `clientId`，取出钉住的公钥作为 `rs`；查不到或已撤销，就发 `close {reason: "not_paired"}`，Server 把它映射成 `e2ee_not_paired`。

客户端在收到 `ready` 之前不发任何请求；任何一方都不在握手消息里携带业务数据（不做 0-RTT）。`pair.committed` 丢失时，客户端用 KK 重试：KK 成功就说明授权已经写入。

**结束一条通道**：`ClientTunnelEnd {t: "end", route, code}`。

- Server 发给客户端，表示设备结束了 `Secure/channel` 调用（`code` 取调用的错误码）或者设备离线（`connector_offline`）。
- 客户端发给 Server，表示取消这次调用。
- 握手完成前的失败只能这样报：`e2ee_not_paired`、`pairing_expired`、`e2ee_handshake_failed`（psk 不对、路由被改写、设备身份变了）、`e2ee_protocol_error`。
- Server 能伪造的最多只是一次断线。客户端不会因为收到 `end` 而放松加密要求；重连时 KK 失败，客户端报 `device_pin_mismatch`。

**传输阶段**：`ct = base64url(Noise 传输消息)`，`n` 等于该方向的 Noise nonce。收到的 `n` 与本端接收计数器不一致时，直接关闭通道，不尝试解密。

## 帧与消息

Noise 传输消息的明文格式为 `flag(1 字节) ‖ body`，`body` 最长 65518 字节：

| flag | 含义 |
| --- | --- |
| `0x00` | 分片：后面还有同一条消息的分片 |
| `0x01` | 最后一片：拼起来是一条 UTF-8 JSON 的通道消息，按 `kind` 区分 |
| `0x02` | rekey：`body` 为空。发送方发完这一帧立即对自己的发送 CipherState 做 `REKEY`，接收方读完这一帧后立即对接收 CipherState 做同样的操作 |

单条消息拼起来最多 16 MiB，超过就发 `close {reason: "too_large"}`。每个方向距离上次 rekey 满 1 小时或 2^20 帧时，由该方向的发送方主动发起 rekey。

通道消息（`kind`）：

| kind | 方向 | 模型 |
| --- | --- | --- |
| `pair.committed` | 设备 → 客户端 | `PairCommitted`（带当前的 `DirectoryKeyGrant`） |
| `ready` | 设备 → 客户端 | `ChannelReady` |
| `request` / `response` | 客户端 → 设备 / 设备 → 客户端 | `TunnelRequest` / `TunnelResponse`，`path` 就是普通模式下的客户端 API 路径 |
| `subscribe` / `unsubscribe` | 客户端 → 设备 | `TunnelSubscribe` / `TunnelUnsubscribe`，相当于普通模式下打开、关闭实时 WS：`stream: "session"` 是会话 WS（带 `sessionId`、`afterCursor`），`stream: "terminal"` 是设备终端 `terminals-v2/{terminalId}/stream`（带 `terminalId`，每个事件就是普通模式下这条 WS 的一条消息；输入、调整大小、关闭仍用 `request` 发到普通模式的同一路径） |
| `event` | 设备 → 客户端 | `TunnelEvent`：`sub` 指明属于哪个订阅；通道级事件 `e2ee.directory_key`、`e2ee.trust_changed` 不带 `sub` |
| `close` | 双向 | `ChannelClose` |

文件下载：`GET /api/v2/connectors/{deviceId}/fs/read?root=…&path=…&offset=…&length=…`（普通模式的查询参数再加 `offset`、`length`），`length` 最多 8 MiB（`FILE_CHUNK_MAX_BYTES`），响应体是 `TunnelFileChunk {encoding: "base64", data, offset, size, eof}`。大文件按块依次读取，每块都是一条普通的通道消息。浏览目录、读文本文件（`fs/list`、`fs/readText`）与普通模式相同，只是经通道发送。

信任管理同样用 `request`，路径在 `/e2ee/v1/` 下（`TRUST_ROUTES`）：

| 路径 | 请求 | 响应 |
| --- | --- | --- |
| `GET /e2ee/v1/trust` | — | `TrustListResponse` |
| `POST /e2ee/v1/trust/approve` | `ApproveClientRequest` | `ClientGrantView`（设备本机确认后才返回 200） |
| `POST /e2ee/v1/trust/revoke` | `RevokeClientRequest` | `TrustListResponse` |
| `GET /e2ee/v1/directory-key` | — | `DirectoryKeyGrant` |

## 加密的存放内容

- **展示信封**（`DisplayEnvelope`，`mode: "sealed"`）：
  - `payload = base64url(nonce12 ‖ AES-256-GCM(列表密钥, nonce, 明文 JSON, AD))`；
  - `AD = label("display", deviceId, sessionId, slot, keyId)`，`slot` 取 `device` 或 `user`；
  - nonce 每次加密时随机生成。AD 绑定了信封所在的行，Server 没法把一个会话的标题挪到另一个会话。
- **附件与分享**（分段密文）：
  - 每个对象一把随机密钥，明文按 64 KiB 分段，空对象算一个空段；
  - 第 i 段的 nonce 为 4 字节 0 加上 i 的 8 字节大端编码，`AD = label(purpose, objectId, i) ‖ 0x00 ‖ final`，`final` 用来防截断；
  - 附件：
    - 上传：`POST /api/v2/sessions/{id}/attachments`，请求头 `x-aa-sealed: segments-v1`；上传时文件名统一写 `attachment.bin`、类型统一写 `application/octet-stream`，真实的文件名和类型放进 `SealedAttachmentKey.name` / `mimeType`，经通道传输；上传体是各段密文按顺序直接拼接，除最后一段外每段 64 KiB + 16 字节，Server 记录的 `sha256` 是整个上传体（密文）的摘要；
    - 加密时 Server 还没分配 `fileId`，所以分段 AD 的 `objectId` 用明文的 SHA-256（十六进制小写），即 `label("attachment", sha256, i) ‖ 0x00 ‖ final`；
    - 密钥只存在客户端内存里，不落盘；上传后如果客户端重启，就重新加密、重新上传；
    - 发消息的请求体照常在 `attachments` 里引用 `fileId`，并在同一请求体里加 `sealedAttachmentKeys: [SealedAttachmentKey]`。整个请求体经通道传输，密钥不经过 Server；
    - 设备从 Server 取回密文，按 64 KiB + 16 切段解密，核对 `size` 与 `sha256` 后再交给 Runtime；
  - 分享链接是 `/s/{shareId}#k=<base64url 密钥>`，`#` 后面的部分不会发给 Server。
- **命令登记**：
  - 客户端先发 `POST /api/v3/e2ee/commands`（`CommandRegistration`），再经通道发命令；
  - `inputDigest = "hmac-sha256:" + base64url(HMAC(HMAC(列表密钥, label("input-digest")), 请求体原始字节))`；
  - 用的是带密钥的摘要，Server 只能比较两次是否相同，没法拿猜测的内容来验证（例如「同意」这样的短回复）；
  - 列表密钥在两次重试之间轮换时，摘要会不同，这种情况按冲突处理。

## 套件与实现（S8）

套件固定为 `25519_AESGCM_SHA256`，不用设计稿最初写的 ChaChaPoly/BLAKE2s：

- CryptoKit、WebCrypto、Android JCA 都没有 BLAKE2s；Android 26（`minSdk`）的平台加密也没有 ChaCha20-Poly1305。
- AES-256-GCM 与 SHA-256 在每一端都有平台自带、硬件加速的成熟实现，三端都不需要为对称部分引入第三方库。
- 与 PR #617 的 E2EE 草案、MeshCall `Noise_NK` 的套件一致。

| 端 | X25519 | AES-256-GCM、SHA-256、HMAC | 状态机 |
| --- | --- | --- | --- |
| TS（Connector、Desktop） | `node:crypto`（OpenSSL） | `node:crypto` | `connector-ts/src/channel/noise` |
| TS（Web） | WebCrypto `X25519`（不可导出私钥），不支持时用纯 JS 并提示风险 | WebCrypto | 同上，换一个 `NoiseCrypto` 实现 |
| Kotlin（Android） | `org.signal.forks:noise-java` 0.1.1 的 `Noise.createDH("25519")`（Android 33 以下没有平台 X25519） | JCA（设备上是 Conscrypt/BoringSSL） | `android/.../api/e2ee/noise` |
| Swift（iOS） | CryptoKit `Curve25519.KeyAgreement` | CryptoKit | `ios/.../Network/E2EE` |

密码学原语一律来自上表的库；三端各自只实现 Noise 规范 §5 的握手状态机（约 300 行），因为三端都没有同时支持
`XXpsk0` 修饰符与本套件、又成熟维护的 Noise 库（noise-java 只支持旧版 `NoisePSK_` 前缀；npm 上的 Noise 库绑定
libsodium 的 ChaChaPoly/BLAKE2b；Swift 没有成熟的 Noise 库）。

三端行为上的约定：

- DH 结果全零（对端发来低阶点）时握手失败。
- 解密失败时计数器不前进；握手任何一步失败后，这次握手作废，不能继续用。
- 传输消息的 nonce 就是 `ClientTunnelFrame.n` / `SecureChannelItem.n`；收到的 `n` 与本端接收计数器不等时直接丢弃，不尝试解密。

### 测试向量

`vectors/` 下两个文件，TS、Kotlin、Swift 的测试都逐字节比对：

- `noise-official.json`：cacophony（Unlicense）与 snow（Apache-2.0）在固定提交上的全部
  `Noise_*_25519_AESGCM_SHA256` 基本模式与 psk 变体向量（64 条，含 `KK`、`XXpsk0+psk1` 等），证明状态机按规范实现。
  官方集里没有单独的 `XXpsk0`，所以另有下一个文件。
- `aa-formats.json`：Noise 之外的字节格式，包括 clientId、指纹、prologue、展示信封、分段密文、输入摘要、分片和配对 URI。由同一个生成器用 `hashlib`、`hmac`、`cryptography` 生成，Server 的 `tests/test_v3_contracts.py` 拿 `e2ee.py` 的辅助函数逐项核对。
- `aa-noise.json`：AA 用到的两种握手，由独立实现（Python `noiseprotocol` 0.3.1 + `cryptography`）生成，
  不由被测的三端任何一端生成：
  - `pairing`：`XXpsk0`，AA 配对 prologue，之后双向传输帧；
  - `reconnect`：`KK`，双向各 rekey 一次；
  - 反例：psk 不对（无法中间人配对）、篡改设备公钥、未授权客户端、Server 改写路由导致 prologue 不同、重放帧。

重新生成：

```bash
uv run --no-project --with noiseprotocol==0.3.1 python contracts/e2ee/1.0/vectors/generate.py
uv run --no-project --with noiseprotocol==0.3.1 python contracts/e2ee/1.0/vectors/generate.py --check
```

三端测试：

```bash
cd connector-ts && corepack yarn test test/e2ee
cd android && ./gradlew :app:testDebugUnitTest --tests 'com.agentsanywhere.app.api.e2ee.*'
cd ios && swift test --filter NoiseVectors
```
