# AA v3 跨端契约（1.0）

本目录是 Agents Anywhere v3 新架构的跨端契约与共用测试样例，对应已定稿的设计文档：

- 总体架构（控制面、隧道、聚合 RPC 与 MCP）：[docs/v3/architecture-proposal.md](../../../docs/v3/architecture-proposal.md)
- 加密设备准入与端到端加密：[docs/v3/e2ee-admission-proposal.md](../../../docs/v3/e2ee-admission-proposal.md)
- 与 `v3poc` 客户端的对齐说明：[docs/v3/v3poc-alignment.md](../../../docs/v3/v3poc-alignment.md)

## 文件地图

| 文件 | 用途 |
| --- | --- |
| `manifest.json` | 契约版本、服务列表、MeshCall 上游能力基线与校验清单 |
| `control.schema.json` | 控制面 `aa.v3.Control` 与设备管理面 `aa.v3.DeviceAdmin` 的请求/响应/流式模型 |
| `pairing.schema.json` | 加密设备二维码配对载荷（`aa-pair://v1/...`）、客户端本地信任记录、绿锁/灰锁分级与错误码 |
| `fixtures/session-merge.json` | 跨端共用的「控制面扇出 + 加密设备客户端扇出」会话合并规则与测试样例 |
| `validate.py` | 零外部依赖的自检脚本：校验 JSON Schema 结构并用参考算法验证全部合并 fixtures |

## 服务划分

| 服务 | 注册方 | 面向调用方 | 普通模式 | 加密模式 |
| --- | --- | --- | --- | --- |
| `aa.v3.Control` | 控制面（Server） | 客户端、Connector（`presence`） | 通过 Router 调用（`mt_` Token 带 `meshcall-token-principal`） | 同左；不存会话、不触密文 |
| `aa.v3.DeviceAdmin` | Connector（`targeted: true`） | 控制面账号 | 接受 `ping`、`close_tunnel_sessions`、`check_update`、`rename` | 同左（服务端唯一可直接调用的服务） |
| `aa.v3.Sessions` | Connector（`targeted: true`） | 客户端隧道；普通模式下亦接受控制面聚合/MCP 定向调用 | 普通隧道 + 控制面定向调用 | 仅接受已完成 `Noise_IK`/`IKpsk2` 双向认证的 E2E 会话 |
| `aa.v3.Terminals` | Connector（`targeted: true`） | 客户端隧道 | 普通隧道 | 仅接受已认证 E2E 会话 |
| `aa.v3.Device` | Connector（`targeted: true`） | 客户端隧道 | 普通隧道 | 仅接受已认证 E2E 会话 |

`aa.v3.Sessions` 的会话数据模型（`Session`、`Message`、`Control`、`WatchEvent`、`SessionSummary`）沿用 `v3poc/protocol/timeline.ts` 与 `v3poc/protocol/services.ts`（与 Effi Cloud `cloud.v1.Conversations` 同形，snake_case）。

## 多设备会话合并规则（所有客户端必须一致）

Web / Desktop（TypeScript）、iOS（Swift）、Android（Kotlin）在合并控制面 `aa.v3.Control/list_sessions`（普通设备）与客户端本地隧道 `aa.v3.Sessions/list`（加密设备）的结果时，必须严格遵守以下规则并通过 `fixtures/session-merge.json` 全部用例：

1. **按设备整体替换**：收到某台设备的 `status = "ok"` 结果时，用该结果的 `value.sessions` 与 `value.projects` 整体替换这台设备之前的所有会话和项目（删除已不存在的旧条目），并将该设备状态置为 `ok`。
2. **控制面加密占位不覆盖本地加密结果**：控制面流里对加密设备返回 `status = "encrypted"` 仅表示「请客户端自行经加密隧道拉取」。如果客户端本地已为这台设备拿到 `ok`、已缓存数据或本地错误（如 `e2e_not_paired`），控制面的 `status = "encrypted"` 不得清空或覆盖客户端侧状态。
3. **非 `ok` 状态保留只读缓存**：当设备返回 `offline`、`timeout` 或 `error` 时，保留该设备此前缓存的会话与项目并标为只读离线/错误状态（`stale = true`），不影响其他在线设备的列表。
4. **未配对/握手失败不回退明文**：本地记录为 `require_e2ee = true` 的设备如果握手失败、公钥不匹配或未配对，必须显式暴露对应错误并阻止发起普通连接，绝不消费服务端返回的任何明文会话。
5. **全局排序规则**：合并后的会话列表按以下键严格排序：
   - 置顶优先：`pinned === true` 排在 `pinned === false` 之前；
   - 更新时间倒序：`updated_at`（RFC 3339 时间戳）较新的在前；
   - 稳定破平：时间相同时，按 `device_id` 升序，再按 `id` 升序（ASCII 字典序）。

## 校验命令

```bash
python3 contracts/aa-v3/1.0/validate.py
```
