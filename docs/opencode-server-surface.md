# OpenCode 宿主自带服务面（2.0.18 实测）

本文只记**实测事实**与**复现方法**，不记计划。它是「把 OpenCode 接入从宿主内插件改为
Agents Anywhere 侧对端中转」这一形态决策的判据来源；插件形态那轮的结论与未验证项仍记在
[`docs/opencode-plugin-evidence/VERIFICATION.md`](opencode-plugin-evidence/VERIFICATION.md)
（该目录是插件退役时从 `opencode-plugin/` 原样保留下来的取证报告，插件代码本身已删除）。

实测环境：`opencode v2.0.18`（桌面 App `@opencode-aidesktop` 内嵌 CLI），Windows 11。
所有对活实例的访问都是只读 `GET`；写面形状取自实例自报的 OpenAPI 规格，**除字段名/必填键外未实际触发**
（早先"`parts` 必填"一条就是照抄报错猜的，§7 已按规格更正）。
二进制逆向在副本上进行（`D:\桌面\Opencode逆向\opencode-cli.exe`，205,848,968 字节），
原安装目录未做任何修改。

## 0. 形态决策：为什么不做进程内插件（产品决定，2026-09-28）

接入 **Agents Anywhere 客户端**（连接器直连宿主自带服务面），而不是 OpenCode 自带插件，理由有三：

1. **维护与发版异常麻烦**：插件要跟着 OpenCode 的每个版本验一遍，发版还要走 Git 规格安装；
2. **用户无法自动更新插件**：装出去的就是冻结的构建产物（本仓库曾为此提交 4.9 万行 `lib/`）；
3. **有可能损坏配置文件**：插件形态需要碰宿主配置与进程内 hook，而对端形态对宿主零写入。

因此 `opencode-plugin/` 已整体退役，取证报告保留在
[`docs/opencode-plugin-evidence/`](opencode-plugin-evidence/)；本文以下全部是**对端形态**的实测判据。

## 1. 服务发现：一台机器一个共享服务

- 注册文件：`$XDG_STATE_HOME/opencode/service.json`（默认 `~/.local/state/opencode/service.json`），
  实测内容形状：

  ```json
  {"id":"1522e21e-…","version":"2.0.18","url":"http://127.0.0.1:49374","pid":18772,
   "password":"…"}
  ```

- 鉴权：`Authorization: Basic base64("opencode:" + password)`。用户名固定 `opencode` 这一点来自
  二进制内的客户端代码，不是推测。
- 存活与版本判定：`GET /api/info` → `{"version","pid","urls":[],"paths":{"tmp"}}`。宿主自己的客户端
  逻辑是：**回读的 `pid` 与登记不符 ⇒ 视为无服务**；`version` 不符 ⇒ 同样视为不可用。
  我们应当照做（登记文件可能是上一次运行留下的）。
- 密码可固定：二进制内是 `OPENCODE_PASSWORD` → 回落 `OPENCODE_SERVER_PASSWORD`。
- 重启命令：`opencode service restart`（官方文档 Reload 一节）。
- 桌面 App 的启动形态：宿主日志里是 `args=["serve","--service"]`；另有 `serve --stdio --port 0`
  的私有实例形态（隔离探针用）。`opencode serve --port N` 由外部进程自起也已实测跑通。
- CLI 二进制**按版本并排存放**：`~/.config/…` 之外的 `AppData/Roaming/ai.opencode.desktop/cli/`
  下同时存在 `2.0.6 / 2.0.16 / 2.0.18`，日志里 `channel=latest` 且 2.0.16 与 2.0.18 都跑过。
  ⇒ **任何写死二进制路径的做法都会被宿主更新打断**；只认 `service.json` 才免疫。

## 2. 信任边界（要如实写进对外说明）

`service.json` 里的密码是**明文**，同机任意用户态进程读到即可驱动该 OpenCode 实例
（发回合、改模型、回审批）。这与插件形态下端点文件里的 bridge token 是同一级边界，
**不构成回退**，但也不能宣称更安全。

## 3. location 语义：查询参数生效，请求头不过滤

| 调用 | 结果 |
| --- | --- |
| `GET /api/session`（带 `x-opencode-directory: D:/Github/Agents-Anywhere`） | 50 条，混 4 个目录 |
| `GET /api/session`（不带该头） | 同样 50 条、4 个目录 ⇒ **该头对列表无过滤作用** |
| `GET /api/session?directory=<绝对路径>` | 只剩该目录的会话（分页取完共 83 条） |
| `GET /api/session?directory=D:/Github/Agents-Anywhere` | 83 条 ⇒ 分隔符 `/` 与 `\` 等价 |
| `GET /api/session?directory=d:/github/agents-anywhere` | **0 条** ⇒ **大小写敏感**：用户手输的小写路径看着像"这个项目没有会话" |
| `GET /api/session?directory=D:\Github\Agents-Anywhere\connector` | 0 条 ⇒ 不是前缀/子树匹配，只认精确目录 |
| `GET /api/session?directory=<存在但宿主没打开过的绝对路径>` | 0 条 ⇒ "未加载" 与 "没有会话" 在这一层同形 |
| `GET /api/session?directory=nope`（非绝对路径） | **HTTP 500**（空体）⇒ 只有相对/畸形值才是服务端错误 |
| `GET /api/debug/location` | `{"data":[{"directory":…}, …]}`，实测列出实例已加载的 2 个目录；`POST /api/session` 带新 `location` 后会**多出一条** ⇒ 宿主是按需加载位置的 |
| `GET /api/mcp` | 回包 `location.directory` 是 `C:\Users\34296`，**不是**请求头里给的值 |
| `GET /api/session`（不带参数，limit=200） | **269 条、跨 28 个目录** ⇒ 一台机器一个服务，不做 location 过滤就会把别人项目的会话搬过来 |

⇒ 集成文档里"按 location 隔离"必须实现为：**用 `?directory=` 查询 + 校验回包每条的
`location.directory`**，不能照抄插件时代"连接声明一次、服务端过滤"的做法。

⇒ 因为过滤是**大小写敏感的字符串比较**，连接器在 attach 时先用 `/api/debug/location` 把配置里的
位置解析成**宿主自己的拼写**（`serve/runtime.py:_resolve_directory`），解析不到就报
`location_not_loaded` 而不是返回空清单；catalogs 面（下一节）不吃这个参数，所以"目录空了"只可能
出现在会话面。

## 4. 会话与子会话（"子 Agent 能不能显示"）

- 本目录 `?directory=` 走完 `cursor.next` 三页：**83 条会话，76 条带 `parentID`（91%），顶层 7 条**；
  所有子会话的父会话都在同一集合内（补捞数 0）⇒ 可以本地组树。
- 子会话详情键：`id, parentID, projectID, location, agent, model, outcome, cost, tokens, time, title`
  ⇒ 能显示"是哪个子 Agent、用的什么模型、结果如何"。
- `GET /api/session/{id}/message` 对子会话返回 4 / 50 / 26 条（首条键 `id, type, outcome, time`）
  ⇒ 子会话时间线可读。
- **限制**：`POST /api/session` 带 `parentID` 会被接受但静默忽略 ⇒ AA 侧**无法主动派生子会话**；
  识别宿主自己派生的子会话没问题。
- `GET /api/session?parentID=null` 只回顶层会话（2026-09-29 活服务实测：本机 19 条里 15 条带
  `parentID`，加过滤器后剩 4 条）⇒ AA 的清单**只列顶层会话**：子会话是宿主的内部工人，不是新聊天，
  而且父会话时间线里本来就有 `<subagent sessionID=…>` 记号指向它们。
  清单同时本地再滤掉带 `parentID` 的行——这个宿主已被证明会接受却不执行某些查询参数（见 §5 目录面）。
- `GET /api/session/active` 给出当前活跃会话（实测 1 条）。

### 4.1 消息与部件形状（活服务真实样本，时间线映射的依据）

分页与顺序（全部实测，`GET /api/session/{id}/message`）：

| 调用 | 结果 |
| --- | --- |
| 不带参数 | **默认按时间倒序**（最新在前），默认页 50 条 |
| `?order=asc` | 正序，第一页即会话第一条消息 |
| `?limit=200` | 接受；`?limit=500` → **HTTP 400** `Expected a value less than or equal to 200` |
| `?cursor=<next>&order=asc` | **HTTP 400** `InvalidCursorError: Cursor cannot be combined with order` ⇒ 游标自带 order，后续页只传 cursor |
| 走完 `cursor.next` | 主会话 33 页 / **649 条**，逐页时间戳单调递增，`id` 无重复；末游标仍指向一个**空页** ⇒ 见到空 `data` 必须停 |

`Session.Message.Info` 全枚举：`agent-switched / model-switched / location-switched / user /
synthetic / system / skill / shell / assistant / compaction / idle`（`idle` 不在 `?type=` 过滤枚举里，但确实出现在响应中）。

取自该 649 条真实历史（`ses_f22107110ffdwOAm3Bcv9JiTBV`）：

| 消息 `type` | 键 | 说明 |
| --- | --- | --- |
| `user` | `id, text, files, agents, metadata, time, type` | 用户回合；`metadata.displayText/agent/model` 也在 |
| `assistant` | `id, agent, model, content[], snapshot, finish, cost, tokens, time, type` | 正文在 `content`（部件数组）；`finish ∈ stop/length/tool-calls/content-filter/error/unknown`；失败时另有 `error{type,message}` 且 `content` 为空（实测 8/418 条） |
| `synthetic` | `id, text, description, metadata, time, type` | **子 Agent 的落点**：`metadata.source="subagent"`、`childID`、`agent`、`state`；正文是 `<subagent sessionID=… state=… description=…/>` |
| `idle` | `id, outcome, time, type` | 终止记录，`outcome ∈ succeeded/failed/interrupted`（实测 93/2/6） |
| `model-switched` | `id, model{ID,id,variant}, previous{…}, time, type` | 模型切换（实测 4 条） |
| `compaction` | `id, status, reason, model, summary, time, type` | 压缩点（实测 1 条），`summary` 是压缩后的正文 |

部件 `type` 分布（同一样本）：`reasoning` 409、`text` 386、`tool` 404；工具 `state.status`：`completed` 402、`error` 2。
工具部件 `state` 是四选一：`completed{status,input,content[],metadata}`、`error{status,input,error,content?,metadata?}`、
`running{status,input,metadata}`、`streaming{status,input:字符串}`。**结果在 `state.content`（`Tool.Content[]` = `{type:"text",text}` 或 `{type:"file",uri,mime,name}`），
`state` 里根本没有 `output`/`result` 键**——只读后者会让每一条工具行都只剩标题。

⇒ 投影要点（对应 `connector/runtimes/opencode/serve/timeline.py`）：
1. 会话按 `order=asc` 取全后再投影；`limit` 语义（"最新 N 条"）用 `order=desc` 取一页再倒回来。
2. `idle` 与 `model-switched`/`compaction` 也是"条目"，不能当噪声丢掉（AA 侧要显示"这轮被打断/中途换过模型/压缩过"）。
3. **一条 `user` 不等于一条 `idle`**：实测 46 条 `user` 对应 101 条 `idle`（一个回合内多次 idle），
   且有 7 个回合根本没有 `idle`。所以 `turn.end` 只在"有开着的回合"时发出，多余的 `idle` 计入
   `skippedMessageTypes.idle_without_turn`（实测 62），不伪造收尾。
4. 工具条目的 `native_key` 用 `tool:<消息id>:<序号>` 而非宿主 `state.id`：`chatcmpl-tool-*` 在不同消息间会重复，
   而 AA 服务端对时间线里**任一重复 item id 整体拒收**。
5. 全历史投影一条会话 = **1418 条 item**（`message` 920 / `tool` 404 / `turn.*` 85 / 其他 9）⇒ 快照体积是真实约束，见 §9。

## 5. 目录面：宿主直接告诉你它装了什么

| 面 | 实测 | 关键字段 |
| --- | --- | --- |
| 插件 | `GET /api/plugin` → **91 条**：`source.type` = builtin 88 / package 2 / local 1；`state.status` = active 90 / **failed 1** | `Plugin.State.failed` 带 `error` 与 `ref`；`Plugin.Source.package` 带 `target/version/outdated`；`Plugin.Features` = `{server?, tui?, rpc?}` |
| 模型 | `GET /api/model` → 79 条，**`id` 跨 provider 重复**（`longcat-2.5-preview-free`、`space-bunny-free`、`mimo-v2.6-pro`、`mimo-v2.6-flash` …） | 每条含 `id, modelID, providerID, family, name, compatibility, package, settings, capabilities, variants, cost, status, enabled, limit` |
| Agents | `GET /api/agent` → 13 条，`mode` = primary 6 / **subagent 7** | `id, name, request, system, description, mode, hidden, color, permissions` |
| Skills | `GET /api/skill` → 16 条（含 `/builtin/*.md` 与 `~/.agents/skills/*`） | `id, name, description, path` |
| 命令 | `GET /api/command` → 11 条 | — |
| MCP | `GET /api/mcp` → 本机 0 条（未配置） | `Mcp.Server.status` 枚举：`connected / pending / disabled / failed(+error) / needs-auth` |
| Integration | `GET /api/integration` → 230 条 | — |

⇒ 第三方插件装砸了能显形（本机真实样本：`@slkiser/opencode-quota@latest` =
`status:"failed", error:"Plugin must export a default …"` 且 `outdated:true`）。
⇒ **provider 前缀不是装饰**：`space-bunny-free` 同时挂在 `opencode-go` 与 `opencode` 两个 provider 下，
实测 `opencode-go/space-bunny-free` 直接 `Missing API key.`（回合失败），`opencode/space-bunny-free` 正常出词。
所以目录必须按 `providerID/modelID` 组键、发消息必须带两半 —— 塌成一条或猜 provider 都会把用户推进坏的那一半。
⇒ 模型目录的正确组键是 **`providerID/modelID`**（两条都保留、都可选）；宿主内 `ctx.model`
那条路上我们只能塌成一条，这是形态差异带来的实质改善。
⇒ **`?directory=` 对 `/api/model`、`/api/agent`、`/api/command`、`/api/config` 一律无效**：
79 / 13 / 11 / 3 条在正斜杠、反斜杠、小写、`nope`、不带参数五种调用下完全相同。也就是说这三张
目录是**整机**的，不是本位置的；带参数只是表达意图，不能拿"目录空了"当 location 写错的信号
（会空着的只有会话面，见 §3）。

## 6. 事件面

`GET /api/event`（`text/event-stream`），每帧 `{id, event, data}`；空闲时可见
`server.connected` 与 heartbeat 注释行。事件名不在 OpenAPI 里枚举（`V2EventEncoded` 只声明
`type: string`），因此从**运行时二进制**里提取（333 个点分候选名，剔除 89 个与 operationId
重名者后 244 个候选）。与本项目相关的族：

| 族 | 名字 |
| --- | --- |
| 回合生命周期 | `session.execution.started / succeeded / failed / interrupted` |
| 时间线 | `session.step.started / ended / failed`、`session.text.started / ended`、`session.reasoning.ended`、`session.tool.called / input.started / input.ended / progress / success / failed`、`message.updated / removed`、`message.part.updated / delta / removed` |
| 子会话 | `session.child.first / next / previous` |
| 审批与提问 | `permission.asked / replied / rejected`、`form.created / replied / cancelled` |
| 目录变化 | `model.updated`、`agent.updated`、`skill.updated`、`plugin.updated`、`command.updated`、`mcp.status.changed`、`mcp.tools.changed`、`mcp.resources.changed`、`mcp.prompts.changed`、`integration.updated`、`lsp.updated`、`project.updated`、`installation.updated`、`vcs.branch.updated`、`file.edited` |
| 会话元信息 | `session.created / deleted / moved / fork / compact / compacted / background / agent.selected / synthetic / inbox.enqueued / inbox.delivered`、`session.compaction.started / ended / failed / delta` |

⇒ 插件时代两条"永久限制"在这里消失：**回合状态不必自造判据**（`session.execution.*`），
**会话发现不必恒 partial**（`GET /api/session` 是可分页全量清单 + `cursor`）。

### 6.1 帧的真实形状（活实例实测，2026-09-27）

判别字段是 **`type`，不是 `event`**；`created`/`location`/`durable` 都是可选的：

```json
{"id":"evt_0e2a29453001tG0ei83I7sZZOE","created":1790508700755,"type":"session.created",
 "location":{"directory":"D:\\aa-recovery\\scratch-project"},
 "data":{"sessionID":"ses_…","slug":"kind-forest","version":"2.0.18","projectID":"8e2d…",
         "location":{"directory":"D:\\…"},"subpath":"","title":"aa-events-probe"},
 "durable":{"aggregateID":"ses_…","seq":0,"version":1}}
```

用"建会话→换模型→删会话"当唯一激励（不跑回合）实测到的帧：

| 帧 | 观察 |
| --- | --- |
| `server.connected` | 连接即一帧，`data={}`，无 `location`/`durable` |
| `session.created` | 带 `location` 与 `durable.seq=0` |
| `project.updated` | **无 `location`**（整机语义），不能按位置归属 |
| `session.model.selected` | `data={sessionID, model{id,providerID}}`，`durable.seq=1` ⇒ 换模型的真实事件名不是 §6 猜的 `model.updated` |
| `session.deleted` | DELETE 之后**确实出现**，但要等一会儿：立刻断流的探针看不到 ⇒ 事件只能降延迟，不能当权威 |
| `interrupt`（空闲会话） | 无帧 |

- `Last-Event-ID` 被忽略：带旧 id 重连只拿到一个**新的** `server.connected`（不同 id）⇒ **断线不可续传**，
  所以 §8 裁定 3 的"前缀校准"在对端形态下仍然需要，落地方式就是 `durable.seq` 出现缺口时整段重读。
- 空闲 10s 只有一帧 `server.connected` ⇒ 心跳是 SSE 注释行（`: heartbeat`），不是事件帧。
- 一次 30s 读超时后泵会自行重连并继续收帧（实测 `stream:error` 计 1 次后仍收到后续事件）。

### 6.2 真发一次回合时看到的帧（2026-09-27，只读 Agent + 免费模型）

在一次性目录里 `create_and_start_session` 真跑了一轮（agent=`plan`、model=`opencode/space-bunny-free`、
提示"只回复两个字"），事件计数器就是这一轮的原始证据：

`session.created` → `session.inbox.enqueued`(未路由，忽略) → `session.execution.started` →
`session.inbox.delivered` → `session.step.started` → `session.step.failed`/`session.execution.succeeded` →
`session.deleted`（**晚到**：断流太快就看不到）；期间还混进别处的 `provider.updated`、`model.updated`、
`location.shutdown`、`rpc.experimental.browser.control` ⇒ **帧是整机共享的，必须按 `location` 自己过滤**；
其中 catalog 类事件即使在别的位置也要生效（目录面本来就是整机语义，见 §5）。

回合本身的结果：`turn.start / message(user) / message(assistant "收到") / turn.end(done)` 四条按时间顺序落好，
`get_session_state` 回读 `selections={'agent':'plan','model':'opencode/space-bunny-free'}`。
失败的样子也实测到了：换成 `opencode-go/space-bunny-free` 时宿主回 `Missing API key.`，被投影成
`system/failed` 一条 + `turn.end` 状态 `failed` ⇒ **失败不会变成空白**。

## 7. 写面（形状取自实例自报规格；§7.1 是实际触发过的部分，含一次真回合）

| 端点 | 请求体（`req=` 为必填键） | 备注 |
| --- | --- | --- |
| `POST /api/session` | `{id?, title?, agent?, model?:{id,providerID,variant?}, location?:{directory}, metadata?, permissions?}` | **没有 `parentID` 字段** ⇒ 无法主动派生子会话；不写 `location` 就落在宿主默认位置，会从这个实例的清单里消失 |
| `POST /api/session/{id}/prompt` | `req=[text]`，另有 `id?, files?, agents?, skills?, metadata?, delivery?: steer\|queue, resume?: bool` | 之前记的"`parts` 必填"是错的：必填键是 **`text`**（当时的报错 `Missing key at ["text"]` 说的就是这个）。`delivery:"steer"` ⇒ steer 不是没有，是没有单独端点（见 §9）。**`id` 必须以 `msg_` 开头**（2026-09-29 隔离实例实测：不带 `id` ⇒ 宿主自己生成 `msg_…`；`id` 给裸 UUID ⇒ 400 `Expected a string starting with "msg_"`；`msg_` + 任意不透明串（含连字符、80 字符）⇒ 原样存下）——Web/桌面的客户端 id 本就是 `msg_<uuid>`，安卓是 `opt_<uuid>`，所以连接器要把客户端消息 id 归进 `msg_` 命名空间再发，既过校验又保住"重试只落一条" |
| `POST /api/session/{id}/command` | `req=[name, text]`，可选 `files/agents/skills/delivery` | 字段名是 `name`/`text`，不是 `command`/`arguments` |
| `POST /api/session/{id}/model` | `req=[model]`，`model=req=[id,providerID]` | 裸 model id 必须拒绝：`id` 跨 provider 重复 |
| `POST /api/session/{id}/agent` | `req=[agent]` | — |
| `POST /api/session/{id}/interrupt` | **无请求体**，查询参数 `resume` | 响应 `{interrupted: boolean}` ⇒ 没东西可打断时要如实报 false |
| `POST /api/session/{id}/permission/{requestID}/reply` | `req=[decision]`，`decision ∈ once\|always\|reject`，`message?` | 连接器侧永不当面接受 `always`（会改写宿主持久规则） |
| `POST /api/experimental/session/{id}/skill` | `req=[id]`，`resume?` | **"我想调用 OpenCode 的 Skills" 的答案就在这里**：`GET /api/skill` 16 条 + 这个触发端点；AA 侧目前未接 |
| `PUT/DELETE /api/experimental/mcp/{server}`、`POST …/connect`、`POST …/disconnect` | connect/disconnect 无体，查询参数 `location` | 控制 MCP 开关的面；本机没配 MCP，未证（§9） |

其余：`/compact`、`/fork`、`/shell`、`/synthetic`、`/move`、`/view`、`/background`、
`/revert/stage`、`/revert/commit`、`DELETE /revert`、`/form/{formID}/reply`、
`POST /api/plugin/check|update`、`POST /api/location/reload`。

### 7.1 已实际触发过的写面（2026-09-27，全部落在一次性 scratch 位置，事后已回收）

探测会话建在 `D:\aa-recovery\scratch-project`（**不是**用户项目目录）。早期几轮只验到字段校验；
最后一轮用只读 agent `plan` + 免费模型 `opencode/space-bunny-free` 真跑了一轮（见 §6.2），
会话同样 `DELETE` 后回读 `SessionNotFoundError` 确认无残留。实测：

| 触发 | 结果 |
| --- | --- |
| `POST /api/session {"title":…}` | **200**，落在 `C:\Users\34296`（宿主默认位置）⇒ 不带 `location` 建的会话**不会出现在本实例清单里**，这是真实缺陷而不是理论风险 |
| `POST /api/session {"title", "location":{"directory":…}}` | 200，回包带 `location.directory` 与 `projectID`，且该位置出现在 `/api/debug/location` 里 |
| `POST …/interrupt`（无体）与带 `{}` | 都是 200 `{"interrupted": false}` ⇒ 无体是对的，带 `{}` 也不报错；空闲会话上"没打断任何东西"要如实报 |
| `POST …/command {"name","text"}` | **HTTP_404 `CommandNotFoundError`** ⇒ 字段名被接受，错误发生在"命令不存在"这一步 |
| `POST …/command {"command","arguments"}` | **HTTP_400 `Missing key at ["name"]`** ⇒ 旧写法必然失败 |
| `POST …/prompt {}` | 400 `Missing key at ["text"]` ⇒ 必填键是 `text`（早先记成 `parts` 是照报错猜的） |
| `POST …/model {"model":{"id":…}}` | 400 `Missing key at ["model"]["providerID"]` ⇒ 裸 model id 必须像现在这样在本地就拒 |
| `POST …/permission/x/reply {"decision":"maybe"}` | 400 `Expected Permission.Reply at ["decision"]` |
| `DELETE /api/session/{id}` | **成功但响应体为空** ⇒ 之前 `_request` 对空 2xx 体走 `.json()` 失败 ⇒ 报成"服务不可达"。`/model`、`/agent`、`/command` 的 200 也是空体 ⇒ 不修就是**每次改模型/换 Agent 都被当成断线** |
| `POST /api/session/{id}/prompt {"text":…}` | **真跑通**：回合起来、assistant 出词、`turn.end` 关闭 ⇒ 写面主链路成立 |
| `POST /api/session` 带 `agent`+`model` | 201 且随后 `get_session_state` 回读到 `selections={'agent':'plan','model':'opencode/space-bunny-free'}` ⇒ 建会话时一次带上，省两次往返 |

## 8. 与 rev3 契约裁定的对应关系

| rev3 裁定 | 插件形态实现 | 对端形态实现 | 语义是否保持 |
| --- | --- | --- | --- |
| 1 `location` 必填、Hub fail-closed | 连接 `initialize` 声明一次，Hub 按目录过滤 | attach 时用 `/api/debug/location` 把配置位置解析成宿主自己的拼写（解析不到 ⇒ `location_not_loaded`），查询带 `?directory=`，再校验回包 `location.directory` | 保持（防线从"连接身份"改为"解析 + 查询参数 + 回包校验"；大小写敏感见 §3） |
| 2 `session.discovery` 的 `metadata.discoveryState` | 只有事件流 ⇒ 恒 `partial` | 有全量清单 ⇒ 可 `complete` | 保持且更强（禁止伪造仍是硬规） |
| 3 `historyHash` 前缀校准 | 自研 | 用帧上的 `durable.{aggregateID,seq}` 检缺口：`needs_resync` 判定重复/跳号即整段重读该会话（SSE 不可续传，见 §6.1） | 保持（换了判据来源，语义仍是"前缀不可信就重读"） |
| 4 跳过计数器归属（Hub `skippedEventCount` / Connector `skippedItemCount`） | 两侧各自计数 | 快照元数据 `skippedMessageTypes`（实测某会话 `idle_without_turn: 62`）；事件面尚未接 | 快照面保持，事件面待定 |

## 9. 未证清单（动手前必须先测，别当已知）

1. **MCP 内容与开关**：本机未配置 MCP（`/api/mcp` 返回空）。要造一个 MCP server 后测
   `mcp.list` 的 `location` 参数、`connect/disconnect` 的真实效果，以及 `mcp.status.changed`
   是否进 `/api/event`。
2. **`permission/{requestID}/reply` 真发一次**：只证路由存在、`/api/permission/request` 返回 200 空集。
   需要一次真实待审批（跑一个会要权限的回合），并确认 `always` 是否会被宿主落盘。
3. ~~**SSE 断线续传**~~ **已证（2026-09-27）**：带 `Last-Event-ID` 重连只拿到新的
   `server.connected`，旧帧不重放 ⇒ **不可续传**。§8 裁定 3 的落地方式因此确定：用
   `durable.{aggregateID,seq}` 检缺口，缺了就整段重读该会话（`serve/events.py:needs_resync`）。
4. ~~**`?directory=` 的确切语义**~~ **已证（2026-09-27）**：分隔符 `/` 与 `\` 等价、大小写**敏感**、
   非前缀匹配（子目录算未知）、完全未知的路径是 HTTP 500 而不是空集；对 model/agent/command/config
   四张面**完全无效**。结论与处置见 §3、§5。
5. **快照体积**：一条 649 消息的真实会话投影出 **1418 条 item**。Hub 侧一次 `publish` 能吃多少、
   超出后是分页还是截断，未证；AA 的 `get_session_snapshot(limit=…)` 目前映射到"最新 N 条**消息**"
   （不是 N 条 item）。
6. **`?type=` 过滤**：枚举里没有 `idle`，但 `idle` 确实在响应里 ⇒ 用 `type` 过滤会不会把生命周期
   消息漏掉，未证（当前实现不使用该参数）。
7. **`delivery: "steer"`**：规格上 prompt 支持 `steer|queue`，说明"插话"不是没有，只是没有单独端点。
   未在一次真实运行中的回合上试过一次 ⇒ `session.steer` 仍报 unsupported（原因文案已改成事实）。
8. **`POST /api/experimental/session/{id}/skill`**：能直接触发技能（`GET /api/skill` 16 条可列），
   但"触发后宿主怎么显示"未证 ⇒ AA 侧目前只读不写。
9. **审批真发一次**（同 2）：`reply` 的字段校验已被实测接受，但"批准后宿主确实执行那一步"仍未证。

## 10. 复现命令

只读探测活实例（不写任何东西）：

```bash
python - <<'PY'
import json,base64,urllib.request
d=json.load(open(r"C:\Users\34296\.local\state\opencode\service.json",encoding="utf-8"))
H={"Authorization":"Basic "+base64.b64encode(("opencode:"+d["password"]).encode()).decode()}
def get(p):
    with urllib.request.urlopen(urllib.request.Request(d["url"].rstrip("/")+p,headers=H),timeout=10) as r:
        return r.status, r.read().decode()
for p in ("/api/info","/api/session?directory=D%3A%2FGithub%2FAgents-Anywhere",
          "/api/plugin","/api/model","/api/agent","/api/skill","/api/mcp","/api/debug/location"):
    print(p, get(p)[0])
PY
```

隔离实例（不碰用户配置，自己起一个 serve 并跑写面）：

```bash
CLI="$LOCALAPPDATA/Programs/@opencode-aidesktop/resources/opencode-cli.exe"
ROOT=/tmp/aa-serve-probe; mkdir -p "$ROOT"/{config,data,state,cache,proj}; cd "$ROOT/proj"
OPENCODE_CONFIG_DIR="$ROOT/config" XDG_DATA_HOME="$ROOT/data" \
XDG_STATE_HOME="$ROOT/state" XDG_CACHE_HOME="$ROOT/cache" \
  "$CLI" serve --port 14100 > "$ROOT/serve.log" 2>&1 &
PW=$(sed -n 's/.*server password //p' "$ROOT/serve.log" | head -1)
curl -s -u "opencode:$PW" "http://127.0.0.1:14100/openapi.json" | head -c 200
```

**判据自身的坑（本轮踩过两次）**：

- 不带凭据时**每一条路径**都返回 `200 + Web UI 的 HTML`，"200 即存在"必然得出错误结论 ⇒ 先看
  `content-type` 是不是 JSON。
- 这些路由**用 200 装错误信封**（`{"_tag":"SessionNotFoundError", …}`），所以 404/200 都不能当
  "路由在不在"的判据；要区分"路由不存在"与"资源不存在"得看响应体。
- 文档版规格（`https://opencode.ai/v2/openapi.json`：113 paths / 136 ops）与本机实例
  （`/openapi.json`：115 paths / 138 ops）**不同代**，一律以实例自报为准。
