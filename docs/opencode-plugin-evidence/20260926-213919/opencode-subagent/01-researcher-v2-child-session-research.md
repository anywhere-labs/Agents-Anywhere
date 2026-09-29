<!-- tm_board_write · 2026-09-26T19:36:20.801Z · role=researcher · session=20260926-213919 -->
# OpenCode V2 子会话（child session）机制调研

> 只读调研。环境：opencode-cli 2.0.18；@opencode-ai/sdk@1.18.24 / @opencode-ai/plugin@1.18.24（本机 ~/.config/opencode/node_modules）。未改仓库、未扰 PID 9016。P0/P1 实测结论引自 .git/opencode-team/20260926-213919/opencode-p0|opencode-research。

## 0. 一句话结论

OpenCode V2 里**子会话就是普通 Session + 可选 `parentID`**（agent=subagent 的 `task` 工具派生），这是一个**独立会话**语义；而 AA/DSH 现有模型把"子会话"表达为**父会话内的 `agent_call` 工具项**（DSH 甚至把 subagent 从会话列表剔除）。两者不对齐，且**子会话的审批归属会落到未认领的设备**（当前 fail-closed）。

## 1. 父子会话如何表达

| 维度 | 事实 | 来源 | 置信度 |
|---|---|---|---|
| 会话模型字段 | `Session.parentID?: string`（可选） | sdk v2 `dist/v2/gen/types.gen.d.ts:71` | High（官方类型） |
| V2 信息体 | `SessionV2Info.parentID?: string`、`agent?: string` | types.gen.d.ts:3181-3186 | High |
| 服务端 ctx 读 parent | `ctx.session.get({sessionID})` 存在；**`ctx.session.context({sessionID})` 只返回 message 数组 {id,time,text,type}，不含 parent** | research doc 02:41,49 实测 | Medium |
| ctx.session 无 children/list | 实测域 = create get switchAgent switchModel prompt generate command synthetic interrupt update move wait context | research doc 02:41,65 | Medium |
| CLI/TUI 数据层 | `api.state.session.{get,messages,status,permission,todo,diff,count}`；`get(sessionID)` 返回 `Session`（带 parentID） | plugin `dist/tui.d.ts:301-309`；research doc 02:202 | Medium-High |
| **无 root/family/hierarchy** | 本机安装的 tui.d.ts **不含**这些成员；research doc 02:202 明确纠正先前"hierarchy"假设 | tui.d.ts 全文 / doc 02 | Medium-High |
| 反查子会话 | HTTP `GET /session/{sessionID}/children` → `Session[]`（"forked from parent"） | sdk `dist/v2/gen/sdk.gen.d.ts:1042`；types.gen.d.ts:8240-8268 | High |
| 会话列表按 roots 过滤 | `session.list({roots})` 支持只列根会话 | sdk.gen.d.ts:958-967 | High |

> 服务端 ctx **没有** `children` 方法；跨会话树只能走 HTTP `client.session.children` 或 `ctx.session.get` 的返回体（后者形状运行时未实测）。

## 2. 如何被创建

- 创建时传 parentID：`session.create({ parentID?, title?, agent?, model?, permission?, workspaceID?, ... })`（sdk.gen.d.ts:973-989）；HTTP `POST /session`。→ **High**
- 派生者：① `task` 工具（产生 subtask）；② agent 配置 `mode:"subagent"|"primary"|"all"`（types.gen.d.ts:3175, 1936, 1362）；③ 配置 `subagent_depth`（types.gen.d.ts:1563）；④ 其它插件调 `ctx.session.create`（ctx 域有 create，doc 02:41）。
- 父会话侧的表示：assistant message 里出现 `SubtaskPart{ sessionID(=父会话), messageID, type:"subtask", prompt, description, agent, model?, command? }`（types.gen.d.ts:264-277 / SubtaskPartInput :2129-2140）。**注意：SubtaskPart 不含子会话 id** —— 父子关联只能靠 `parentID` 反向查（`children`）。
- 后台化：`experimental.session.background` "Detach synchronous subagents currently blocking the session"（sdk.gen.d.ts:153-155）。
- 关系存储位置：Session 记录上的 `parentID`（本机 `~/.local/share/opencode` 只有 `opencode.db` + `session_diff/`；grep `parentID` **0 命中**，DB 未读出）→ **存储层未实测**。

## 3. 事件层

| 问题 | 结论 | 来源 | 置信度 |
|---|---|---|---|
| `session.created` 类型 | properties = `{ sessionID, info: Session }` → info 含 parentID+agent | types.gen.d.ts:581-587；sync 变体 `session.created.1` :2519-2531 | High（类型） |
| 运行时刻 payload | **未实测**：P0 §3.3 只列了 `session.created` 名字，未 dump data 字段；且 P0 §3.4 证明类型定义 0 命中所测事件名 | spike 01 §3.3/§3.4 | 未实测 |
| 子会话是否进同一全局流 | **P0 实测："子会话的 session.idle 不转发给插件订阅者"、"子会话事件不转发"** → 与任务前提相反，子会话事件可能根本不进我们的流 | research doc 02:43,91 | Medium（单来源实测） |
| location 字段 | 全局流**跨 location**（实测），location.directory 有效；子会话是否带正确 location **未实测** | spike 01 §3.2/§3.3 | Medium / 部分未实测 |

> 关键冲突：SDK 类型说事件流是全局的（含子会话），P0 实测说子会话事件不转发。**在解决这个矛盾前不得假设"子会话事件会进注册表"。**

## 4. 权限/审批归属（★必须回答）

- `permission.asked` 实测 data = `{ action, id, resources, save, sessionID, source }`（spike 01 §3.3:85；类型版 `{id,sessionID,permission,patterns,metadata,always,tool?}` types.gen.d.ts:1128-1142）。**sessionID = 运行该工具的会话**（子会话里跑就是子会话 id）。
- 应答入参（实测）：`ctx.permission.reply({ path:{requestID}, body:{reply:"once"|"always"|"reject"} })`（spike 01 §4:126-127；opencode-plugin `src/server/opencode-ctx.ts:61-65`）——**只按 requestID 应答，入参没有 sessionID**。
- 我们的归属：notice owner = **提出该 permission 的 sessionID 的首个认领设备**（`permission-bridge.ts:199-219` 记 nativeSessionId；`245-256` bindPending；`bridge-hub.ts:1016-1025` #claim 首个认领者胜）。
- **父子不共享权限上下文**：既然 reply 不带 sessionID、owner 由 ask 的 sessionID 推导，**父会话的认领不会覆盖子会话的审批**。
- **风险链（推断，Medium-High）**：子会话 `permission.asked` 的 sessionID 是子会话 id → 该子会话从未被我们 create/start/subscribe、也没被认领 → notice 落 `ownerConnectorId=null` → 远端应答 `unbound_notice`（fail closed，permission-bridge.ts:64-67）→ **永久无法远端作答**。
- **未验证**：evaluate hook 的 `payload.sessionID` 对子会话是否仍是子会话 id（P0 只在主会话测过，spike 01 §4:120）。

## 5. AA/DSH 侧对等模型

| 层 | 现状 | 来源 | 置信度 |
|---|---|---|---|
| DSH 会话列表 | **排除 subagent**（与归档/空会话一起剔除） | dsh-bridge-next/RUNTIME_SYNC_PLAN.md:17 | High |
| DSH 映射 | `subagent / subagent_fork / send_message` → `tool / agent_call`，保留动作+输入 | RUNTIME_READS.md:55 | High |
| DSH PTC 子调用 | 带 `parentItemId`（由 parentCallId 推导）+ `rootCallId`，与父项合并到同一会话流 | tests/unit/runtime-history.test.ts:43-63,104-119 | High |
| DSH 会话 metadata | `parentSession`（来自 `header.parentSession`）随列表返回，供过滤 | src/host/dsh-runtime/router.ts:242 | High |
| connector 数据模型 | `RuntimeTimelineItem` **无** parent/thread 字段 | connector/runtime_protocol/models.py:252-264 | High |
| connector 父子承载 | 挂在 content：`AgentCallToolContent.{parent_item_id,agent_id,caller_id,target_ids}` → 序列化 `parentItemId` 等 | runtime_protocol/timeline.py:200-235；agent_calls.py:23-63 | High |
| connector AgentCall 动作 | invoke/spawn/send_input/resume/wait/close/unknown | agent_calls.py:12-20 | High |
| docs/contracts | `docs/runtime-protocol/**` 与 `contracts/**` **无** 父子/子会话约定（grep 0 命中） | — | High（负结果） |
| AA 服务端 | `SessionView` **无** parent/child 字段 | server/agent_server/core/models.py:767-804 | High |
| AA 前端 | 按 `content.parentItemId` 把嵌套 agent 调用聚成 `agent-calls` 组，**全部在同一会话内** | web-next/src/components/session-detail.tsx:1998-2141 | High |

> **对等结论**：AA/DSH 把"子会话"建模为**父会话 timeline 内的 agent_call 工具项**（嵌套、共享一个会话流），而不是独立会话。OpenCode 用独立会话 (+parentID)。

## 6. 对我们的影响清单（判断）

1. **会话发现与注册表**：OpenCode 的 `parentID` 是独立会话语义。建议**仍把子会话作为独立会话上报**并加 metadata：`parentSessionId` / `rootSessionId` / `agent`（否则其事件与审批无处归属）。**前提**：先解决第 3 节的矛盾——若"子会话事件不转发"成立，子会话根本不会进注册表，就**必须主动枚举**（`client.session.children` / `session.list`）来补齐，而不是继续等事件。当前注册表 (`session-registry.ts`) 无 parent 概念、无枚举通道（`partial` 恒真）。
2. **timeline 投影**：两条路线——
   - (a) 对齐 DSH：子会话内容合并进**父会话流**，父流留一个 `agent_call` 占位项（`parentItemId` 指向父项）。改动小（复用 `agent_call`/parentItemId），但需要把子会话事件路由进父会话的 projection（当前 projector 按 sessionID 分流，需加映射）。
   - (b) 子会话独立成流：父子各自完整，父流只放 `agent_call` 占位。与 DSH 不一致，前端 `groupTimelineItems` 期望的是同会话内嵌套。
   - 建议 **选 (a)**，与已有 DSH/前端模型一致，避免前端二次改造。
3. **审批绑定（★）**：当前"首个认领 = 首连接、按 native session id"策略**覆盖不到内部派生的子会话**。建议把认领粒度改为**按 location/命名空间或按 root 会话家族**：在 `#claim` 时解析 `parentID`/`children` 家族，把同族未认领会话的 pending notice 一并绑定（扩展现有 `bindPending`）。若拿不到家族关系，则退而求其次——对 `ownerConnectorId=null` 的 notice 提供"同 location 设备兜底应答"策略（需产品/安全决策，因涉及跨设备授权）。
4. **能力上报**：建议新增能力行 / metadata 字段（如 `session.subagents` 或 `supportsChildSessions`），但在第 3 节矛盾未解决前，**必须标为 partial/未验证**，不得声称完整支持（沿用 `discoveryState:partial` 的诚实口径）。

## 7. 建议下一步（唯一能把推断升为实测的动作）

**只读隔离探针**（复用 P0 装置，不改仓库、不扰 PID 9016）：`OPENCODE_CONFIG_DIR`/`XDG_*` 重定向 + `opencode run --standalone --print-logs`，派一个 subagent（`task` 或 `agent mode=subagent`），dump：
- `session.created` 的 **data 字段**（是否含 `info.parentID` / `agent`）；
- 子会话事件**是否进** `ctx.event.subscribe()` 全局流、`location` 是否正确；
- 子会话内 `permission.asked` 的 `sessionID`；evaluate hook 的 `payload.sessionID`；
- `ctx.session.get({sessionID})` 返回体是否含 `parentID`。

在此之前，设计按保守假设走：**子会话 = 独立会话 + parentID，且其事件可能不进流**。

## 8. Gaps（未验证）

- 运行时刻 `session.created` 的 data 形状（含 parentID？）——需探针。
- "子会话事件不转发"是否成立于 `session.created`（而非仅 `session.idle`）——需探针。
- `ctx.session.get` 返回体运行时是否含 parentID——需探针。
- Session `parentID` 的本地持久化（opencode.db 未读出）。
- `ctx.session` 是否有未在域表出现的 `children`（域表是有限枚举，可能漏）。
- TUI `api.client.session.children` 在 TUI 进程内可用性（TUI 无 rpc，用 api.client HTTP）。
