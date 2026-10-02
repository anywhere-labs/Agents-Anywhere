# DSH 大历史上传的 Connector 内存

Bridge 原来已在超过 8 MiB 时把页面写入 spool，但上传时仍将整个 spool 读回列表，再生成完整 JSON 字符串和 bytes，导致大历史重新占用多份内存。

现在提交时逐页读取，逐条编码到临时 JSON 文件，再以 64 KiB 块发送既有 `/connector/ingest` 请求。实例绑定、turn 字段过滤和完整快照的提交语义保持不变。认证重试从文件开头重读；成功、失败和取消都关闭临时文件。

这是 Connector 内部优化，Connector PATCH 版本为 2.1.1。没有新增 Server API、数据库表或分块续传协议。断开连接后仍会重传整个 HTTP 请求；已提交历史的位置仍由既有 checkpoint 保存。

自动化验证 512 条 Unicode 消息合成超过 32 MiB 的正文：逐条生成输入的编码与哈希阶段 Python 分配峰值低于 2 MiB。该测量不包含原生投影、Bridge 页缓存和 item ID 去重集合，也不是操作系统 RSS。

同规模约 32.2 MiB spool 的独立 Python 3.12 进程对比中，提交阶段 Python 分配峰值由约 75.5 MiB 降到 8.4 MiB，进程峰值 RSS 由约 151 MiB 降到 92.7 MiB。实际 Relay 仍会加载一页，包含最初最多 8 MiB 的缓存页。该合成样本不代表所有生产历史；Server 仍完整解析 JSON，不能据此宣称端到端内存有界。
