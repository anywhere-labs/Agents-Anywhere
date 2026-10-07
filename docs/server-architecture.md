# Server 架构

v2 Server 采用显式的传输、服务、领域、仓库端口与基础设施分层。本轮重构在把依赖
关系向领域层收拢的同时保持行为稳定。

## 分层

| 层 | 职责 | 可以依赖 |
| --- | --- | --- |
| `agent_server/core` | 领域值、与 API 无关的模型、校验、认证原语 | Python 标准库与其他 `core` 模块 |
| `agent_server/services` | 用例编排、应用错误、仓库与 RPC 端口 | `core`、显式声明的端口、过渡期的运行时适配器 |
| `agent_server/infra` | PostgreSQL 仓库、Redis 协调、文件、WebSocket RPC、broker | `core`、服务端口 |
| `agent_server/api` | FastAPI 路由、认证依赖、HTTP/WebSocket 错误映射 | `core`、services、infra 组装 |
| `agent_server/app.py` | 进程组装与生命周期 | 所有层 |

`core` 不得导入外层。services 不得导入 FastAPI、API 模块或具体的 `Store`
facade。这些规则由 `tests/test_architecture_boundaries.py` 强制检查。

## 状态所有权

| 状态 | 属主 | 持久化 |
| --- | --- | --- |
| 用户、连接器、会话、通知/交互、Timeline、目录、运行时配置 | PostgreSQL | 持久化，Alembic 版本化 |
| Connector 属主租约、跨实例 RPC 路由、失效 Pub/Sub、分布式锁、短生命周期 ticket 与传输协调 | Redis | 可重建的协调状态，保留时带有限 TTL |
| 已接受但未刷写的 Timeline upsert 与实时 Timeline sequence head | Redis | 运维级持久：AOF `everysec`、持久 `/data` 卷、noeviction；无 TTL |
| 本地 WebSocket、待完成的 RPC future、发送锁、监听任务 | Server 进程 | 仅进程生命周期 |
| 附件与上传文件 | 配置的文件后端 | 按后端策略持久化 |

连接器在线状态从实时在线端口推导。SQL 记录持久的连接器元数据（如
`last_seen_at` 与 `device_os`），但不是当前实例属主的事实来源。协调状态在重启后
可以从活跃连接重建。

当写缓冲把一条 Timeline upsert 刷入 PostgreSQL 后，它才成为持久事实来源。在那
之前，分布式的 Server 实例把已接受的 upsert 与实时 sequence head 保留在 Redis。
Redis 的 sequence 值来自从 PostgreSQL 持久租借的 revision 区间，因此 Redis 丢失
只会废弃未使用的值，不会导致 sequence 复用。Compose 开启 `appendfsync everysec`
的 AOF、持久化 `/data`、设置 `noeviction`，因为这些待写/序列器 key 没有 TTL。
这只是一个运维上的持久化窗口，不是第二个权威 Timeline 数据库：最近一次 AOF 同步
之前的故障可能丢失一条未刷写的 upsert；一致性敏感/手动读取会先加围栏，把待写
内容刷入 PostgreSQL。租约大小默认 `4096`，可用
`AGENT_SERVER_TIMELINE_REVISION_LEASE_SIZE` 配置。

这个设计有两个不同的丢失窗口。分布式部署下，AOF `everysec` 可能丢失 Redis 已
确认但尚未 fsync 的最新命令。无 Redis 的单进程回退下，已接受但未刷写的 Timeline
payload 只存在于进程内存，进程崩溃会丢失自上次刷写以来的全部 payload（通常是
最多一个配置的刷写间隔）。PostgreSQL 的分配高水位可以防止这两种故障复用
revision，但无法找回在数据库刷写之前丢失的 payload；因此本地回退是开发模式，不
是持久化的 HA 设计。

Redis 的安全与容量边界包括 `INFO server`：Server 的 ACL 必须允许该命令，序列器
才能读取 `run_id` 并检测 Redis 重启或故障转移。当前实现中每次 Timeline upsert
都会读取 `run_id`，一次已接受的变更在分配 revision 后还会复查。因此 Redis ACL
验证与预期的 `INFO` 命令吞吐是高频 ingest 上线的必要条件。

## Connector 流程

1. Connector 使用 PostgreSQL 中的持久凭据完成认证。
2. 接受连接的 Server 实例通过 RPC 管理器认领 Connector 租约。分布式部署下
   Redis 会拒绝第二个活跃属主。
3. SQL 记录连接元数据，但不存储租约属主。
4. 面向其他实例的请求经 Redis Pub/Sub 路由到租约属主。
5. 心跳续租。断开或超时释放租约。
6. API 响应合并持久的连接器数据与实时在线状态。

## 数据库版本

Alembic revision 使用产品 schema 版本号（`v2_0`、`v2_1`、`v2_2`、`v2_3`、
`v2_4` 等），与包的 SemVer 无关。每个 schema 变更新增一个 revision。Alembic 会
按顺序应用所有中间 revision，因此一条命令可以让数据库跨多个版本升级。

运行时启动要求数据库已经处于精确的当前 revision。只有显式的迁移命令才会修改
schema。revision `v2_3` 在交互通知成为权威之后移除归档的 v1 列与过渡期的
Approval 表。

### v2.24 写入兼容性

`v2.24` 的 revision 时钟模型与 `v2.23` 及更早版本不兼容写入。上线必须先停止所有
旧 Server 与外部写入进程，迁移数据库，然后只启动 `v2.24` 的写入进程。迁移的
advisory lock 用于协调并发迁移者；它不是应用写入围栏，不能让滚动混合版本部署
变得安全。

在 PostgreSQL 上，这次迁移把相关 sequence 列从 `int4` 改为 `int8`。类型变更可能
需要强锁，并依据 PostgreSQL 版本与物理表/索引布局重写存储。生产上线必须先在有
代表性的数据上演练，测量锁时长、耗时与剩余空间影响，再选择维护窗口。

降级是离线操作：评估前置条件与执行 schema 变更期间所有写入进程必须保持停止。
只要存在某个会话的分配区间超前于持久 sequence（`seq_allocated_high <> seq`），
或某个值放不进有符号 32 位存储，降级就会拒绝。由于普通的 `v2.24` 分配租约可能在
整个区间消费完之前就使第一个条件成立，新写入进程处理过 Timeline 流量后，降级
通常将不可用。
