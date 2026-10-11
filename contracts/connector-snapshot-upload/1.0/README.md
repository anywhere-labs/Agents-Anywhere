# Connector 快照上传 1.0

最低 Server/Connector 产品版本 2.2.0。只处理 DSH 完整快照；现有 ingest 通知语义和客户端接口不变。

- `POST /api/v2/connector/ingest/uploads`：Bearer Connector 认证；manifest 为 `uploadId`（完整 JSON 正文 SHA-256）、`sessionId`、`runtimeId`、`throughSeq`、`totalBytes`。返回 `chunkBytes=262144`、已持久化 `receivedChunks`、`committed`。同一 manifest 重试可恢复，响应丢失也可以重新查询。
- `PUT /api/v2/connector/ingest/uploads/{uploadId}/chunks/{index}`：application/octet-stream，块大小固定（最后一块除外）。持久化后才返回成功。重复相同块幂等，不同正文返回 409。不可访问其他 Connector 的上传。
- `POST /api/v2/connector/ingest/uploads/{uploadId}/commit`：必须收到所有块，全文摘要和 manifest 必须匹配。仅允许绑定同一 DSH runtime/session 的 `session.meta.upsert` + `timeline.sync complete=true`。先校验整份元数据与所有历史条目，再在一个数据库事务中更新会话、替换完整历史、保存完成 receipt 并删除暂存块；事务提交后才发布事件。保留既有会话身份解析、用户标题及归档规则。重复 commit 不重写历史；Connector 随后才允许 checkpoint/ACK。

正文校验失败返回 400，正式会话和历史不变。事务写入失败或提交前取消时，以上写入全部回滚，上传保持 pending、已确认分块保留，可以重试。数据库已经提交而事件发布失败或成功回复丢失时，完成 receipt 仍有效；重新 begin/commit 返回 committed，不重新上传或再次替换历史。事件发布沿用现有会话 revision fence 的恢复机制。

暂存和完成 receipt 保留 24 小时；开始上传时清理过期记录，Server 启动及之后每小时也清理一次，不依赖客户端再次上传。删除上传记录时级联删除其分块；未到期上传不受影响。单份 256 MiB、每 Connector 暂存总量 512 MiB 且最多 32 份。新快照取代同一 runtime/session 的未完成上传；每个 Connector/runtime/session 的最高 throughSeq 单独持久化，不随暂存过期删除；更低 throughSeq 被拒绝，过期清理和 Server 重启后也不能回退。Connector 删除时级联清除该版本记录。begin/chunk/commit 和凭据变更通过既有跨进程 Connector lifecycle guard 串行化。旧上传返回 409，过期/未知上传返回 404，单块/暂存配额超限返回 413，manifest 非法或超范围返回 422。

稳定正文从内部页面逐条编码到临时文件。重连后重新捕获和编码得到同一摘要，即可跳过已确认块；本机未缓存此前的整个 HTTP 响应或持久临时文件。若历史内容改变，使用新的 manifest，不能复用旧块。分块完成不等于完整历史已发布。
