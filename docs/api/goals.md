# 统一目标模式

Codex、Claude Code 使用相同的 Goal API、状态和界面规则。自动续跑和完成评估由原生 Runtime 执行；Server 负责持久化、并发准入和状态发布，Connector 负责原生适配、日志投影及恢复。

## 使用

- 输入 `/goal` 进入目标输入模式，随后填写目标；也可以直接发送 `/goal <目标正文>`。新建会话随首轮携带目标意图。
- 输入区上方显示单行目标栏，可编辑、暂停、恢复或清除。替换已有目标和恢复目标需要确认；操作成功后才清空原草稿。
- 普通跟进消息保留当前目标。停止执行时先持久化暂停意图、暂停原生目标，再中断当前执行；无法确认暂停时仍尝试中断，并报告结果待核对。
- 完成后收起目标栏，完成摘要留在对应 Timeline 历史位置；清理原生目标不会覆盖已经保存的完成结果。
- 目标状态与执行状态分别显示。`active` 表示目标仍有效，不表示 Agent 此刻必然正在运行。离线快照只供查看。

所有入口根据有效 `session.goal` 能力和当前动作显示。Codex 外部 owner 会话没有目标控制能力时只读；旧 Connector 不声明此能力。DSH 不参与本次统一适配。

## HTTP 与事件

| 接口 | 作用 |
| --- | --- |
| `GET /api/v2/sessions/{id}/goal` | 完整目标状态；读取不会启动模型 |
| `POST /api/v2/sessions/{id}/goal` | 设置、编辑、暂停、恢复、清除 |
| `GET /api/v2/sessions/{id}/goal/operations/{operationId}` | 查询原操作回执，只对账，不重发 |

设置示例：

```json
{"operationId":"stable-client-operation-id","expectedRevision":0,"action":"set","objective":"完成目标并提供验证证据","attachments":[]}
```

`action` 为 `set | edit | pause | resume | clear`。设置和编辑接受正文及已上传附件引用，其他动作不接受正文或附件。新建会话在已有 create-and-start 请求里携带 `goalIntent: {mode: "goal", operationId}`；该身份与 `clientMessageId` 一致。创建身份、原生会话指针和回执复用 `runtime_workflows`，同一身份不分配第二个会话。

`GoalState` 包含 `revision`、`goal`、`lastOutcome`、`freshness`、`capabilities.actions`，以及绑定代次、来源 epoch 和来源修订号。`pendingOperationId` 用于客户端重开页面后继续查询未知回执。当前目标状态为 `active | paused | blocked | usageLimited | budgetLimited`；结束结果为 `complete | failed | cleared | replaced`。编辑、暂停、恢复保留目标 ID，替换分配新 ID。计量中的耗时、评估轮次、token 和预算都是可选值，缺少原生数据时不填造数值。

回执包含 `operationId`、`ok`、`outcome`、可选 `code/message/state`。`outcome` 为 `applied | pending | rejected | unknown`；HTTP 200 不等于操作成功。同操作身份同请求返回原回执，异内容冲突；旧修订和未决写操作阻止新的冲突写入。结果未知时保留草稿，轮询回执，不重新设置或恢复目标。

Connector RPC 为 `session.goal.get / execute / operation`，完整投影通过 `session.goal.updated` 持久化 ingest。Server 对外发布 `goal.state.updated` 和历史标记，事件保持稳定身份及原会话序号。显式删除通知 `session.goal.forget` 清理本地目标数据并保留防复活标记。

## 原生适配

Codex 使用 `thread/goal/get`、`thread/goal/set`、`thread/goal/clear`，原生通知唤醒投影，定期读取用于断线对账。启动时探测 API 是否实际可用，不单凭 provider 名称开放操作。原生目标的后台回合注册到既有消息订阅，回复、推理和工具调用继续使用普通 Timeline。原生完成先于最后一轮回复时，等待该回合结束后记录完成摘要，再清除原生目标。

Claude 通过 SDK 发送原生 `/goal`、`/goal clear`，读取其原生 JSONL 中结构化的 `goal_status` 附件。不会把普通成功回复当成目标接受。日志游标记录文件身份、完整行位置、UUID 去重和父分支锚点；分支切换不会继承被放弃分支上的目标，未知日志格式关闭控制。暂停先保存 AA 意图，再中断并清除原生目标；恢复或编辑重新设置，保留 AA 目标 ID 和已有累计耗时，新执行段的评估轮次按原生数据展示。重启时先对账暂停意图，再执行重连维护；发现不同的新原生目标时以新目标为准。

附件沿用上传授权，只保存引用；Connector 在私有目录物化文件，原生目标保留文件路径，暂停恢复和编辑不会静默丢弃已有文件引用。

## 数据库与升级

本次新增 Alembic `v2_47`，schema version 为 `2.47`，产品版本不变。迁移只新增表、约束和索引，不回填旧会话。

| PostgreSQL 表 | 责任 |
| --- | --- |
| `session_goals` | 每个目标一行的生命周期历史，复合主键及每会话最多一个未结束目标的部分唯一索引 |
| `session_goal_state` | 当前/最近结束目标引用、Server 修订号、绑定代次和来源水位；目标引用使用会话内复合外键 |
| `goal_operations` | 请求 fingerprint、操作阶段、幂等回执；未知操作保留，不盲目重试 |
| `goal_event_outbox` | 与状态、历史标记同事务写入；租约领取、至少一次发布，重试不重新分配序号 |

接受写入时锁定会话行，校验所有权、绑定和修订号，保存操作后提交；网络调用在事务外。确认或原生更新在同一事务更新生命周期、快照、回执、历史和 outbox。普通进程重启沿用来源 epoch；新谱系需要当前绑定的完整读取对账，旧绑定、旧谱系、乱序和冲突的同修订数据不能覆盖新状态。

Connector 在各 Runtime 实例目录保存 `goal.sqlite3`，包含 `goal_state / goal_operations / goal_log_cursors / goal_outbox`。启用外键、WAL、FULL 同步和 busy timeout，写入使用 `BEGIN IMMEDIATE`，快照、回执、游标、outbox 原子提交，收到 Server 持久 ACK 才删除待投递记录。文件限制为当前用户访问，SQLite `user_version` 管理格式，不写原生数据库或 JSONL。

归档保留历史并关闭操作；删除会话级联删除四张 Server 表。目标历史、回执随会话保留；已发布 outbox 保留七天，未发布记录持续保留。升级顺序为 Server 数据库及服务、Connector、客户端。常规应用回滚保留新增表；数据库 downgrade 会删除 Goal 数据，不作为保留历史的回滚方式。

## 实施验证记录

使用独立工作树、名字含 `test` 的一次性 PostgreSQL 数据库和隔离 Runtime 数据目录运行完整链路：Web → Server → Connector → 原生 Runtime → Timeline。原有开发 Connector 保持运行，未迁移生产数据库、未修改产品版本或 `tests/` 文件。

两种 Runtime 均使用实际模型执行以下目标，目标要求每轮只完成一个阶段并结束本轮，由原生目标机制续跑：

1. 终端读取 README 并回复 `AA_NATIVE_ROUND_1`。
2. 下一轮终端输出并回复 `AA_NATIVE_ROUND_2`。
3. 第三轮终端输出并回复 `AA_NATIVE_ROUND_3`，此时才允许目标完成。

Codex 与 Claude Code 均得到三条阶段最终回复和三次终端调用。Codex 原生日志记录三个不同回合，Claude 原生目标记录三次迭代；两者最终目标为空、历史结果为完成。浏览器中可查看三轮回复并展开真实命令、输出，完成摘要位于最终回复之后。验收期间发现的 Codex 原生后台回合未订阅问题已修复。

独立功能探针还实际验证了 PostgreSQL 并发操作准入、相同身份重试、fingerprint 冲突、旧事件和 epoch 拒绝、完成结果保留、outbox 身份及删除级联；SQLite 快照、操作、游标和 outbox 回滚原子性、日志截断与分支回退、重启回执恢复；在目标设置等待原生 I/O 时停止，未下发的设置取消、已接受的目标暂停，均无重放或死锁。空数据库迁移、从 `v2_46` 升级和降级后再次升级已通过；Claude 禁用 hooks 的原生拒绝探针已通过。

进程退出探针在原生调用前后强制终止子进程，分别核对未知回执保留与已接受目标确认，均未重新执行；PostgreSQL 在状态事务提交前退出时生命周期记录回滚，提交后退出时快照和 outbox 保留。发布租约过期后仍投递同一事件 ID 和会话序号；本地收到 Server 接收确认前退出，重启后仍保留原 outbox 身份。
