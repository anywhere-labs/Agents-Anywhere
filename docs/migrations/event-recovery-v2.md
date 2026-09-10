# 事件与恢复契约

v2 的事件游标是一个持久化的会话状态版本令牌。格式是 `seq:<revision>`。它不是 Redis Pub/Sub offset，也不是持久化事件日志里的位置。

PostgreSQL 仍然是持久化事实来源。Redis 只负责在多个 Server 实例之间传递临时的失效通知，WebSocket 再把这些通知映射成协议事件。如果 Redis 消息丢了，恢复时从数据库状态补回来，而不是从 Redis 里重放。

## 恢复结果

`GET /api/v2/sessions/{sessionId}/events?after=seq:<revision>` 只会返回下面两种结果之一：

- 一个确定性的状态增量，并且 `snapshotRequired: false`。
- 没有事件，并且 `snapshotRequired: true`，客户端必须重新拉取会话快照。

恢复过程读取 session、timeline、notices 和实际 capabilities 时，需要数据库 revision 保持稳定。出现下面情况时会退回到快照：

- 客户端传入的 cursor 比持久化 session revision 更新；
- 客户端传入的 cursor 等于持久化 revision，因为临时 Connector 在线状态以及由它推导出的 capabilities 没有编码进数据库 cursor；
- 恢复过程中数据库 revision 一直在变化；
- timeline 增量超过恢复限制；
- 因为某个实体被多次更新或被删除，当前状态已经不能表达一个或多个持久化 revision。

如果 timeline replacement 删除了 item，会在 session revision 序列中留下一个持久化恢复屏障。这样既不用新增 event-log 表，也能保证客户端不会把不完整的状态投影误认为完整重放。

## WebSocket 失效通知

数据库写入完成后，才会发布 timeline 失效通知。普通 item 变化会产生 `timeline.item_created` 或 `timeline.item_updated` 事件。权威的 `timeline.sync` 会产生 `timeline.snapshot`，其中的 `items` 会替换客户端中由 Server 支撑的 timeline，同时保留本地尚未确认的 optimistic message。可能关闭或移除 Interaction 的变化会产生 `notice.snapshot`，这样过期的打开 notice 会被明确移除，而不是靠“没有 item event”来推断。

客户端必须把 `snapshotRequired` 和 revision gap 当成正确性信号。Pub/Sub 投递成功本身不能证明恢复已经完整。
