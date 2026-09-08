# DSH 过滤、事件同步与文本发送

2026-09-08：DSH 已回退到图片功能之前，继续验证自动会话同步和数据回传。目标 DSH 0.1.2-rc.1。

**最新约束：后端不新增接口、逻辑、表或迁移。** 本文替代先前涉及后端扩展的方案。已撤回原先的同步代次、事务 checkpoint、项目写入与投影物理删除扩展。

## 分工

- 插件 `host/dsh-runtime`：首条真实用户消息过滤、原生事件、历史和实时 Timeline 投影、明确归档状态、官方 Agent 文本发送。
- Connector `runtimes/dsh`：发现/鉴权、标准 DTO 转发、快照分页拼接、有序交付和重连。
- 后端：只复用现有 `/api/v2/connector/ingest`，继续使用 `timeline.sync` 完整替换及 `timeline.itemUpsert` 增量更新。
- 其他 Runtime 保留原有 scanner；登录、onboarding 和 Desktop 页面不属于本轮修改范围。

## 首次同步

1. 先订阅官方事件并建立有界缓冲，再枚举会话。
2. 排除 subagent 和归档；只有历史中存在 `user/message` 且 `source.kind === 'user'` 才同步。空会话即使当前被选中也不导入；`turn/start`、系统/插件注入不算用户消息，用户发送的纯附件消息计入。启动、实时事件和重连使用同一条件，headless 不依赖客户端选择。
3. 只对有效会话读取完整历史，捕获末尾 seq，使用与实时消息相同的投影器。
4. 插件以同一捕获分页发送。Connector 收齐所有页、验证 ID 和总数后，一次提交 `session.meta.upsert` 和 `timeline.sync {complete: true}`，不逐页替换。
5. 重放大于基线 seq 的缓冲事件。首次同步允许读取正在运行的会话。
6. 使用既有 session.inventory.begin/complete 校准来源清单，再进入实时消费；官方归档集合中的会话明确标记 archived，空会话不可见使用 unavailable，不把列表缺失猜成归档。

## 正常运行

- session/created：只记录候选及已有消息，不导入空草稿。session/event 中首次出现真实用户消息后建立基线，将会话和首条消息一并同步，无需等待模型回复；恢复的已有会话按其完整历史判断。
- 只缓存“已有真实用户消息”的正向事实，避免旧的空会话判断遮住后来的首条消息。清单扫描保留扫描期间新收到的会话记录，短暂加载后离开内存的会话仍可从官方持久化历史建立基线。
- session/event：真实用户消息、assistant 文本/reasoning、工具调用及结果，归并为稳定 ID 的 timeline.itemUpsert。原生事件按约 34ms（最多每秒 30 次）集中投影，同一条目只推送窗口内最新版本；工具结果、状态和轮次结束通知按顺序合入批次。最终消息在下一次 flush 送出，不依赖后续事件触发。
- 插件实际传输批次也遵守 34ms 最小间隔，包括快照分页；保留大小限制和逐批 ACK，慢连接不会积累无界待发送帧。Desktop 前端另按 34ms 窗口集中提交状态，同一条目的连续更新合并，快照和控制事件保持顺序边界。
- session/title：使用 session.meta.upsert 同步标题，不生成消息。
- agent/status、轮次和审批变化：使用 session.state.updated；新的 turn/end 使用 session.turnEnded。
- workspace 的 domain/changed：核对明确归档状态；客户端 current 上报不改变会话的同步资格。
- session/disposed：退出内存不等于删除，仍检查官方持久化状态。
- 最终消息撤销草稿时，只校准对应会话的完整历史，复用全量替换删除失效项。

历史与实时统一过滤 approval/policy、inbox、环境/技能/系统注入、标题生成请求、设置命令流水及未知内部 notice。它们不会重新包装进 metadata。保留业务消息、reasoning、工具、结构化历史授权和压缩信息。轮次用于插件内部归并，后端接收状态/结束通知，不保存 turn.start/end 条目。

## 稳定 ID 与交付

- 平台会话 ID 按原生会话与 runtime instance namespace 确定；平台新建会话使用可逆原生 ID，保持平台已有会话 ID。
- 用户消息按原生消息 ID；assistant 按原生 turn/step 起始 seq 和内容块位置；工具按 callId。历史与实时重用同一算法，流片段更新同一条目。
- 投影器从完整原生日志按首次出现顺序分配 orderSeq，不因片段更新改变位置，保持兼容后端现有 INTEGER 列。
- streamId/batchSeq 只控制插件与 Connector 的顺序。每次等待一个批次确认；快照页确认表示已暂存，快照 commit 和完整清单等待现有 HTTP ingest 完成，实时增量确认表示 Host 发布方法已返回。**不增加数据库事务 ACK 或 exactly-once 承诺。**
- 实时增量与 Codex/Claude 共用 typed Host 发布方法，由 Host 处理 instance 绑定、合并、WebSocket 发送和 HTTP 后台队列回退；完整快照与清单通过可等待的 `publish_runtime_notifications` 进入 HTTP ingest。重连后用完整历史校准。

## 断线补偿

- HTTP 失败、部分拒绝或确认结果不明：关闭当前订阅，恢复连接后重新读取完整历史校准，不盲目重发旧结束通知。
- Connector 到 Server 的连接恢复：重新订阅事件 Runtime；插件端点断开：重新发现和鉴权。
- 原生 seq 缺口、缓存回收或手动刷新：只重读对应会话。
- 事件缓冲、帧大小和闲置投影都有上限；超限关闭流并校准，不静默丢数据。
- 正常空闲时不枚举或重读历史；客户端 current 续租和连接退避不属于 scanner。

## 现有后端的边界

从未导入的过滤会话不发送占位 metadata、Timeline 或独立的 session.source.updated（现有接口也可能借此创建会话）。插件收到已导入会话的明确归档事实后，通过现有 session.source.updated 发送 archived，让后端沿用原有归档处理；完整清单携带同样的明确状态，只校准后端已有记录。不增加归档锁存字段，也不新增针对 AA 取消归档的保护逻辑。已有数据库行按原实现保留，**本轮不实现物理删除**。仍可见会话的完整替换会清掉旧 notice。

不实现 DSH 项目名称、归属、重命名或删除同步。插件只送会话及其 cwd，后端和其他 Agent 一样，按 cwd 归入项目、取最后一段作为项目名。既有 workspace.list 只读查询保留；插件不再发送 workspace.inventory，Connector 忽略旧插件发来的该类批次，不保存项目快照，也不转交后端。

进入详情和发送前，插件即时读取官方会话清单和明确归档集合；归档会话返回 blocked / session_archived。Connector 把来源事实写入现有通知接口后返回状态，Web 和 Desktop 复用原有来源不可用弹窗，显示 DeepSeek Harness 文案。

## 文本发送

通过既有 session.createAndStart、session.startTurn、session.interrupt：复用活跃 Agent，冷会话用官方 agents.resume 恢复，新会话使用 agents.create 并关联工作区。保持原模型/preset，新会话使用官方默认模型；没有默认模型则明确报错。

稳定 clientMessageId 映射为原生 user message ID，检查 inbox 和历史后去重。运行中发送交给官方 followup。插件仅释放自己创建/恢复的 handle。附件、模型/权限目录、审批应答后续单独实现；工具审批继续在 DSH 官方界面处理。

## 验证与运行

官方 SDK headless 组合覆盖：基线期间事件、过滤、明确归档、文本新建续聊、冷历史恢复、中断、幂等重试。Connector 验证分页完整性、有序转发、instance 绑定及 scanner 跳过。跨语言测试使用临时 DSH_HOME、临时 SQLite 和原有后端 ASGI app，验证 CWD 分类、DSH 项目变化不影响 AA、归档事件和详情检查、1000+ 历史、流式消息、回复丢失后校准和旧 notice 清理。

测试传输层把已被后端接受的请求与客户端取消分离，关闭测试 carrier 时等待这些请求结束，再释放数据库。这模拟独立 HTTP 服务的生命周期，避免测试断线直接取消后端事务；不改变生产数据库或 Connector 的重连策略。检查命令与完整验收范围见 [验证记录](./VERIFICATION.md)。

插件目录使用 yarn typecheck / yarn build / yarn check:build / yarn test；Connector 定向测试使用 uv run pytest。linked 插件重新构建后，用户重新加载 DSH Host 和现有 Python Connector 进程。真实模型、Windows 实机及长时间运行另行验收，不自动重启开发服务。
