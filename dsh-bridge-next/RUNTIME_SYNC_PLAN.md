# DSH 过滤、事件同步与文本发送

2026-09-07。用户已确认实施，目标 DSH 0.1.2-rc.1。

**最新约束：后端不新增接口、逻辑、表或迁移。** 本文替代先前涉及后端扩展的方案。已撤回原先的同步代次、事务 checkpoint、项目写入与投影物理删除扩展。

## 分工

- 插件 `host/dsh-runtime`：官方侧栏过滤、原生事件、历史和实时 Timeline 投影、工作区事实、官方 Agent 文本发送。
- Connector `runtimes/dsh`：发现/鉴权、标准 DTO 转发、快照分页拼接、有序交付和重连。
- 后端：只复用现有 `/api/v2/connector/ingest`，继续使用 `timeline.sync` 完整替换及 `timeline.itemUpsert` 增量更新。
- 其他 Runtime 保留原有 scanner；登录、onboarding 和 Desktop 页面不属于本轮修改范围。

## 首次同步

1. 先订阅官方事件并建立有界缓冲，再枚举会话。
2. 使用官方 `sessionVisible` 规则：排除 subagent 和归档；空会话仅当前选中者可见。blank 依据有无 turn/start，current 来自官方客户端；headless 无当前选择。多客户端采用可见集合并集。
3. 只对有效会话读取完整历史，捕获末尾 seq，使用与实时消息相同的投影器。
4. 插件以同一捕获分页发送。Connector 收齐所有页、验证 ID 和总数后，一次提交 `session.meta.upsert` 和 `timeline.sync {complete: true}`，不逐页替换。
5. 重放大于基线 seq 的缓冲事件。首次同步允许读取正在运行的会话。
6. 使用既有 session.inventory.begin/complete 校准可见清单，再进入实时消费。

## 正常运行

- session/created、turn/start：先判断是否可见，新可见会话建立基线。
- session/event：真实用户消息、assistant 文本/reasoning、工具调用及结果，归并为稳定 ID 的 timeline.itemUpsert。文本片段约 50ms 合并，最终消息及时冲刷。
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

## 现有后端的边界

从未导入的过滤会话直接忽略，不发送占位 metadata、source 或 Timeline。已导入后才被归档的会话，用现有 session.source.updated 标记 hidden；完整清单处理离线期间遗漏。已有数据库行按原实现保留，**本轮不实现物理删除**。仍可见会话的完整替换会清掉旧 notice。

插件可取得官方工作区 id/title/path/sessionIds，以 workspace.list 返回并随事件更新 Connector 本地快照。后端继续按会话 cwd 归入项目。现有 Connector 通知不能写入原生项目名称，**本轮不承诺 DSH 项目改名自动修改 AA 项目名称**，不为此新增接口或借用插件 OAuth 凭据。

## 文本发送

通过既有 session.createAndStart、session.startTurn、session.interrupt：复用活跃 Agent，冷会话用官方 agents.resume 恢复，新会话使用 agents.create 并关联工作区。保持原模型/preset，新会话使用官方默认模型；没有默认模型则明确报错。

稳定 clientMessageId 映射为原生 user message ID，检查 inbox 和历史后去重。运行中发送交给官方 followup。插件仅释放自己创建/恢复的 handle。附件、模型/权限目录、审批应答后续单独实现；工具审批继续在 DSH 官方界面处理。

## 验证与运行

官方 SDK headless 组合覆盖：基线期间事件、过滤、归档/工作区、文本新建续聊、冷历史恢复、中断、幂等重试。Connector 验证分页完整性、有序转发、instance 绑定及 scanner 跳过。跨语言测试使用临时 DSH_HOME、临时 SQLite 和原有后端 ASGI app，验证 1000+ 历史、流式消息、回复丢失后校准和旧 notice 清理。

插件目录使用 yarn typecheck / yarn build / yarn check:build / yarn test；Connector 定向测试使用 uv run pytest。linked 插件重新构建后，用户重新加载 DSH Host 和现有 Python Connector 进程。真实模型、Windows 实机及长时间运行另行验收，不自动重启开发服务。
