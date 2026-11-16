# E2EE 1.0（可选的端到端加密模式）

部署配置 `AGENT_SERVER_E2EE=off|required`，默认 `off`。开启后客户端与设备之间建立 Noise 安全通道，客户端在 `WS /api/v3/tunnel` 上发 `ClientTunnelFrame`，Server 经 MeshCall duplex `aa.device.v1.Secure/channel` 原样转给设备（`contracts/device-meshcall/1.0`），只读 `route` 与 `n`。设计见 `docs/v3/11-e2ee-noise.md`（本地设计文档）。

- 源头：`server/agent_server/core/e2ee.py`；生成同 device-meshcall。
- 首次配对：`Noise_XXpsk0`，psk 来自二维码 `aa-pair://<base64url(PairingPayload)>`，10 分钟有效，只能用一次。
- 重连：`Noise_KK`。每 1 小时或 2^20 帧重新协商密钥。具体套件（ChaChaPoly/BLAKE2s 或 AESGCM/SHA256）由 S8 选定后写进本文，三端共用 `vectors/` 下的测试向量（S8 产出）。
- 通道内是与普通模式相同的客户端 API：`TunnelRequest` / `TunnelResponse` / `TunnelEvent`。
- 认证：`WS /api/v3/tunnel?ticket=...`，ticket 是 `POST /api/v2/ws-ticket` 以 `{"scope": {"dashboard": true}}` 申请的一次性 dashboard 票据（与 `/api/v2/dashboard/ws` 同一种）。不另设 tunnel scope：ws-ticket 请求模型也导出到已冻结的 protocol 1.0/1.1 schema。
- Server 能看到的只有：路由头、帧大小与时间、`CommandRegistration`（命令 ID、设备、客户端计算的输入摘要）。

## 不变量

- 只有设备能改信任列表；Server 的任何声明都不改变本地记录。
- 撤销立即生效并轮换列表密钥（`DirectoryKeyGrant` 新纪元）。
- 设备和客户端本地记住「必须加密」，Server 改配置不能让它们接受明文（降级保护）。
- 客户端钉住设备公钥；公钥变化报 `device_pin_mismatch`，必须重新配对。
