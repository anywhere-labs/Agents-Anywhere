# 设备设置

设备设置是用户为某台设备选择的行为开关，由 Server 保存，可以在任何客户端修改，再下发给设备上的 Connector。它和 `/connectors/{connectorId}/preferences` 不同：`preferences` 是 Connector 上报的本机偏好，对客户端只读，每次上报都会整体覆盖。

当前只有一项设置：

| 字段 | 类型 | 默认值 | 含义 |
| --- | --- | --- | --- |
| `confirmQuitOnShutdown` | boolean | `false` | Desktop 设备在电脑关机、重启或注销时，是否先弹窗确认再退出。`false` 时 Desktop 直接停止本机连接并退出，不阻止关机。用户在 Desktop 里手动退出（菜单、托盘、`Cmd+Q`）不受这个设置影响。 |

这项设置只对 `connectorKind` 为 `desktop` 的设备有意义。客户端只在这类设备上显示开关；Server 不按 `connectorKind` 拒绝写入，其他设备保存后不产生效果。

## 客户端接口

### 读取

```text
GET /api/v2/connectors/{connectorId}/device-settings
```

```json
{
  "connectorId": "conn_x",
  "settings": { "confirmQuitOnShutdown": false },
  "delivered": null,
  "serverTime": "2026-11-09T08:00:00Z"
}
```

`settings` 总是包含全部字段；从未保存过的字段返回默认值。读取时 `delivered` 为 `null`。

### 修改

```text
PATCH /api/v2/connectors/{connectorId}/device-settings
```

```json
{ "confirmQuitOnShutdown": true }
```

请求体只包含要修改的字段，省略的字段保持不变；未知字段返回 422。响应和读取相同，其中 `delivered` 表示这次修改是否已经交给在线的 Connector：

- `true`：设备在线，Connector 已确认收到，立即生效。
- `false`：设备离线，或设备上的 Connector 版本不支持；Server 已保存，设备下次连上时生效。客户端可以据此提示「设备上线后生效」。

设备不存在或不属于当前用户时返回 404。

## Server 与 Connector

Server 在两个时机调用 Connector 的 `connector.deviceSettings.apply`：

1. Connector 的 WebSocket 连接就绪后，下发一次当前设置。
2. 客户端修改设置且设备在线时。

```json
{ "method": "connector.deviceSettings.apply", "params": { "settings": { "confirmQuitOnShutdown": false } } }
```

Connector 返回 `{"applied": true}`。旧版 Connector 不认识这个方法时返回错误，Server 只记录日志，不影响连接。

## Connector 与 Desktop

Connector 把收到的设置放进本机控制通道 `aa.local.v2.Control` 的状态（见[本机 Connector 记录](../../contracts/local-machine/2.0/README.md)）：`getState` 和 `events` 的 `state` 增加 `deviceSettings` 字段，Connector 本次运行还没收到下发时为 `null`。

Desktop 收到后保存到本机设置文件，所以离线或 Connector 未连上时，仍按最后一次收到的值处理关机；从未收到过时按默认值 `false` 处理。
