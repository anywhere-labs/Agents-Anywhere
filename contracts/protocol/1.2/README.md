# 平台协议 1.2

在 1.1 上只做加法，供 v3 使用；旧客户端忽略新字段不会出错。生成：`PYTHONPATH=server server/.venv/bin/python server/scripts/export_v3_contracts.py`。

- `SessionView.displayDevice`（设备写）、`displayUser`（客户端写）：展示信封。普通模式为明文 JSON；加密模式为密文，此时旧字段 `title`、`cwd` 为 null。
- `SessionView.planState`、`goalState`：只含状态的枚举，设备离线时仍可显示。
- 快照 `historySource`（`live` / `unavailable`）与 `deviceOffline`；时间线分页、事件恢复也带 `deviceOffline`。设备离线时读接口返回 200 + `deviceOffline: true`，命令返回 409 `connector_offline`。
- 新事件 `session.catchup_required`：设备链路重连后，客户端用自己的游标调 `/events` 补齐。
- 新增 `timeline-response` schema（1.1 未导出）。
- `protocolVersion` 枚举加入 `1.2`。
