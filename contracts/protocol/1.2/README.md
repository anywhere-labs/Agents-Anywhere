# 平台协议 1.2

在 1.1 上只做加法，供 v3 使用；旧客户端忽略新字段不会出错。生成：`PYTHONPATH=server server/.venv/bin/python server/scripts/export_v3_contracts.py`。

- `SessionView.displayDevice`（设备写）、`displayUser`（客户端写）：展示信封。普通模式为明文 JSON；加密模式为密文，此时旧字段 `title`、`cwd` 为 null。
- `SessionView.planState`、`goalState`：只含状态的枚举，设备离线时仍可显示。
- 快照 `historySource`（`live` / `unavailable`）与 `deviceOffline`；时间线分页、事件恢复、运行中队列（`session-queue-state`）也带 `deviceOffline`。设备离线时读接口返回 200 + `deviceOffline: true`，命令返回 409 `connector_offline`。
- 新事件 `session.catchup_required`：设备链路重连后，客户端用自己的游标调 `/events` 补齐。
- 时间线条目 `blobRefs`：设备把过大的字段（长输出、内联图片等）移到本机的 blob 存储，条目在 `path`（指向 `content` 的 JSON Pointer）处只留预览或说明。`text/*` 是该处字符串的完整 UTF-8 文本；其他类型是从媒体块移走的 `data`/`blob`，或被替换掉的 `data:` URL。没有移走字段的条目不带这个字段。
- 新路由 `GET /api/v2/sessions/{id}/blobs/{blobRef}?offset=…&length=…`（`session-blob-chunk`）：由设备应答，普通模式经 Server 转发，加密模式经安全通道；`blobRef` 是本会话条目的 `blobRefs[].blobId`，或设备上已有的本会话附件 `fileId`，其他一律 404 `blob_not_found`。`length` 最多 4 MiB（`SESSION_BLOB_CHUNK_MAX_BYTES`），从 `offset + 本次长度` 继续读到 `eof`。
- 用户消息的 `content.attachments`（`{fileId, name, mediaType, size?, sha256?}`）对所有 Runtime 都由设备记录。
- 新增 `timeline-response` schema（1.1 未导出）。
- `protocolVersion` 枚举加入 `1.2`。
