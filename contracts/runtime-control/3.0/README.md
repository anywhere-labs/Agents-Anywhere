# Runtime Control 3.0

方法与载荷的语义沿用 `contracts/runtime-control/2.1`（schema 与 fixtures 以 2.1 为准，`switchRevision` 语义不变）。3.0 只改变承载方式：

| 2.1 | 3.0 |
| --- | --- |
| Server 经 v2 Connector WS 发 RPC | 只读方法走 MeshCall unary（`aa.device.v1.Runtime/*`）；改变状态的方法（`runtime.start/stop/apply`、`runtime.validateConfig`、渠道切换等）走 `aa.device.v1.Commands/*`，带持久回执（`contracts/device-meshcall/1.0`） |
| 设备离线时请求失败 | 期望状态（实例、设备设置、渠道切换）在 `LinkWelcome.desired` 里下发，设备上线后对账 |

一律不协商版本：Server 与 Connector 同一个大版本发布。
