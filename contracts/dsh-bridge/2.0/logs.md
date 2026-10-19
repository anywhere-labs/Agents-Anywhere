# Connector 运行日志服务

`aa.local.v2.Logs` 是 Bridge 与 Connector 运行日志的唯一写入、持久化及读取入口。
Desktop 自身、安装引导与启动失败的诊断仍使用各自的日志，不属于此服务。

- `write(entries)`：Bridge 批量提交结构化记录（最多 64 条），每条含 producer/eventId；文件同步到磁盘后才确认。source 固定为 bridge，重发在保留窗口内去重。
- `read(source?, beforeSeq?, afterSeq?, limit=200)`：按全局 seq 返回升序页面。默认最近一页，afterSeq 从游标之后最早一页开始。返回首尾序号、总数及前后是否还有记录。
- `tail(since?, source?)`：先从持久存储补读再跟随；序号跨 Connector 重启、清空保持递增。落后于保留窗口时首条记录标记 gapBefore。
- `clear()`：仅 host 可调用，清除全部运行日志；不会重置序号。

Bridge key 只能 write/read/tail，不能 clear 或配置存储。客户端不能指定文件路径、写入来源或保留策略。
Connector 在用户目录 `.agents-anywhere/logs/` 中按段轮换的 JSONL 文件保存数据，默认最多 10000 条、32 MiB 记录载荷、7 天（按接收时间）；每次写入和读取均按段裁剪（因此实际保留量可小于上限）。目录/文件限制权限，跨进程文件锁串行化共享存储，批量追加后 fsync 才确认；重启时恢复序号和去重索引，尾部不完整批次会截断。已被保留策略删除的记录不保证去重。
Bridge 断线期间仅暂存最多 512 条待确认记录，重连重发；溢出在恢复后提交丢弃计数。Connector 离线期间若 Bridge 退出，未确认记录可能丢失，不作持久确认承诺。磁盘写失败会拒绝 write。

旧插件和 Desktop 的运行日志文件保留在原位置，不自动导入中央存储。集中记录从升级后开始；Desktop 和插件的启动诊断仍可通过各自原有入口读取。

运行 logger 在进程入口注入；RPC 处理使用 MeshCall 调用作用域依赖和带 service/method/callId 的 logger。日志服务的访问日志不进入日志存储，防止递归。
