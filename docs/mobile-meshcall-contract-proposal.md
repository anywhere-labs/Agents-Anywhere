# 移动端 MeshCall 与共用契约调研

建议先把 Android、iOS 到 Server 的加密通道改为 MeshCall 双向流。Server 根据登录身份和设备归属建立下游调用，Connector 与手机继续按 AA 的 Noise 协议完成配对和加解密。两段复用同一份密文帧和通道生命周期定义。普通模式可以沿用这个入口的鉴权机制，再复用现有业务路由表迁移会话操作。

## 当前调用链

| 路径 | #770 的实现 | 移动端 PoC |
| --- | --- | --- |
| 手机 → Server | HTTPS 申请 dashboard 票据，`/api/v3/tunnel` 用 WebSocket 传 `tun` 和 `end`。原生已有 `TunnelConnection` 和 `E2EETunnel` 入口 | 两端通过 `SessionsClient` 接入 `MockSessionsClient`，回放本地 fixtures |
| Server → Connector | `aa.device.v1.Secure/channel` 传双向密文；普通模式调用 `Client/call` 和流式接口 | 草案让原生经 Router 直调设备的 `aa.v3.Sessions`，事件模型为 `Session / Message / Control` |
| 原生 → WebView | 现有正式客户端负责会话展示 | `aa.render/1` 传渲染事件、分页结果和原生视口信息，WebView 渲染对话 |

#770 的 `TunnelSession` 已经把上游的 `{n, ct}` 转成 `SecureChannelItem`，下游收到的字段也原样发回。Server 在开下游流前校验设备归属和当前在线代次。PoC 的 `aa.v3.Sessions` 是业务模型草案，`aa.render/1` 是本地桥。接真实数据时，可以让 `SessionsClient` 的原生适配器把 #770 的快照和事件转换成 PoC 的渲染模型。第一条网络链路可以先挂到正式客户端现有的隧道接口，复用它们的配对和会话逻辑。

[现有加密契约](../contracts/e2ee/1.0/README.md) · [Server 中继](../server/agent_server/services/device_tunnel.py) · [PoC 服务草案](../v3poc/protocol/services.ts) · [PoC 渲染桥](../v3poc/protocol/bridge.ts)

## 共用契约放在哪里

| 定义 | 建议 |
| --- | --- |
| 开流请求 | 手机入口带 `deviceId`、`clientId`、`ch`。下游保留 `SecureChannelOpen {clientId, ch}`，`deviceId` 由 Server 用来选目标实例。两端共享 `clientId` 和 `ch` 的校验规则，完整路由继续绑定到 AA Noise 握手 |
| 双向帧 | 从 AA E2EE 契约导出一份 `SecureChannelItem {n, ct}`。WebSocket 适配器把它装进旧 `tun` 帧，两个 MeshCall 服务直接把它用作流项。以 AA 现有帧大小、base64url 和每方向计数规则为准 |
| 结束与错误 | MeshCall 提供开流、背压、结束和取消。AA 复用一份关闭原因定义，保留未配对、设备离线和协议错误等语义。上游取消时关闭下游流，下游失败时结束上游流。转发沿用流控并限制待发送数据，避免慢手机导致 Server 不断积压 |
| 会话操作 | 加密消息继续使用现有 `request`、`response`、`subscribe`、`event`。迁移普通模式时，从 `client_routes.py` 输出的路由 ID、请求类型和错误语义生成手机入口，保持设备执行、用量校验、命令回执和响应补充的现有职责 |
| 登录与设备授权 | 手机凭据来自已登录账号，只能调用手机入口。设备凭据用于服务注册、在线租约和出站箱。Server 按可信账号校验 `deviceId`，并向对应在线代次发起下游调用 |

生成入口沿用 `server/scripts/export_v3_contracts.py`。两份 MeshCall 服务定义引用同一个帧模型，Swift、Kotlin 的生成客户端和 Connector 类型均从这份模型导出。MeshCall 的调用 ID 用于当前流，`ch` 和 `n` 用于加密通道，`afterCursor` 用于会话事件恢复，`commandId` 用于操作回执和幂等。

[设备 MeshCall 契约](../contracts/device-meshcall/1.0/README.md) · [业务路由表](../server/agent_server/core/client_routes.py) · [契约生成入口](../server/scripts/export_v3_contracts.py)

## 凭据和断线恢复

优先验证具有方法级权限的 Router 凭据，以及由 Server 签发、可在任一入口实例校验的账号授权。授权需要绑定登录会话和允许的设备，账号身份由 Server 校验后取得。Router 的 `instance_ids` 约束的是注册身份，手机的调用权限必须由方法范围和 Server 的设备授权共同约束。Router 的凭据过期只影响新连接，登出和撤销还需要能结束现有流。

Router 的 `TunnelService` 也可以提供 Router 注入的可信 principal，机制与 PoC 的直连构想相近。它会把凭据绑定到一个接受隧道的服务实例，入口实例滚动重启时需要重新领票。若让手机直接调用 Connector，还要重新设计在线代次、设备授权撤销和命令回执的处理位置。第一阶段让 Server 承接这些已有职责，并用 AA 的 `XXpsk0` / `KK` 维持现有的手机与设备信任关系。

以加密续聊为例，手机用现有 `commandId` 登记操作并在加密通道内投递。若流在投递后断开，手机以同一身份开新 `ch`，完成 `KK` 后按保存的 `afterCursor` 恢复订阅。收到 `session.subscribed` 后按时间线契约应用回放和实时事件。操作交付结果未知时沿用原来的回执与幂等语义，避免把流重连变成重复发送。

[Router 鉴权与隧道](https://github.com/t4wefan/meshcall/blob/93344059ada65735c6cc08fdf3247ea9fb808d6b/docs/router.md#tunnels) · [AA 配对与事件恢复](../contracts/e2ee/1.0/README.md#通道的建立)

## 开发顺序与验证

1. 在同一个 Router 上验证 Swift 和 Kotlin/JVM SDK 的鉴权、双向流、背压与取消。#770 锁定 `9334405`，移动 SDK 已合入 `ce14d60`，两者的实际互操作需验证。若需要更新 Router，统一锁定已验证的 Router、Python、TypeScript 和移动 SDK 组合，同时确定 SwiftPM 子包和 Gradle 依赖的可复现分发方式。
2. 在共享帧契约上接入手机入口，并让现有 WebSocket 入口和手机入口共用设备授权及密文中继。首轮验收走两个正式移动客户端的扫码配对、打开已有会话、发送及接收回复、切网或重启、恢复订阅和撤销配对。包含两个账号的设备归属校验，核对连接恢复后无需重新扫码、回复无重复、被撤销的连接无法继续发送。
3. 在普通模式复用现有业务路由表，优先迁移会话读、发消息和订阅，再评估终端、文件和其他客户端入口。PoC 可在同一链路上接入真数据，验证 `SessionsClient` 的事件转换、分页错误以及演示自动审批与真实客户端的隔离。

[MeshCall Swift #74](https://github.com/t4wefan/meshcall/pull/74) · [MeshCall JVM #75](https://github.com/t4wefan/meshcall/pull/75) · [上游握手重试 #76](https://github.com/t4wefan/meshcall/issues/76) · [上游 TypeScript 重连 #77](https://github.com/t4wefan/meshcall/issues/77)
