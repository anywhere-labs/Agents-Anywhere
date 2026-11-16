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
