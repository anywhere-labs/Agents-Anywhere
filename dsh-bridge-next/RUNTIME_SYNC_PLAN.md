# DSH 过滤、事件同步与文本发送

2026-09-07。用户已确认实施，目标 DSH 0.1.2-rc.1。

当前范围包括 DSH → AA 项目名称、项目归属和归档状态同步。复用现有 ingest 路径，新增项目清单处理及 `v2_33` 数据库迁移；不增加独立同步服务，也不改变 Timeline 存储协议。

## 分工

- 插件 `host/dsh-runtime`：官方侧栏过滤、原生事件、历史和实时 Timeline 投影、工作区事实、官方 Agent 文本发送。
- Connector `runtimes/dsh`：发现/鉴权、标准 DTO 转发、快照分页拼接、有序交付和重连。
- 后端：通过 `/api/v2/connector/ingest` 接收完整 `workspace.inventory`，在事务中校准项目与归属；继续使用 `timeline.sync` 完整替换及 `timeline.itemUpsert` 增量更新。
- 其他 Runtime 保留原有 scanner；登录、onboarding 和 Desktop 页面不属于本轮修改范围。

## 首次同步

1. 先订阅官方事件并建立有界缓冲，再枚举会话；在会话快照之前提交官方完整项目清单，包含空项目和归档会话的项目归属。
2. 使用官方 `sessionVisible` 规则：排除 subagent 和归档；空会话仅当前选中者可见。blank 依据有无 turn/start，current 来自官方客户端；headless 无当前选择。多客户端采用可见集合并集。
3. 只对有效会话读取完整历史，捕获末尾 seq，使用与实时消息相同的投影器。
4. 插件以同一捕获分页发送。Connector 收齐所有页、验证 ID 和总数后，一次提交 `session.meta.upsert` 和 `timeline.sync {complete: true}`，不逐页替换。
5. 重放大于基线 seq 的缓冲事件。首次同步允许读取正在运行的会话。
6. 使用既有 session.inventory.begin/complete 校准来源状态，再进入实时消费。归档清单包含尚未恢复到内存的会话；空会话隐藏与归档分别表示为 unavailable 和 archived。

## 正常运行

- session/created、turn/start：先判断是否可见，新可见会话建立基线。
- session/event：真实用户消息、assistant 文本/reasoning、工具调用及结果，归并为稳定 ID 的 timeline.itemUpsert。原生事件按约 34ms（最多每秒 30 次）集中投影，同一条目只推送窗口内最新版本；工具结果、状态和轮次结束通知按顺序合入批次。最终消息在下一次 flush 送出，不依赖后续事件触发。
- 插件实际传输批次也遵守 34ms 最小间隔，包括快照分页；保留大小限制和逐批 ACK，慢连接不会积累无界待发送帧。Desktop 前端另按 34ms 窗口集中提交状态，同一条目的连续更新合并，快照和控制事件保持顺序边界。
- session/title：使用 session.meta.upsert 同步标题，不生成消息。
- agent/status、轮次和审批变化：使用 session.state.updated；新的 turn/end 使用 session.turnEnded。
- workspace 的 domain/changed、客户端 current：核对归档与可见性变化。
- session/disposed：退出内存不等于删除，仍检查官方持久化状态。
- 最终消息撤销草稿时，只校准对应会话的完整历史，复用全量替换删除失效项。

历史与实时统一过滤 approval/policy、inbox、环境/技能/系统注入、标题生成请求、设置命令流水及未知内部 notice。它们不会重新包装进 metadata。保留业务消息、reasoning、工具、结构化历史授权和压缩信息。轮次用于插件内部归并，后端接收状态/结束通知，不保存 turn.start/end 条目。

## 稳定 ID 与交付

- 平台会话 ID 按原生会话与 runtime instance namespace 确定；平台新建会话使用可逆原生 ID，保持平台已有会话 ID。
- 用户消息按原生消息 ID；assistant 按原生 turn/step 起始 seq 和内容块位置；工具按 callId。历史与实时重用同一算法，流片段更新同一条目。
- 投影器从完整原生日志按首次出现顺序分配 orderSeq，不因片段更新改变位置，保持兼容后端现有 INTEGER 列。
- streamId/batchSeq 只控制插件与 Connector 的顺序。每次等待一个批次确认；快照页确认表示已暂存，commit/增量确认表示现有 ingest 接受。**不增加数据库事务 ACK 或 exactly-once 承诺。**
- Connector 使用可等待的 ingest_notifications，不进入出错后丢弃通知的后台 flush 队列。

## 断线补偿

- HTTP 失败、部分拒绝或确认结果不明：关闭当前订阅，恢复连接后重新读取完整历史校准，不盲目重发旧结束通知。
- Connector 到 Server 的连接恢复：重新订阅事件 Runtime；插件端点断开：重新发现和鉴权。
- 原生 seq 缺口、缓存回收或手动刷新：只重读对应会话。
- 事件缓冲、帧大小和闲置投影都有上限；超限关闭流并校准，不静默丢数据。
- 正常空闲时不枚举或重读历史；客户端 current 续租和连接退避不属于 scanner。

## 项目校准

官方 `workspaceRegistry.list()` 提供稳定 id、title、canonical path、sessionIds；`domain/changed` 提供持久化后的修改通知。插件等待实体缓存更新后发送完整清单，不猜测不存在的专用 rename/delete 事件。项目身份为 `(connectorId, runtimeId, nativeWorkspaceId)`，标题不是身份键。服务端优先复用同设备、同规范路径的 AA 项目，保留项目 ID、置顶和历史。

同名检查覆盖同一用户的所有项目，排除自身，依次添加中文 `（1）`、`（2）`。持久化原始标题和分配后的名称；相同标题重启不重新抢占更小序号。显式 sessionIds 优先，未分组会话按规范 CWD 归类。标题变更更新已有映射；项目删除清理映射，并重新按 CWD 分类。仍有会话的项目保留并恢复目录名；仅由 DSH 同步创建、没有会话且未被用户保留/置顶的空项目可删除。完整清单校验失败时整笔回滚。

AA 的项目改名、会话移动及归档操作不会反向修改 DSH。下一次 DSH 项目事件或启动校准仍以 DSH 名称和归属为准。`hasNativeWorkspace` 让 Web/Desktop 显示仍存在于 DSH 的空项目，保留 AA 手动创建项目原有语义。

## 归档和详情检查

归档只依据官方 `workspaceRegistry.archivedSessionIds`，使用 `session.source.updated {availability: archived}`，不再与通用不可见状态合并。首次完整清单补齐离线期间的归档；尚未导入的隐藏/归档会话不创建占位历史。

进入详情的 `session.getState` 会即时调用官方 `sessionQuery.listSessions()` 并读取归档集合；该查询合并 live/persisted，会话不在内存中不等于归档。Connector 等待来源事实进入服务端后才返回状态，详情重新读取数据库。DSH 状态读取失败时详情返回可重试错误，不回退成可继续发送的旧状态。每次发送前再次读取来源，初始化 Agent 后再校验归档，返回既有 `session_archived` 错误和 sourceState。

Web/Desktop 复用现有 Codex 来源状态弹窗，按 runtime 显示 DeepSeek Harness 名称。源端归档只导入一次；`source_archive_latched` 保留明确归档状态，避免短暂 missing/unknown 后重新覆盖 AA 用户的取消归档选择。DSH 恢复可见不自动取消 AA 自己的归档。

## 文本发送

通过既有 session.createAndStart、session.startTurn、session.interrupt：复用活跃 Agent，冷会话用官方 agents.resume 恢复，新会话使用 agents.create 并关联工作区。保持原模型/preset，新会话使用官方默认模型；没有默认模型则明确报错。

稳定 clientMessageId 映射为原生 user message ID，检查 inbox 和历史后去重。运行中发送交给官方 followup。插件仅释放自己创建/恢复的 handle。附件、模型/权限目录、审批应答后续单独实现；工具审批继续在 DSH 官方界面处理。

## 验证与运行

官方 SDK headless 组合覆盖：基线期间事件、项目改名/删除、离线归档、详情和发送前检查、文本新建续聊、冷历史恢复、中断、幂等重试。Connector 验证分页完整性、有序转发、instance 绑定及 scanner 跳过。跨语言测试使用临时 DSH_HOME、临时 SQLite 和后端 ASGI app，验证 1000+ 历史、流式消息、回复丢失后校准、改名/归档/删除的真实落库、单向边界和历史保留。

插件目录使用 yarn typecheck / yarn build / yarn check:build / yarn test；Connector 定向测试使用 uv run pytest。linked 插件重新构建后，用户重新加载 DSH Host 和现有 Python Connector 进程。真实模型、Windows 实机及长时间运行另行验收，不自动重启开发服务。
