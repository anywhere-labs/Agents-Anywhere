# 原生状态驱动的项目同步（2.2.0）

DSH、Codex、Claude Code 提供当前项目与成员事实，工作设备观察目录，Server 保存历史并计算 AA 展示归属。同步传递路径和关联信息，不上传目录中的代码文件。

## 身份与保存内容

项目唯一键为 `connector_id + runtime_id + native_project_id`。名称和设备内目录允许重复；客户端显示来源、实例、目录和原生身份。项目的名称、根目录、存在性由原生决定，置顶和会话的用户归档仍由 AA 管理。

| 新增存储 | 用途 |
| --- | --- |
| `projects.runtime/runtime_id/native_project_id` | 原生来源绑定、唯一性、创建对话路由 |
| `projects.identity_kind` | 区分原生登记、Claude 目录身份与迁移前的历史记录 |
| `projects.roots_json/source_state` | 多根目录有效性、当前列表与来源状态 |
| `sessions.native_project_id` | 保留当前原生观察，目录恢复时按当前成员关系恢复 |
| `sessions.project_sync_reason` | 未分组及目录未知原因；独立于会话日志来源状态 |
| `connectors.workspace_epoch` | 拒绝旧连接上传的状态 |
| `project_operations` | 按用户请求 ID 保存原生创建回执、参数、状态及时间，避免超时重试重复创建 |

最近成功核对时间直接来自 `runtime_workspace_inventories.observed_at`，没有另加项目观察时间列。快照保存当前工作区、成员、目录观察及原生到 AA 映射；不累计 `trackedSessionIds`、删除名单或托管名称名单。分片与应用、通知进度仅在未完成期间保留，通知成功后清理。当前目录观察为 unknown 时，同时保留上次确认的目录事实。

## 归属与异常

- 原生项目消失、明确无成员关系、所有根目录确认 missing，或会话实际 cwd 确认 missing：会话进入未分组；历史、附件、用户归档保留。
- 目录恢复后使用当前原生身份和成员关系；同路径新建的另一个原生项目不会自动带回旧会话。
- 目录权限、超时、I/O 或已观察卷设备消失为 unknown，保留有效结果。首次观察到常见挂载路径缺失也保持 unknown。
- 原生项目消失后对应 AA 记录保留为 historical，退出当前列表。有效空项目正常展示。
- 普通会话导入不再按 cwd 创建项目。首次完整核对前冻结已有旧归属，新导入会话保持未分组。
- 项目清单成功、成员失败可以更新已确认的项目状态，不能将失败成员集合当成完整空集合。首次切换需要项目和成员都完整。

## 协议与调度

契约见 [workspace-inventory/v2](../../contracts/workspace-inventory/v2/README.md)。连接代次由 Server 验证当前 WebSocket 后签发，来源必须属于已认证设备上的已配置 Runtime 实例。每个来源串行采集，sequence 在连接代次内递增。

| 触发 | 默认行为 |
| --- | --- |
| 首次连接、重连、Runtime 启动 | 立即完整核对 |
| 创建项目或对话、手动刷新、原生事件 | 进入同一队列，事件合并 300ms，持续事件最长 1s |
| 项目清单、已知目录 | 每轮完成后等待 30s |
| 完整成员 | 300s；事件可提前触发 |
| 失败 | 1、2、5、10、30s 退避，加抖动，最高 30s |

配置文件为 `workspaceSyncEnabled`、`workspaceIntervalSeconds`、`workspaceMembersIntervalSeconds`，对应环境变量 `AGENT_CONNECTOR_WORKSPACE_SYNC`、`AGENT_CONNECTOR_WORKSPACE_INTERVAL_SECONDS`、`AGENT_CONNECTOR_WORKSPACE_MEMBERS_INTERVAL_SECONDS`。独立于历史正文同步开关及上传队列。周期是扫描调度间隔，不保证端到端延迟。

目录去重后最多 8 个并发元数据读取；明确不存在短延迟复查。超时后保留尚未退出的同一路径读取任务，不重复创建阻塞线程。日志只记录来源、扫描耗时、数量、未知目录数与错误类型，不记录正文或凭据。

所有原生分页收齐后才能形成完整范围。大快照按 512 KiB 分片，Server 收齐并校验 SHA-256 后才应用；不完整、超限、非法数据保留最后结果。同内容只更新核对时间，已完成且已通知的重复快照不写会话。会话更新保留 revision fence，分批最多 8 个并发；部分失败可重试。通知发送成功后才清理进度。

## 各 Runtime

- **DSH**：Registry ID、名称、路径和成员；事件通知加独立周期校准，轻量核对不重建历史 feed。创建使用 Registry 创建或复用目录工作区，会话明确附加所选身份。无一致性 token 的成员读取进行二次核对。
- **Codex**：实验协议 `project/list`、完整活跃及归档 `thread/list`；`projectId:null` 与字段缺失严格区分。项目和成员双读确认，保留当前结果至确认。`project/create` 传幂等键，`thread/start` 直接传原生 projectId，绕过会丢弃实验字段的高层 SDK。AA 新建线程在列表索引追上前定向回读。已确认元数据供历史来源核对复用，历史发现仍按原生交互来源过滤。
- **Claude Code**：AA 适配层枚举主会话元数据，覆盖最近 100 条以外的历史；按实际 cwd 建目录型身份，工作树分别归类。轻量轮次复用未变化文件的元数据，完整轮次重读候选；前后目录集合与文件签名必须一致。异常或损坏候选不作为空集合。只为成员识别读取有限元数据，不因此扩大正文导入范围。没有虚假的空项目登记，通过首次原生对话形成项目。

## 创建与主动操作

`POST /api/v2/projects` 请求：`name, connectorId, workspacePath, runtime, runtimeId, requestId`。`workspacePath` 必须是绝对路径；非法路径在执行来源写入前返回 422。缺少 Runtime 或请求 ID 返回 426 升级要求；离线不可创建，Claude 空项目创建返回 `first_session_required`。

响应含 `operationId`、`status`（pending/succeeded/failed/unknown）、`project`（同步前可空）、`nativeProjectId`、`roots`、`syncState`。同一 requestId 不得换参数；超时保留未知结果，不再次盲目创建。用 `GET /api/v2/projects/operations/{operationId}` 核实回执。原生成功但 AA 投影尚未出现时为已创建、正在同步。

`POST /api/v2/projects/refresh?connectorId=...&runtime=...&runtimeId=...` 按来源进入统一调度队列。项目改名和修改目录入口移除；PATCH 仅保留置顶，原生项目 DELETE 被拒绝。批量归档只更新 AA 会话状态，不删除原生项目或物理目录。

## 迁移与回退

未升级来源冻结已有归属，不恢复旧 cwd 自动写入。升级应配套 Server、Connector、DSH 插件及四端 2.2.0。回退需要应用与数据库配套恢复，旧唯一约束无法表达已产生的同名、同目录项目。

## 评审修复后的边界

- 删除或清除 Runtime 配置时，同一事务退役该来源的项目并清除快照及分片进度。列表同时检查来源仍已配置，防止历史遗留孤儿记录继续显示。
- `sourceAvailability` 单独表示来源可读性，`rootStates` 给出逐根目录状态；`sourceState` 保留兼容性的聚合显示状态。有一个已确认正常根目录即可为 active；创建会话必须校验所选根目录为 present，其他根目录 unknown 不阻断。未传 cwd 时选择一个已确认正常的根目录。
- 工作区快照必须独立成批上传。HTTP 在设备生命周期锁内只完成准入，随后按 Runtime 来源串行应用和通知；每个数据库阶段重新校验来源与连接代次，删除配置与阶段写入用数据库设备行锁互斥。同步仍保留已有持久应用/通知进度；客户端超时不等于取消或应用成功。
- Codex 实例发布 `runtime.project.create` / `runtime.project.sync` 能力；未探测、协议不支持、暂时不可用分别表达，类型级默认不宣称项目能力。协议不支持时停止周期重试，显式刷新或重启实例可重新探测。
- 创建操作保存在账号所属服务端，`GET /projects/operations` 返回尚待核对的操作及原始参数。相同参数重新提交会恢复尚未确定的旧操作，即使页面重开产生新 requestId，也不直接执行第二次创建。明确再次新建须传 `newOperation: true`；旧 requestId 仍保持幂等。各端可从操作列表继续核对，不依赖页面内存保存回执。

创建成功且项目投影就绪后，各端调用 `POST /projects/operations/{operationId}/ack` 确认已拿到结果。确认前，即使项目已经出现在列表，操作也继续保留在恢复入口；丢失成功回包不能触发重复创建。ACK 丢失时只会再次提供同一回执。服务端保留确认标志，迟到的原生成功回执不会清掉它。

当前同步隔离使用按来源的分布式锁及分阶段数据库校验，HTTP 仍等待本轮应用和通知完成；没有引入新的后台任务队列表。已存在的持久应用/通知进度继续承担重试恢复。工作区批次不能混入正文或其他 Runtime 的通知。
