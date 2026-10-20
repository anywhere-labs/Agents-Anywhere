# OpenCode serve V2 API 迁移设计(2.0.27)

状态:**已实施并真机验证**(2026-10-15)。基线:connector `runtimes/opencode/`(原按 opencode serve **1.18.34** 编写);目标:opencode **2.0.27**(npm `@opencode/cli`,effect/cli 重写,`serve --help` 自述 "Start the v2 API and web server")。

## 实施结果(先行摘要)

改动落在 `connector/connector/runtimes/opencode/`:`sdk/client.py`(整份重写为 V2 + 形状适配)、`provider.py`(探针改 `/api/info`)、`serve_process.py`(认证注入 + **数据目录隔离**)、`runtime.py`(prompt 链、turn 检测、pending 交互轮询、`location.directory`)、`provider_config.py`(apiKey 说明、移除 `/share`)。`tests/test_opencode_runtime.py` + `tests/test_opencode_serve_process.py` 按 V2 形状重写,`pytest` 161 passed / 3 skipped。

真机全链验证(隔离 serve + 真实 `local/qwen3.8-flash-next`)覆盖:health、会话清单/创建、`/model` `/agent` 切换、模型/agent/command 目录、permission 审批(创建 ask → pending → `reply_permission` → 清空)、form 提问(创建 → pending → 字段映射 → `reply_question` → 清空)、prompt admit、turn 执行(active 图 24 次 busy 采样 → 50.2s 检出 idle)、message 适配 → `timeline.map_messages_to_timeline`(user / system reasoning / assistant message 三项)、事件流映射、`interrupt`。

**部署面变化(必须知道)**:auto-start 的 serve 现在跑在自己的 opencode 数据目录(`~/.agents-anywhere/opencode-serve/<port>`),并从用户数据目录镜像 `auth.json` / `account.json`。原因见下「数据目录独占」;代价是**该 serve 的会话不出现在用户交互式 opencode(TUI/CLI)的会话列表里**,反之亦然——这是 2.x 下唯一可行的并存方式。

真机取证(2026-10-15,本机 4196/4199/4200/4202/4207 临时 serve 实例):

- V2 未知路由(含所有 1.x 路径,`/global/health`、`/session`、`/event` 等)返回 **200 + text/html SPA 兜底页**,不是 404/401 → 任何探测必须继续带 HTML 防御(`_is_html` 保留)。
- V2 真 API 全部在 **`/api/*` + HTTP Basic 默认启用**。`/openapi.json` 返回 401(`WWW-Authenticate: Basic`),带凭据 200,275 KB 完整 spec,142 operations。
- `OPENCODE_SERVER_PASSWORD`(默认 username `opencode`,可用 `OPENCODE_SERVER_USERNAME` 覆盖)在 2.0.27 仍被尊重:spawn 时注入即接受认证;未配置时 serve 使用自动生成的密码,**不存在无认证模式**。
- **数据目录独占(新增,也是最初「exited early (code=1)」的真正原因之一)**:2.0.27 启动时无条件独占打开 `<data>/log/opencode.log`(Windows 上 `EPERM`,`--print-logs` 也挡不住),并独占打开会话数据库。因此只要用户自己开着 opencode,任何新 serve 都在 ~1s 内以 code=1 退出;两个 serve 共用一个数据库则报 `attempt to write a readonly database`。二进制里没有可改日志/数据库路径的环境变量(`OPENCODE_TUI_CHANNEL` 只作用于 TUI,`OPENCODE_DB` 指向被占用路径必然失败),**数据目录是唯一开关**。

## 路由映射(1.x → V2)

| 1.x 路径 | V2 等价 | 语义差异 |
| --- | --- | --- |
| `GET /global/health` | `GET /api/info` | 返回 `{version, pid, urls, paths, capabilities{persistentPty}}`;可继续作为健康面 |
| `GET /session` | `GET /api/session` | 信封 `{data:[…], cursor{previous,next}}`;**分页存在**,`limit/order/cursor/search/directory/project/subpath` 查询,需翻页取全量否则库存同步误判会话删除 |
| `POST /session` | `POST /api/session` | body `{id?, parentID?, title?, agent?, model?, location{directory,subpath?}?, metadata?, permissions?}` → `{data}` |
| `GET /session/{id}` / `PATCH` | `/api/session/{id}`(GET/PATCH/**DELETE**) | `GET /{id}` **不带 `?directory=` 也能返回任意目录会话**(实探:不带参数 200)→ `directory` 参数需求逐路由重验 |
| `GET /session/{id}/message` | `GET /api/session/{id}/message` | 见「message 形状」;`limit/order/cursor/type` 分页参数 |
| `POST /session/{id}/prompt_async` | `POST /api/session/{id}/prompt` | **durable admit**:200 即入队(返回 `{data: Session.Inbox.User}`),异步执行;`additionalProperties:false`,旧 `{parts:[…]}` body 直接 400 |
| `POST /session/{id}/abort` | `POST /api/session/{id}/interrupt` | `{interrupted:bool}`;query `resume` |
| `POST /session/{id}/summarize` | `POST /api/session/{id}/compact` | 1.x 的 `/api/…/compact` 曾 503,V2 转正;body 未钉死(需实探) |
| `POST /api/session/{id}/model` | 路径不变 | body `{model:{id, providerID, variant?}}`,与旧形兼容 |
| `POST /session/{id}/command`、`GET /command` | `POST /api/session/{id}/command`、`GET /api/command` | 后者信封 `{location, data:[…]}` |
| `POST /session/{id}/permissions/{pid}` | `POST /api/session/{id}/permission/{requestID}/reply` | body `{response}` → **`{decision:"once"|"always"|"reject"}`**;另有 `GET …/permission`(列 pending) |
| `POST /api/session/{id}/question/{qid}/reply` | `POST /api/session/{id}/form/{formID}/reply` + `GET …/form` + `DELETE …/form/{formID}` | question 概念改名 **form**(`Form.Info/Reply`,body `{answer}`) |
| `GET /session/status`(busy/idle) | `GET /api/session/active` | busy 期间 `data:{ "<ses_…>":{"type":"running"} }`,空闲 `data:{}` → 判 busy 要认 `"running"` |
| `GET /session/{id}/fork` | `POST /api/session/{id}/fork` | `Session.ForkBoundary` |
| `POST /session/{id}/share` | **已删除** | 无等价,功能砍或找替代 |
| `GET /agent`、`GET /provider` | `GET /api/agent`、`GET /api/provider` | 信封 `{location, data:[…]}` |
| `GET /global/event` | `GET /api/event` | 见「事件流」 |

## 三个断代(逐条实探证实)

1. **Message 形状扁平化**。1.x:`{"info":{role,id,…}, "parts":[…]}`;V2:`Session.Message.Info` 顶层 type 联合——`user{id,time,text}`、`assistant{id,time,agent,model,content[],snapshot,finish,rawFinish,cost,tokens}`、`idle{id,time,outcome,error?}`、`model-switched` 等。**`session.idle` 等价信号在 message 清单里(`type:"idle"` 条目),事件流内是否仍有 idle 型事件未钉死。**
2. **Turn 驱动改为 durable admit + inbox**。prompt 入队即返回;`delivery: "steer"|"queue"` 原生插话/排队(替代 connector 侧排队消息自建逻辑);取消排队 = `PATCH/DELETE /api/session/{id}/inbox/{inboxID}`;turn 结束权威信号 = `session.step.ended`(带 `finish/tokens/cost` 摘要)。
3. **事件流 live-only、无 replay、无自动重连**(docs 明言;`Event.SeqEncoded`/`durable.seq/version` 暗示 seq 检测)。V2 帧形:`data: {id, created?, type, location?, data, durable?}`,type 为顶层键(实测 40 帧,含 `session.execution.started/step.started/reasoning.started/delta/ended/text.started/delta/ended/step.streamed/step.ended`、`session.inbox.enqueued/delivered` 等);**sessionID 位置三种混排**(`data.sessionID` 为主,部分顶层无,部分带 `location.directory`)。旧 `_handle_event`(吃 `{type, properties}` + 靠 `message.updated` 携带 turn id)整体失效。

## 设计决策(实施时逐条钉死)

- **D1 事件驱动 + 状态轮询双轨**:主通道 `GET /api/event` 消费 `session.*` 帧,`session.step.ended` 触发 `_finish_turn`(修「长 turn 30s 无 turnEnded」)+ 订阅 `session.inbox.enqueued/delivered`(修「排队消息无 turnEnded 挂死」);兜底把 `session_state` 权威判据换成 `GET /api/session/active`(2.5s 采样:busy=`{sid:{type:"running"}}`,idle=`{}`)+ `message.updated → 重取清单` 时**必须排空 pending 后复查**,防 mid-turn 清单误判 finished。
- **D2 认证注入**:auto-start 的 serve 由 connector **随机生成密码**注入 spawn env(`OPENCODE_SERVER_PASSWORD`),client 每请求带 `Authorization: Basic`(客户端机制 `api_user/api_key` 已存在);外部提供 serverUrl 时凭据走 `provider_config` 的 `apiUser/apiKey`。`/global/health` 类探针对 V2 serve 恒 HTML → 健康探测改 `GET /api/info`;401 = 可达但缺凭据(reason 给"authentication required")。
- **D3 目录模型**:V2 按 `Location.PublicRef{directory}` 作用域(事件带 `location.directory`;`/api/*` 多数收 `?directory=`/`location`)。`directory→project` 缓存、`_directory_for` 的 query 拼接保留,逐路由验证哪些要 query、哪些要 body 内 `location`。
- **D4 message 适配**:在 `sdk/client.py` 内把 V2 扁平清单适配回 `{info, parts}` 形状供 `timeline.map_messages_to_timeline` 消费,投影层暂不动;`client_version` 能力目录(`provider.py _V2_CAPABILITIES`)按 2.0.27 实测重钉。

## 分阶段实施

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| B1 | `sdk/client.py` V2 传输层 + `provider.py` 探针/凭据 + `serve_process.py` 认证注入 | 本地起 2.0.27 serve,23 条映射逐条真机核对;`ruff check` 过 |
| B2 | 事件链改造:`_event_loop`/`_handle_event`/watchdog/排队消息/审批 question→form | 4200 探针复跑:成功 turn 全链路(含 tool 调用 turn,本次未采到 `session.tool.*` 帧形,**实施时必补采**) |
| C | 测试重建:两 mock 套件按 V2 形状重写 + 真机冒烟 | `pytest -q` 全绿 |
| D | 文档/契约核对:`contracts/runtime-control/2.0` 手工核对、`docs/runtime-protocol/README` 链回本文、跨端能力清单是否变化 | `protocol:check` 两端 |

## 风险

- V2 事件流**无 replay**:重连窗口丢帧靠 `session.step.ended` 摘要 + 轮询 reconcile 补,`turn_id` 无法再取自事件(改从 `step.ended.assistantMessageID`/turn 锚点)。
- 无认证模式 = 部署面变化:桌面/移动端若直连 8192 端口或他人 serve,凭据分发机制必须先定。
- `session.tool.*` 帧形与 tool 审批触发未实测;`/api/session/{id}/view`(POST,`{idle}` 必填)用途未钉,可能取代自建 streaming 簿记。
- `GET /api/session` 分页 cursor 与 1.x "一次取全"假设冲突,库存同步(删失会话检测)需翻页策略。

## 实施补充:与设计不同的地方(实测结论)

- **turn 结束信号不用 `session.step.ended`**:单步 turn 下它与 idle 消息几乎同时到达,但一次 turn 可以有多个 step(`session.tool.*` 帧本次未采到),用它收尾会在多步 turn 中途结束平台 turn。改为**只认 active 图**:`_state_watchdog` 在有在飞 turn 时降到 `TURN_POLL_INTERVAL_S = 2.5s`,空闲时回到 20s;`_reconcile_active_turns` 一次全局查询覆盖所有候选会话(实测 turn end 落点 ≈ 2.5s 内)。
- **事件适配留在 client 层**:`sdk/client.py` 把 V2 帧翻译成 `{type, properties}`,`_handle_event` 与流式缓冲(part.delta / part.updated / message.updated)几乎原样保留。映射表:`session.execution.started → session.status busy`;`session.{text,reasoning}.delta → message.part.delta`(partID 合成 `<assistantMessageID>:<kind>:<ordinal>`);`session.{text,reasoning}.ended → message.part.updated`;`session.step.ended → message.updated`(带 `time.completed`,负责把流式项收成 done);`session.error → session.error`。合成 partID 与 message 适配器产出的 part id **同一套规则**,所以流式项与 turn 末快照描述同一个 item(实测快照 id `msg_x:reasoning:0` / `msg_x:text:0` 与流式一致)。
- **权限与提问改为轮询 pending 列表**:V2 没有 question 事件,form 也没有事件面。`_poll_pending_interactions` 在同一 watchdog tick 上比对 `GET /api/session/{id}/permission` 与 `GET /api/session/{id}/form`,新 id 复用 `_handle_permission_asked` / `_handle_question_asked`(form → question props 见 `_form_to_question_props`,字段取 `key`/`title`/`options[{value,label}]`),opencode 自己关掉的则 resolve 对应 notice。目标会话 = 在飞 turn ∪ 有未决 notice 的会话。
- **form 回复形状**:`Form.Field.type` 枚举是 `string|number|integer|boolean|multiselect|external`(**没有 `select`**),字段 id 键是 `key`(不是 `id`);`reply_question` 先 `GET …/form/{formID}` 取字段 key,再 `POST …/reply` 发 `{answer: {key: reply}}`。`reject` 是 `DELETE …/form/{formID}`。
- **prompt 前置切换**:V2 prompt body 不接受 model/agent(`additionalProperties:false`),所以 `prompt_async` 先 `POST /model`(204,body `{model:{id,providerID,variant?}}`)与 `POST /agent`(body `{agent}`),再 `POST /prompt` `{text, delivery:"steer"}`;附件从 `{type:"file",url,filename}` 映射到 `files:[{uri,name}]`。
- **`compact` 不再需要模型**:`POST /compact` body 只有 `{id?, delivery?}`,`_resolve_model_for_compact` 的前置校验保留但不再影响调用体;`fork` 的边界是 `{before}`;`revert` 是 stage(`{messageID}`)后 commit(**无 body**)。
- **`/share` 已下线**:2.x 无该路由,`/share` 从内置命令清单移除(菜单不再提供),API 直调返回 `unsupported`,不再落到 skills 端点报 400。
- **会话目录来自 `location.directory`**:session 记录没有扁平 `directory`;`_session_directory()` 同时认 `location.directory` 与旧的扁平键。session 创建时以 body `location:{directory}` 指定,之后按 session 路由不再需要 `directory` 参数。
- **认证**:auto-start 继承 `OPENCODE_SERVER_PASSWORD`,没有就生成随机密码注入 spawn env 并同步给 client;健康探针改 `GET /api/info`,401 → "authentication required",200 + HTML → "不是 V2 opencode"。
- **Basic 用户名固定为 `opencode`**(部署验证踩到):serve **忽略 `OPENCODE_SERVER_USERNAME`**(同一密码用 `lcl` 恒 401、用 `opencode` 才 200),所以 `SERVE_BASIC_USER` 在 spawn env 与 client 两侧都钉死;外部 serve 需要别的用户名时仍可用运行时配置 `apiUser`。
- **discovery 必须复用 auto-start 的密码**:`connector.server.client` 每 10s 跑一次 runtime 能力发现,走 `OpenCodeProvider.discover() → default_probe()`,那里没有 runtime 实例。生成的密码登记在 `serve_process.register_serve_credentials()`(按 server URL),`default_probe()` 依次取 配置 → 环境 → 登记值;否则健康 serve 会被报成 unavailable,客户端一直禁用发送按钮。
