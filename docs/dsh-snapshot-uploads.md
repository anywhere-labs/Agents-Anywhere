# DSH 大历史上传的 Connector 内存

Bridge 原来已在超过 8 MiB 时把页面写入 spool，但上传时仍将整个 spool 读回列表，再生成完整 JSON 字符串和 bytes，导致大历史重新占用多份内存。

现在提交时逐页读取，逐条编码到临时 JSON 文件，再以 64 KiB 块发送既有 `/connector/ingest` 请求。实例绑定、turn 字段过滤和完整快照的提交语义保持不变。认证重试从文件开头重读；成功、失败和取消都关闭临时文件。

这是 Connector 内部优化，Connector PATCH 版本为 2.1.1。没有新增 Server API、数据库表或分块续传协议。断开连接后仍会重传整个 HTTP 请求；已提交历史的位置仍由既有 checkpoint 保存。

自动化验证 512 条 Unicode 消息合成超过 32 MiB 的正文：逐条生成输入的编码与哈希阶段 Python 分配峰值低于 2 MiB。该测量不包含原生投影、Bridge 页缓存和 item ID 去重集合，也不是操作系统 RSS。

同规模约 32.2 MiB spool 的独立 Python 3.12 进程对比中，提交阶段 Python 分配峰值由约 75.5 MiB 降到 8.4 MiB，进程峰值 RSS 由约 151 MiB 降到 92.7 MiB。实际 Relay 仍会加载一页，包含最初最多 8 MiB 的缓存页。该合成样本不代表所有生产历史；Server 仍完整解析 JSON，不能据此宣称端到端内存有界。

## 分页上传

完整快照编码后超过 8 MiB（`SNAPSHOT_PAGE_BYTES`）时，Connector 按条目边界把它切成若干页，每页是一个独立的 `/connector/ingest` 请求体：第一页带 `session.meta.upsert` 并以 `complete: true` 整体替换时间线，之后各页以 `complete: false` 追加剩余条目。Server 不需要知道分页：条目按 `orderSeq` 升序到达，而 Server 对比已有最大值更大的新条目原样保留它的 `orderSeq`，所以逐页追加得到的时间线和单请求一样；被撤回的条目在第一页替换时就已清掉。8 MiB 以内的快照仍是一个请求，行为不变。

这个"事务"不是原子的：第一页被接受到最后一页落库之间，Server 上该会话只有前面的部分。Connector 尽量缩短这个窗口——全部页先编码到本地临时文件再开始发送、各页在同一连接上连续发出、第二页起的瞬时失败（网络、5xx、408/429）只重试当前页（最多 3 次、0.5 秒起退避），后面的页不重发，永远不再发第一页（它会删掉已追加的条目）；第一页失败和单请求快照一样立即失败，走原来的重订阅路径——那时 Server 上什么都还没替换。重试用尽时抛出网络错误，走原来的重订阅路径重新捕获；4xx 或 `rejected` 立即失败，按会话隔离。快照提交的返回（2.2.0 起为 `aa.dsh.v2.Sync.ingestSnapshot` 的返回值）与检查点仍只在最后一页被接受后才产生。

代理的请求体上限只需 ≥ 8 MiB。
