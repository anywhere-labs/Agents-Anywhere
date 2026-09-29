<!-- tm_board_write · 2026-09-26T19:57:52.743Z · role=implementer · session=20260926-213919 -->
<!-- AA · 子会话事件是否进流 · 隔离实测报告 -->
# 子会话（child session）事件是否进入 `ctx.event.subscribe()` 全局流 —— 隔离实测判定

> 环境：opencode-cli 2.0.18（C:\Users\34296\AppData\Roaming\ai.opencode.desktop\cli\2.0.18\opencode-cli.exe）
> 隔离：`OPENCODE_CONFIG_DIR`+`XDG_DATA_HOME/STATE/CACHE` 全部重定向到 C:\Users\34296\AppData\Local\Temp\opencode\aa-subagent\；
> `--standalone`（私有 server，`serve --stdio --port 0`）。**未改仓库**（D:\Github\Agents-Anywhere 全程只读）、**未改用户配置**、**未扰 PID 9016**、**未占 49374**。
> 探针（仅临时目录）：`aa-subagent\proj\.opencode\plugins\aa-subagent-probe\index.js`；事件原始 JSONL：`aa-subagent\events*.jsonl`。

## 0. 一句话结论（直接回答矛盾）

**子会话/其它会话的事件确实进入 `ctx.event.subscribe()` 全局流**（实测：订阅之后新建的会话，其 `session.created`/`session.renamed`/`session.agent.selected` 均带**该会话自己的 sessionID** 抵达探针）。
**但 `session.created` 的运行时刻 payload 并不含 `info`（即没有 `parentID`/`agent`）**，`ctx.session.get({sessionID})` 也不含 `parentID`/children。
⇒ **两个原始前提在"强形式"下都不成立**：不是"子会话事件不转发"，而是"事件转发**不区分父子**"；同时"从事件 payload 学父子关系"这条路**不存在**。

## 1. 实验装置（可复核）

- 触发子会话的两条路：
  1. **模型路（`task` 工具）—— 本轮不可用**：所有 provider 网关均不可达（见 §6），无法产生真实模型回合。
  2. **无模型路（已采用）**：探针在收到首个带 `data.sessionID` 的事件后，自己调用 `ctx.session.create(...)` 新建一个会话，并对其发 `update`/`switchAgent`/`interrupt`，观察其事件是否进流。
- 运行命令（run.ps1）：`opencode run --standalone --print-logs --log-level info --agent build --model lxns-maiden/deepseek-ai/DeepSeek-V4.1-Flash "<让 build 调 task 派生 subagent 的提示>"`（run5/run6/run7 的观察窗口）。

## 2. 结果表

| # | 问题 | 实测判定 | 证据 |
|---|---|---|---|
| ① | 子会话/其它会话事件**是否进** `event.subscribe` 流 | **进**（`session.created`/`session.renamed`/`session.agent.selected`，均带该会话 sid） | §3.1 / §3.2 |
| ② | `session.created` 运行时刻 payload | `{sessionID, projectID, location, subpath, slug, title, version}`；**无 `info`**（`.info===undefined`）、**无 parentID/agent** | §3.1 |
| ③ | `ctx.session.get({sessionID})` 返回体 | `{id, projectID, agent?, model?, cost, tokens, time, title, location}`；**无 parentID、无 children** | §3.3 |
| ④ | 子会话 `permission.asked` 的 sessionID 归属 | **未实测**（无可用模型 ⇒ 无法在子会话里跑工具） | §5 |
| ⑤ | `evaluate` hook 的 `payload.sessionID` 归属 | **未实测**（同上）；hook 注册本身成功 | §5 |
| ⑥ | 对照：父/根会话事件是否照常出现 | **照常**（inbox.enqueued / execution.started / instructions.updated / step.started / retry.scheduled） | §3.4 |

## 3. 原始证据（JSONL 原文，探针直接 append，未加工）

### 3.1 子会话的 `session.created` 进入全局流（run6）
```json
{"ts":"...19:51:52.094Z","where":"event","type":"session.created","durable":{"aggregateID":"ses_f20b9db14ffeFIcNvD2yh73ZWR","seq":0,"version":1},"location":{"directory":"C:\\Users\\34296\\AppData\\Local\\Temp\\opencode\\aa-subagent\\proj"},"data":{"sessionID":"ses_f20b9db14ffeFIcNvD2yh73ZWR","projectID":"2eef3a9dcb1657850680023dfd84a68c840b0308","location":{"directory":"C:\\...\\proj"},"subpath":"","slug":"quick-sailor","title":"aa-child-probe","version":"2.0.18"}}
{"ts":"...19:51:52.095Z","where":"session.created.raw","sessionID":"ses_f20b9db14ffeFIcNvD2yh73ZWR","info":"undefined"}
```
→ `data` 内**没有 `info`**（探针取值得到 `undefined`），因此**没有 parentID/agent**。类型定义 `{ sessionID, info: Session }` 与运行时刻不符。

### 3.2 非"创建型"事件也带子会话 sid 进流（run6）
```json
{"where":"event","type":"session.renamed","durable":{"aggregateID":"ses_f20b9db14ffeFIcNvD2yh73ZWR","seq":1,"version":1},"data":{"sessionID":"ses_f20b9db14ffeFIcNvD2yh73ZWR","title":"aa-child-probe-2"}}
{"where":"event","type":"session.agent.selected","durable":{"aggregateID":"ses_f20b9db14ffeFIcNvD2yh73ZWR","seq":2,"version":1},"data":{"sessionID":"ses_f20b9db14ffeFIcNvD2yh73ZWR","agent":"build"}}
```
（这两条由探针对该会话调用 `ctx.session.update/switchAgent` 触发 ⇒ 该会话的**非创建事件**同样进流。）

### 3.3 `ctx.session.get` 返回体（无 parentID / 无 children）
根会话（run4 §line13）：
```json
{"where":"root.session.get","sessionID":"ses_f20bbb051ffeF4EUuwNyU77miF","result":{"id":"ses_f20bbb051ffeF4EUuwNyU77miF","projectID":"2eef3a9d...","agent":"build","model":{"id":"deepseek-ai/DeepSeek-V4.1-Flash","providerID":"lxns-maiden","variant":"default"},"cost":0,"tokens":{"input":0,"output":0,"reasoning":0,"cache":{"read":0,"write":0}},"time":{"created":1790452191170,"updated":1790452192170},"title":"aa-subagent-probe","location":{"directory":"C:\\...\\proj"}}}
```
被创建的会话（run6 §line16）：
```json
{"where":"child.session.get","sessionID":"ses_f20b9db14ffeFIcNvD2yh73ZWR","result":{"id":"ses_f20b9db14ffeFIcNvD2yh73ZWR","projectID":"2eef3a9d...","cost":0,"tokens":{"input":0,"output":0,"reasoning":0,"cache":{"read":0,"write":0}},"time":{"created":1790452312068,"updated":1790452312068},"title":"aa-child-probe","location":{"directory":"C:\\...\\proj"}}}
```
⇒ 两个返回体都**无 `parentID`/无 children 字段**；根有 `agent`、新建的根本连 `agent` 都没有。

### 3.4 对照：根会话事件照常进流（证明装置有效）
```
event session.inbox.enqueued    sid=ses_f20b9e0e7ffePZk3sBBmTW3cgY
event session.execution.started sid=ses_f20b9e0e7ffePZk3sBBmTW3cgY
event session.instructions.updated sid=ses_f20b9e0e7ffePZk3sBBmTW3cgY
event session.inbox.delivered   sid=ses_f20b9e0e7ffePZk3sBBmTW3cgY
event session.step.started      sid=ses_f20b9e0e7ffePZk3sBBmTW3cgY
event session.retry.scheduled   sid=ses_f20b9e0e7ffePZk3sBBmTW3cgY
```

### 3.5 关键时序副作用：**订阅晚了会漏事件**
根会话的 `session.created` **从未出现**（只有它后续的事件）；而被订阅之后新建的会话的 `session.created` **出现了**。
⇒ `event.subscribe()` 只投递订阅之后的事件，**不回放**；插件在 server 启动时订阅，若会话在此之前已创建，其 `session.created` 永久丢失。

## 4. 附带发现（对设计同样关键）

1. **`ctx.session.create({parentID})` 不产生子会话**：`ctx.session.create({parentID:"ses_...", title:"aa-child-probe"})` 成功返回会话，但隔离 DB `session_v2.parent_id` 为 **NULL**（试了 3 种入参形状：flat `{parentID,title}`、`{body:{parentID,title}}`、`{parentID,agent,title}` 皆 NULL；title/agent 生效，parentID 被忽略）。
2. **V2 公开 API 的 create 体里根本没有 parentID**：`POST /api/session` 的 `V2SessionCreateData.body = { id?, agent?, model?, location? }`（sdk v2 `types.gen.d.ts:9700-9704`）。SDK 里带 `parentID` 的是**旧路由** `/session`（`types.gen.d.ts:8082`，`SessionCreateData.body.parentID`），而 `POST /session` 在本 build 上返回 **405**（被 Web UI 接管，API 前缀是 `/api`）。
3. `GET /api/session/{id}/children` → **404**（本 build 未暴露该路由）；`opencode session` 子命令只有 list/delete/export/import。
4. **`opencode api --standalone` 的私有 server 不加载项目插件**（无 `loading plugin` 日志、探针零写入）⇒ 无法用 HTTP 造会话 + 插件旁观察。
5. `session_v2` 表**有** `parent_id` 列与索引；**用户库中确有 105 条 `parent_id` 非空**的子会话（多为 `@explore subagent`，`task` 工具派生）⇒ 父子持久化由**内部 task 路径**完成，公海 API 不提供。
6. `ctx.session` 方法面实测：`create/get/prompt/interrupt/update/switchModel/switchAgent/context/generate/command/synthetic/wait/move`（**无 list、无 children**）。

## 5. 未完成项（如实标注，非推测）

| 项 | 状态 | 卡点 |
|---|---|---|
| ④ 子会话内 `permission.asked` 的 sessionID 归属 | **未实测** | 需要真实模型跑一次工具；本轮**所有 provider 网关不可用**（见 §6），`task` 派生子会话无法发生 |
| ⑤ 子会话内 `evaluate` hook 的 `payload.sessionID` | **未实测** | 同上（hook 注册成功：`{"where":"permission.hook.registered"}`；P0 已测**父会话**下该 payload 形状：`{sessionID,agent,action,resources,metadata,source,effect}`） |
| 真 `parentID` 子会话的事件是否进流 | **未直接实测** | 需要 `task` 工具（要模型）。本轮"进流"结论建立在**"订阅之后新建的会话"**上——事件总线**按会话 id 投递、envelope 中无任何父子字段**，故父子差异无路由依据；但严格说未用 parentID 子会话证过 |

## 6. 模型为何不可用（非本轮可解）

```
lxns-maiden  -> HTTP 502    lxns-empurple -> HTTP 502
lxns-uni     -> HTTP 502    lxns-ris      -> HTTP 502
api.deepseek.com/v1/models -> HTTP 401（api key 无效/过期）
```
（baseURL `https://anthropic.kunbot.org/{maiden,empurple,uni,ris}/v1` 的网关整体 502。）

## 7. 对设计的结论（钉死前提）

1. **前提 A（事件层）：子会话事件进流** —— 注册表/投影**可以**建立在 `ctx.event.subscribe()` 上，且**不需要**为子会话另开通道。P0「子会话事件不转发」应被推翻；其观察更可能是**订阅时机**（§3.5）或"子会话 `session.idle` 本就不发射"造成的误判。
   - ⚠️ 但**不能**依赖 `session.created` 做发现：订阅前的会话会永久漏掉；`ctx.session` 无 `list`，发现通道是缺口。
2. **前提 B（父子关系）：事件与 `session.get` 都不含 parentID** —— 父子关系**不能**从事件派生。要建父子家族（审批按家族绑定、父子 timeline 合并）必须另辟通道，而本 build 上 `/api/session/{id}/children` 404、`ctx.session` 无 children；可行通道只剩 TUI 侧 `api.client`（HTTP SDK）或直接读 DB。**这会改变注册表/投影的设计**：不要设计成"从事件里读 parentID"。
3. **审批绑定**：既然事件按会话 id 投递且子会话事件能进流，子会话**可以**被注册表认领（前提是不漏 `session.created`）——但④未实测，**不得**据此声称"子会话审批可远端作答"；按研究者原风险链（按 native session id 首认领）在"漏事件"时会 fail-closed，需补枚举/兜底。
4. **建议**：注册表改为"事件驱动 + 定时枚举对账"双通道（枚举走 TUI `api.client.session.list({roots:false})` 或 DB），父子关系亦来自该通道；能力上报维持 `partial`。

## 8. 清理与产物

- 自起进程：多轮 `opencode-cli`（run0..run9 的 `serve --stdio` 子进程）→ **全部已关闭**；末次核验 **仅剩用户 PID 9016**。
- 未占 49374（用户自身的 45 条连接与本轮无关）；未改仓库/用户配置。
- 临时产物保留于 `C:\Users\34296\AppData\Local\Temp\opencode\aa-subagent\`：`proj\.opencode\plugins\aa-subagent-probe\index.js`、`cfg\opencode.json`、`run.ps1`、`events.run0-failed.jsonl`…`events.run7-altshapes.jsonl`、`console.out`、`data\opencode\opencode.db`（隔离 DB）。
- 成本：**0 次成功模型调用**（网关 502）；仅本地过程，无外网 token 花费。
