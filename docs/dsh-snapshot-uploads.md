# DSH 快照的持久化分块上传

## 与现有主线的区别

#332 已经解决超过 8 MiB 的 HTTP 请求体限制，使用“第一页替换、后续页追加”的分页上传；后续页在同次调用内可重试。#353 将 DSH → Connector 的捕获改成 `aa.dsh.v2.Sync.ingestSnapshot` 客户端流。这两项都没有持久化尚未完成的上传位置；Connector/Server 重启后需要重新上传，且分页期间正式时间线只有部分历史。

本次保留 #353 的客户端流、Connector 的 spool 和逐条编码方式，只更换 Connector → Server 的快照传输：完整 JSON 写入临时文件，以 SHA-256 标识，同一正文按 256 KiB 分块持久化到 Server。重新捕获得到相同正文时，begin 返回已保存块号，Connector 只发送缺块；最后一次性确认并替换完整历史。每块请求独立且小于旧分页上限，不需要先发布第一页来腾出内存。

## 成功与失败

- begin、chunk、commit 端点与状态见 `contracts/connector-snapshot-upload/1.0/`。
- 分块落库才确认，完整快照提交后才返回 `Sync.ingestSnapshot.accepted`，允许 Bridge 推进 checkpoint。
- 元数据、完整时间线、完成 receipt 和暂存清理在同一数据库事务中提交。校验失败、写入失败或提交前取消时保留旧历史与已确认块。
- 最终响应丢失后，begin/commit 根据 receipt 返回已完成，不再次替换历史。事件在事务提交后发布，沿用会话 revision fence 的恢复边界。
- 使用新流请求已有的 `throughSeq`，按 Connector/runtime/session 保留版本水位，拒绝更旧上传。没有恢复旧 JSON-RPC Bridge 或增加本机协议。

Server 与 Connector 需同时升级至 2.2.0；客户端查看会话的接口不变。数据库新增 v2_45，不修改主线已有的 v2_42～v2_44。

## 保留期限与边界

暂存块及完成 receipt 保留 24 小时，begin、Server 启动及每小时清理。最高版本水位不随暂存过期删除。单份上传上限 256 MiB，每 Connector 上限 512 MiB/32 份未完成上传。

恢复仍需重新捕获并编码；只有正文完全相同才能复用已有块，历史、元数据或观察时间改变都会产生新摘要。receipt 过期后同一版本会重新传输，不承诺无限期幂等。Connector 保留临时文件编码和 Unicode 清理；Server 最终仍完整解析 JSON，不能声称端到端内存有界。未完成真实 DSH Desktop 和物理断网验证时，不能以故障注入测试替代该结论。
