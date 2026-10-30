# 统一原生 Plan

Web、Desktop、Android 和 iOS 使用相同的规划规则，Codex、Claude Code、DSH 负责各自的原生适配。模式切换、计划正文、用户审阅和实施进度分别记录。

## 使用方式

| 输入或操作 | 行为 |
| --- | --- |
| 已有会话输入 `/plan` | 请求进入原生规划，不发送空模型任务 |
| 新建会话输入 `/plan` | 只设置本地创建意图，显示「新会话将使用计划模式」；随后发送任务时才创建会话 |
| `/plan <任务>` | 保留任务后缀与换行，启用原生规划后提交一次任务 |
| `/plan off` | 退出规划；有待答的原生审阅时先结束等待，不代表批准计划 |
| 同意并执行 | 批准当前所读的不可变版本，再请求实施；使用当前权限策略 |
| 修改计划 → 提交修改意见 | 将意见交给原生 Runtime，继续规划，下一份终稿重新审阅 |
| 暂不执行 | 结束当前审阅等待，保留正文，不开始实施 |
| 打开计划 | 在阅读器查看指定版本，支持复制、Markdown 导出和恢复阅读位置 |

命令名区分大小写，只匹配完整的 `/plan` token。`/planner` 不匹配；精确参数 `off` 才是退出，`/plan off 修复登录` 和 `/plan on` 都按规划任务处理。任务分隔符之后的正文保持原样；不会把保留命令降级为普通模型消息。附件随任务提交，单独的模式切换不接受附件。

计划输出使用专用卡片，正文根据真实原生增量更新。生成时标题显示动态效果；定稿、中断、离屏、后台和减少动态效果设置会停止动画。完整终稿保存到 Server 后才允许审阅。草稿不能批准，执行步骤进度也不能代替计划正文。

计划定稿后，当前待审阅请求以内嵌确认面板呈现在输入区，提供「同意并执行」「修改计划」「暂不执行」；「修改计划」展开意见输入后再「提交修改意见」。不自动弹出模态窗口、不抢焦点。计划卡片只预览正文（过长时可展开全文）并提供「打开计划」，复制与下载在阅读器中完成；执行确认统一在输入区完成。确认期间保留已有输入草稿与附件，审阅结束后恢复普通输入区；其他设备回应或计划版本变化时，面板随当前原生状态更新，旧版本动作失效。Web/Desktop 的「打开计划」使用可与聊天并排的独立侧栏，窄屏切换到全文阅读视图；移动端保留全文阅读页，审批同样在会话输入区完成。

领域与协议只定义计划、审阅身份及决定，不规定弹窗或页面结构；确认面板和阅读布局属于各客户端展示层。

## 领域与分层

- Connector `planning/domain`：会话规划聚合、模式、草稿、不可变版本、审阅身份与正文哈希；仅依赖标准库。
- Connector `planning/application`：模式切换、任务提交、审阅、原生校准、操作去重与部分成功处理；依赖声明的原生和存储端口。
- Connector `planning/infrastructure`：每个 Runtime 实例的 SQLite 操作日志、正文 outbox，以及既有回合启动能力的复用。
- `runtimes/{codex,claude,dsh}/planning.py`：原生防腐层，将 SDK、IPC、Bridge 控制和事件转换为统一事实；不另建 Agent loop。
- Server `core/planning` 定义 wire models；`services/planning` 经端口编排；`infra/repositories/planning.py` 保存 PostgreSQL 历史；`api/session_planning.py` 负责鉴权和 HTTP 映射。
- 四端消费相同契约与能力，不按 provider 名称选择审批规则。协议 schema 由 Server models 导出，Web/Desktop 类型由 schema 生成。

## 原生映射

| Runtime | 模式控制 | 计划与审阅 |
| --- | --- | --- |
| Codex | 实验 app-server `thread/settings/update`，后续 `turn/start` 保留 collaboration mode；外部 owner 沿既有 IPC 路由 | Plan item/delta；completed 正文作为权威终稿。AA 提供续跑确认，批准后使用普通协作模式提交指定正文 |
| Claude Code | SDK `permission_mode=plan` / `set_permission_mode` 控制响应 | Write 的原生计划文件增量与 ExitPlanMode；审批前冻结补充回调中的完整正文，或读取已确认且受限于原生 plans 目录的文件 |
| DSH | 已组合的原生 `planMode.get/set`，区分当前模式与下一步待生效选择 | `exit_plan_mode` 工具参数流与 `plan-review` intent；使用原生问题选项身份回应，批准在下一步退出规划 |

Codex 不支持的运行中切换明确拒绝；外部 writer 被占用且 owner 无法控制时，绝不退回 SDK 争锁。Codex `turn/plan/updated` 只属于执行步骤。

Claude 的规划意图与显式工具权限选择分开保存，批准恢复用户最近选择的执行权限。原生 `planFilePath` 只在 Connector 内使用；批准前再次核对可读文件与所审正文，审批后原生实际正文发生变化时停止继续实施并保存外部版本。

DSH 必须组合原生 Plan 插件；缺少服务的旧 composition 返回明确不可用。已演练 `@deepseek-ai/dsh-plan-mode@0.2.0-rc.2`。该版本取消审阅会产生工具错误，因此 AA 的「暂不执行」使用原生回合取消结束等待，避免额外模型步骤。普通 AskUserQuestion 与工具权限审批保留原有流程。

## HTTP API

所有路径均在 `/api/v2` 下，需要当前账号拥有该会话。写操作还需有效接管与原生能力；审阅另校验 `session.plan_review`。`session.planning` 控制模式，`session.plan_document` 声明文档能力。离线历史读取不依赖原生能力。

- `GET /sessions/{id}/planning`：向 Runtime 校准；不可达时返回已保存正文，状态为 `stale`，禁用审阅动作。
- `POST /sessions/{id}/planning`：发送 `PlanningRequest`，接收 `PlanningResponse`。
- `GET /sessions/{id}/planning/operations/{operationId}`：读取操作回执；结果未知时只查询 Connector 日志，不重新派发。
- `GET /sessions/{id}/plans`：列出完整历史版本。
- `GET /sessions/{id}/plans/{planId}/{revision}`：读取不可变版本。
- 同一版本路径加 `/markdown`：下载原始 UTF-8 Markdown。

命令为 `enter_plan`、`exit_plan`、`submit_task`、`approve_and_execute`、`request_revision`、`dismiss_review`。新建任务在既有 create-and-start 请求中携带 `planningIntent: {mode: "plan", operationId}`，不能先普通发送再切换。Server 保存创建身份，重复请求不会创建第二个会话。

首轮规划的创建准入向所选 Runtime 实例读取当前能力，并校验实例身份；不依赖旧 Connector 级能力缓存。原生不可达、超时或返回无效能力时明确拒绝，不创建第二条任务。

每个写操作有稳定 `operationId`。同身份同请求读取原回执，异内容冲突。审阅必须携带 `reviewId`、`planId`、`planRevision`、`contentHash`、`epoch`；可选 `expectedRevision`。正文版本变化、控制实例变化或原生交互过期时拒绝批准。两个设备同时回应时只派发一个有效决定。

`outcome` 是 `applied | pending | rejected | unknown`。响应另记录 `execution`，区分任务接受、实施开始和已拒绝；HTTP 200 不能代替业务 `ok`。模式成功但任务失败会保留模式事实；批准成功但实施明确未派发时可以只重试启动阶段。结果未知时禁用自动重发，使用回执查询和原生校准。

## 事件与持久化

原生入口为 `session.planning.get`、`session.planning.execute`、`session.planning.operation`。Connector 发布 `session.planning.updated` 完整投影，Server 映射为 `planning.state.updated`。草稿最多每 80 ms 合并发送一次，不逐 token 写 PostgreSQL；终稿通过同步 ingest 收到持久 ACK 后才可批准。

终稿按原生完整正文替换草稿，不 trim 或转换换行；SHA-256 基于严格 UTF-8 字节，最多 2 MiB。原生 thread/call/request 引用留在 Connector。SQLite outbox 在传输失败后保留每个版本；Server 的不可变正文不受 Connector 离线、重启或原生文件清理影响。重启后历史不制造新的待答交互，必须向当前原生状态重新校准。

Server 新增数据库迁移 `v2_45`，保存当前投影、不可变文档、操作回执与创建身份。本次未修改产品版本；启用该功能应配套使用本次 Server、Connector 与客户端代码，DSH 同时更新 Bridge 并组合原生 Plan 插件。缺少有效能力的端只保留既有功能，不会假装开启 Plan。
