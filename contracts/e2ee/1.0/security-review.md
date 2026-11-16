# e2ee 1.0 安全评审准备

给安全评审用的材料：信任边界、各端密钥放在哪里、实现中发现并修正的问题、已知的剩余风险，以及评审时要逐项核对的地方。协议本身见同目录 [README.md](README.md)。

## 信任边界

| 角色 | 信任 | 能看到的 |
| --- | --- | --- |
| 设备（Connector） | 完全可信：持有设备身份私钥、列表密钥、全部会话内容 | 全部 |
| 已配对的客户端 | 可信：持有客户端身份私钥、列表密钥 | 已授权设备的全部内容 |
| Server、MeshCall Router、数据库、Redis、对象存储、日志 | **不可信**（加密模式下） | 路由头、帧大小与时间、命令 ID 与键控摘要、结果状态、明文元数据（README「不变量」与 docs/api/e2ee.md） |
| Web 客户端的代码来源 | 由 Server 下发，**不可信**；所以 Web 只能防被动泄露 | — |

前提：设备与客户端所在的操作系统可信；用户会核对配对时显示的指纹。

## 各端密钥放在哪里

| 端 | 身份私钥 | 列表密钥 | 本机策略 |
| --- | --- | --- | --- |
| 设备（connector-ts） | `FileDeviceSecrets`：AES-GCM 加密后写文件（0600），文件密钥放在系统密钥库（macOS Keychain / Windows DPAPI / Linux Secret Service；都不可用时回退到明文文件并告警） | 同左 | `FileTrustRepository`；Server 的声明只能收紧，放松需要本机确认 |
| Web / Desktop | WebCrypto **不可导出**的 CryptoKey，存 IndexedDB | 导入为不可导出的 AES-GCM 密钥和 HMAC 子密钥 | IndexedDB；Server 声明过 `required` 后记为实例级要求，只能本机放松 |
| Android | Android Keystore 中一把不可导出的 AES-256-GCM 密钥包裹后存储（minSdk 26 的 Keystore 没有 X25519）；不进系统备份 | 同左 | 实例级 + 设备级，都只能本机清除 |
| iOS | Keychain，`AfterFirstUnlockThisDeviceOnly`，不同步 iCloud；按账号（Server + 用户）分开 | 同左 | 设备级，只增不减 |

## 实现中发现并修正的问题

| # | 问题 | 后果 | 修正 |
| --- | --- | --- | --- |
| 1 | 客户端根据 Server 转发的 `ClientTunnelEnd.code = e2ee_not_paired` 删除钉住的设备 | Server 伪造该码即可把一台设备降级为明文（违反 E-3） | 三端客户端：只有设备**在通道内**发来的 `close`（revoked/not_paired）才删除钉住的设备；Server 转发的码只用来报错（#705、#712、#717、#681 c215af98） |
| 2 | 定时或按帧数的 rekey 可能插在同一条消息的两个分片之间，而接收方把这种情况当作协议错误 | 大消息恰好跨过 rekey 时间点时，通道断开 | rekey 只在两条消息之间进行（#681、#705、#712、#717） |
| 3 | 参考实现中 `close` 处理的错误码与消息参数写反了 | 错误码不对 | 按 reason 映射为 AA 错误码（#681） |
| 4 | 撤销与列表密钥轮换同时发生时，被撤销的通道仍可能收到新的列表密钥 | 被撤销的客户端拿到新密钥 | 只推给仍在授权列表里的客户端，正在关闭的通道不再推送（#681） |
| 5 | 加密模式下，`PATCH /sessions/{id}/meta` 仍然接受明文 `title` | 标题以明文进入数据库 | 加密模式下拒绝并返回 409 `e2ee_required`（#698） |
| 6 | Android 把 `/auth/config.e2ee` 的 `web`/`preview` 按布尔值解析 | 配置被误读 | 改为按 `"allow"`/`"deny"` 解析（#712） |

## 剩余风险与待决定项

1. **会话归属被谎报**：会话属于哪台设备（`connectorId`）这一信息由 Server 提供。在 Server 从未声明过 `required` 的部署里，恶意 Server 可以谎称某个会话属于一台没有要求加密的设备，从而诱使客户端以明文发送用户新输入的内容。缓解措施：客户端第一次记下归属后不再改写；本机已配对过设备、但归属未知时一律走加密（fail closed）；Server 一旦声明过 `required`，客户端就记为实例级要求。评审时请判断是否需要更严格的规则，例如只要配对过任何设备，就让整个实例都要求加密。
2. **Web 客户端**：页面代码由 Server 下发，恶意 Server 可以下发窃取密钥或内容的脚本。这是 Web 的固有限制。私钥不可导出只能防止离线拿走密钥，挡不住在线滥用。可以用 `AGENT_SERVER_E2EE_WEB=deny` 关闭 Web。
3. **端口预览**不在加密范围内，网关与 frps 能看到明文流量；可以用 `AGENT_SERVER_E2EE_PREVIEW=deny` 关闭。
4. **隧道 WS 的鉴权**（`ws-ticket` 的 `scope: {tunnel: true}`）由 C 实现，尚未定稿。评审要确认：票据只能打开属于本用户的设备的路由，并且 Server 会校验 `clientId` 与 `ch` 的格式。这类问题只会影响可用性，不会泄露内容。
5. **命令登记的摘要**以列表密钥为键。两次重试之间如果列表密钥轮换，摘要会不同，会被当作冲突处理（可用性问题）。摘要按客户端发送的那份请求体字节计算，三端都没有重新序列化。
6. **已有实例从 `off` 切到 `required`**：Server 只清空会话的标题、标题来源和工作目录。v2 时期留在数据库里的时间线、附件等历史内容不在本次清理范围内：v3 Server 不保存消息，旧表由迁移处理。评审时要确认升级路径会删除这些旧的明文数据。
7. **元数据**：Server 能看到设备与客户端的 ID 和名称、会话状态、时间、帧大小等（docs/api/e2ee.md），这是有意的设计。

## 评审核对清单

- [ ] 三端都只用成熟库提供的原语：Node `node:crypto`、WebCrypto、JCA 加 noise-java DH、CryptoKit。只有 Noise 状态机是自己实现的，由 64 个官方向量、AA 向量和反例覆盖（S8）。
- [ ] prologue 绑定了 deviceId、pairingId、clientId 和 ch；配对握手核对的设备公钥与二维码一致；KK 握手用的是钉住的公钥。
- [ ] psk 一次性使用、10 分钟过期，同时最多 3 个未完成的配对；Server 拿不到 psk。
- [ ] nonce 必须连续，乱序或重放都会关闭通道；rekey 只在消息之间。
- [ ] 展示信封的 AD 绑定 deviceId、sessionId、slot 和 keyId；附件分段的 AD 绑定明文摘要与是否为最后一段。
- [ ] Server 的闸门在路由之前执行，HTTP 与 WebSocket 都覆盖，CORS 在闸门外层。
- [ ] 加密模式下，出站箱与命令回执不含内容（`scrub_for_e2ee`）；数据库金丝雀测试零命中。
- [ ] 撤销后通道立即断开、KK 握手失败、列表密钥轮换，新密钥只发给仍被授权的客户端。
