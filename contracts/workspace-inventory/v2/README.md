# 原生项目快照 v2（接口 2.2）

来源由已认证 Connector 和已登记 Runtime 实例绑定。Server 发放连接代次 epoch；每个来源在代次内使用递增 sequence。snapshotId 标识一次可重试的应用，observedAt 为 UTC 时间。

`runtime.workspaces.updated` 参数：runtime、runtimeId、version=2、epoch、sequence、snapshotId、observedAt、catalogComplete、membersComplete、workspaces、members、directories。

- workspaces：id、title、path、roots、identityKind（native/directory）。同名同目录允许不同原生身份。
- members：sessionId（外部身份）、projectId（null 明确无归属）、cwd。字段缺失不能代替 null。
- directories：path、state（present/missing/unknown）；仅工作设备观察，unknown 保留最后有效状态。
- catalogComplete/membersComplete 为 false 时，对应集合必须为空且不覆盖已确认状态。完整空集合具有解除意义。首次切换要求两个范围均完整。目录观察是逐路径结果，不观察的路径不推断缺失。
- 无一致性原生快照时，破坏性差异需定向确认或第二次一致完整读取。收齐分页、校验上限后发送；任何失败不发送伪空清单。
- Server 拒绝旧代次、旧序号和相同序号不同内容；当前快照保存待应用进度，完成清理。重复内容只更新核对时间。

项目存在性和名称来自原生；AA 仅保存置顶等偏好。会话同时保存原生观察和有效展示归属，目录缺失不丢弃原生观察。旧版归属写入不能接管已升级来源。

大快照使用 `runtime.workspaces.chunk`：runtime、runtimeId、epoch、sequence、snapshotId、digest（完整 JSON UTF-8 字节 SHA-256）、index（从 0 开始）、count、data（该片 Base64）。每片原始字节最多 512 KiB，最多 256 片。身份与校验必须一致；收齐前只保存临时分片，不修改有效事实或最近成功核对时间。应用与通知成功后清理进度。

机器可读 Schema：`inventory.schema.json`、`chunk.schema.json`。范围完整性、跨集合引用及分片摘要还需执行服务端语义验证。

采集失败可发 `runtime.workspaces.unavailable`（runtime、runtimeId、epoch），只标记来源暂不可用，保留当前事实、会话归属及最近成功核对时间；下一次有效快照恢复状态。
