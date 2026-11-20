# v3 客户端（`v3poc`）与新架构对齐说明

> 面向 `v3poc`（Android / iOS / Web）与 **G41** 实施对齐。原 PR #770（`device-meshcall 1.0` + 部署级加密开关 `AGENT_SERVER_E2EE`）已关闭不再采纳；AA v3 已定稿转向控制面 + MeshCall 隧道 + 设备级双模式（见 [architecture-proposal.md](architecture-proposal.md)、[e2ee-admission-proposal.md](e2ee-admission-proposal.md) 与 `contracts/aa-v3/1.0/`）。

## 1. 对 G41 当前 mock 阶段的影响

- **不需要停工**：G41（Android 端 mock 页面与交互对齐）继续推进第三～七阶段即可。
- **需要微调的是「加密模式与配对」的口径**（特别是第二阶段 T499 中曾参考 PR #770 文案的部分），避免后续接真实协议时返工。

## 2. 关键变更对照（PR #770 旧口径 → v3 定稿口径）

| 项目 | 旧口径（PR #770，已废止） | 新定稿口径（`contracts/aa-v3/1.0/`） |
| --- | --- | --- |
| 加密粒度 | 部署级全局开关（`AGENT_SERVER_E2EE=off\|required`） | **设备级双模式**：每台工作设备独立选择普通模式或加密模式 |
| 首次配对方式 | 粘贴/扫码 `aa-pair://` + 应用层 `pair()` RPC 传密钥 | 扫码或输入工作设备本机生成的一次性配对码 `aa-pair://v1/<base64url>`（含 `v`、`instance_id`、`device_pub`、`pairing_id`、`psk`、`expires_at`），经 `Noise_IKpsk2_25519_AESGCM_SHA256` 握手完成配对 |
| 配对时本机确认 | 依赖设备审批流 | **默认关闭、设备侧可选开启**（以兼容无人值守或无界面设备），扫码并完成 `IKpsk2` 握手即可生效 |
| 密钥变更 / 轮换 | 曾考虑客户端内信任新公钥 | **不提供「信任新公钥」按钮**；遇到 `device_pub_mismatch` 一律提示重新扫码配对 |
| 信任等级视觉（锁图标） | 无区分 | **独立分发端（iOS / Android / Desktop）显示绿色锁**；**Web 浏览器端显示灰色锁**并提示「仅防被动泄露，不防恶意服务端替换网页 JS」 |
| Web 端凭据持久化 | 未定 | Web 端允许连加密设备，需在前端本地（如 IndexedDB）持久化客户端静态密钥、钉住的 `device_pub` 与 `require_e2ee=true` 锁定标记；清站点数据需重新扫码 |
| 降级保护 | 服务端声明驱动 | 客户端本地持久化 `require_e2ee = true`；服务端 `mode_hint` 仅作提示，绝不因服务端改报 `normal` 而降级明文 |
| 会话列表聚合 | Server 统一返回目录 | 普通设备由控制面 `aa.v3.Control/list_sessions` 流式扇出；加密设备由客户端本地开隧道拉取并按 `contracts/aa-v3/1.0/fixtures/session-merge.json` 规则合并 |

## 3. 移动端原生（iOS / Android）接入真实协议时的预期边界

1. **会话模型不变**：继续沿用 `v3poc/protocol/timeline.ts` 与 `v3poc/protocol/services.ts`（`Session` / `Message` / `Control` / `WatchEvent`）和 `aa.render/1` WebView 桥。
2. **连接方式**：
   - 登录 / OAuth 走 FastAPI 拿账号会话并换取客户端 Router Token（`mt_`）；
   - 调用 `aa.v3.Control`（`watch_devices`、`list_sessions`、`open_tunnel`）经 MeshCall Swift / JVM SDK；
   - 单设备操作（普通与加密设备完全同一条路径）一律先 `open_tunnel` 拿到 `mtun_` 凭据，再经隧道直接调用 `aa.v3.Sessions` / `Terminals` / `Device`。
3. **测试验收标准**：四端实现多设备会话合并逻辑后，须直接接入并跑通 `contracts/aa-v3/1.0/fixtures/session-merge.json` 全部用例。
