<!-- tm_board_write · 2026-09-26T17:22:55.691Z · role=implementer · session=20260926-213919 -->
# OpenCode V2 接入 · P0 spike 实证报告（A1–A4 + 双入口 + 共存）
Read file D:\Github\Agents-Anywhere\.git\opencode-team\20260926-213919\opencode-p0\01-imp…提示: 先聚合再决定是否取原文（tm_fetch 分段取回）
> 环境：opencode-cli 2.0.18（C:\Users\34296\AppData\Roaming\ai.opencode.desktop\cli\2.0.18\opencode-cli.exe）；已安装类型定义 @opencode-ai/plugin@1.18.24 / @opencode-ai/sdk@1.18.24；用户 live service PID 9016（未杀、未占端口）。
取全文：tm_fetch { ref:"tm://runs/r-20260926-211547-d3213f/steps/s4599/result", access_token:"54a7c94586d240d8402073d4ada5a74a2d0281e6128a92daa2b9c7030af47ffe", mode:"structure" | "lines" }（过期 1791033349749 · 2026-10-03 13:15）
只要摘要就到此为止；需要具体行请用 mode:"lines" 分段取，不要为了看一眼把全文读回来。
## 0. 结论速览

| 假设 | 判定 | 一句话 |
|---|---|---|
| A1 事件枚举名与字段 | **已验证（名称层面）**，但与已安装类型定义完全同名 | event.subscribe 存在、返回 async iterable；**传 type 不过滤**；运行时有 27 种 session.*/shell.*/permission.* 名字，恰好都 0 命中类型定义 |
| A2 permission.reply 签名 / hook(evaluate) 语义 | **大部分已验证**（返回字符串能否改写 effect 未测） | hook(name, cb) 单参 payload，cb 结果被 Promise.resolve 包裹（可异步等待）；返回 undefined 时 effect 保持 ask、请求未被自动允许 |
| A3 rpc.register 作 TUI↔服务端通道 | **结构已验证，端到端未验证 + 通道假设不成立** | ctx.rpc 确是带 .register 的函数，caller 侧返回 per-method 可调用 + events.subscribe/on；但 **TUI 侧没有任何 rpc**（只有 api.client） |
| A4 热重载重放 hooks + dispose | **已验证（2 次）** | 写被 watch 的文件 → 旧实例 setup() 返回的 cleanup 被调用 → 新实例 setup 重放 |
| 双入口装载 | **服务端已验证；TUI 入口结构存在但本地路径未生效** | 项目 .opencode/plugins/ 自动发现 OK；cli.json 属 TUI 通道（不在 server 配置来源里），但本地绝对路径写进 cli.json.plugins 后 TUI 未初始化该模块 |
| 与现存插件共存 | **已验证（并发现 quota 在 2.0.18 已失效）** | team-mode 正常加载、我们的探针不干扰它们；@slkiser/opencode-quota 因 V1 形状被 V2 拒绝 |

## 1. 实验装置（可复核）

隔离手段（不碰用户配置，全部实测过）：

- OPENCODE_CONFIG_DIR 重定向配置目录 —— opencode debug paths 输出 config C:\...\aa-p0\cfg
- XDG_DATA_HOME / XDG_STATE_HOME / XDG_CACHE_HOME 重定向 data/state/cache/db —— 实测
- serve --stdio --port 0  与  run --standalone  → 私有 server，**不与 PID 9016 冲突**
- 探针装载：项目级 .opencode/plugins/<name>/index.js **自动发现**（无需任何配置项）

关键命令：

    & $cli run --standalone --print-logs --log-level info --auto --agent build "<msg>"      # run1.log
    & $cli run --standalone --print-logs --log-level info --agent build \
            --model deepseek/deepseek-flash --title aa-p0-perm2 "<msg>"                       # perm2.out（2 次极短提示）
    & $cli --standalone --print-logs --log-level debug <projdir>                              # tui-run.log / tui-run2.out

宿主日志（只读）：C:\Users\34296\.local\share\opencode\log\opencode.log

## 2. 模块契约（由宿主错误信息实证，非文档）

export default 必须是**对象** { id, effect|setup }：

    level=WARN msg="failed to load plugin" target="...\aa-p0-probe"
    cause="PluginModule.LoadError: Plugin must export a default definition with an id and an
           effect or setup function. (cause: SchemaError(Expected object at [\"default\"]))"

- V1 形状 export const X = async (input) => ({ event, "permission.ask", ... })（= @opencode-ai/plugin 主入口 dist/index.d.ts 的 Plugin/Hooks）在 V2 宿主上**加载失败**。
- 同一错误在用户已装插件上复现：target=@slkiser/opencode-quota@latest ... Missing key at ["default"]["effect"] / ["default"]["setup"] → **quota 目前在 2.0.18 上是坏的**（与探针无关）。

## 3. A1 — 事件

### 3.1 运行时 ctx 实况（pid 9016，setup(ctx) 第一参）

    {"where":"setup.ctxKeys","keys":["app","location","options","agent","aisdk","command","event",
     "experimental","generate","model","provider","integration","mcp","permission","plugin",
     "reference","rpc","skill","storage","tool","vcs","websearch","worktree","session","shell"]}

capabilities：ctx.event.subscribe=function、ctx.event.on=undefined、ctx.permission.hook=function、ctx.permission.reply=function、
ctx.rpc=function、ctx.rpc.register=function、ctx.session.list=undefined、ctx.client=undefined、ctx.storage=object、arg1=undefined。

> 与已安装类型 @opencode-ai/plugin@1.18.24 的 PluginContext（只有 agent/aisdk/catalog/command/integration/plugin/reference/skill）差距巨大 → **类型定义落后于宿主运行时，不能作为 P0 判据**。

### 3.2 subscribe 语义（本次 spike 最关键的负结果）

- ctx.event.subscribe()（无参）= **全量流**；返回 **async iterable**（isAsyncIterable:true，不是 effect Stream）。
- ctx.event.subscribe("<type>") **不过滤**：session.tool.success 被下面 7 个订阅**都**收到：
      undefined, session.created, session.idle, session.status, session.error, session.next.prompted, session.next.agent.switched
  → **必须插件侧按 event.type 过滤**（是否支持 predicate 形式的参数未知）。
- 事件信封：{id, created, type, durable?{aggregateID,seq,version}, location{directory,workspaceID}, data}
- **流是跨 location 全局的**：探针绑在 temp proj location，却收到 location.directory="D:\\Github\\Agents-Anywhere" 的事件 → **投影必须先按 event.location.directory 过滤**。

### 3.3 实测事件清单（受控运行 perm2，27 种；type → data 关键字段）

    session.step.started         agent, assistantMessageID, model, sessionID, started
    session.step.streamed        assistantMessageID, sessionID
    session.step.ended           assistantMessageID, cost, files, finish, rawFinish, sessionID, snapshot, tokens
    session.step.failed          assistantMessageID, cost, error, rawFinish, sessionID, tokens
    session.usage.updated        cost, sessionID, tokens
    session.reasoning.started    assistantMessageID, ordinal, sessionID, state
    session.reasoning.delta      assistantMessageID, delta, ordinal, sessionID
    session.text.started         assistantMessageID, ordinal, sessionID
    session.tool.input.started   assistantMessageID, id, name, sessionID
    session.tool.input.ended     assistantMessageID, id, sessionID, text
    session.tool.called          assistantMessageID, executed, id, input, sessionID
    session.tool.progress        assistantMessageID, id, metadata, sessionID
    session.tool.success         assistantMessageID, content, executed, id, metadata, sessionID
    session.tool.failed          assistantMessageID, error, executed, id, sessionID
    permission.asked             action, id, resources, save, sessionID, source
    permission.replied           reply, requestID, sessionID
    session.execution.started    sessionID
    session.execution.interrupted reason, sessionID
    session.inbox.enqueued       inboxID, item, sessionID
    session.inbox.delivered      inboxID, sessionID
    session.instructions.updated delta, sessionID
    session.created / session.idle / session.status / session.error / session.deleted
    shell.created(info) / shell.exited(exit,id,status) / shell.deleted(id)
    provider.updated / model.updated / agent.updated / command.updated / skill.updated /
    reference.updated / integration.updated / plugin.updated / websearch.updated / models-dev.refreshed  (data={})

durable:{aggregateID,seq,version} 只出现在可持久化的 session 事件上（如 session.tool.called），可用于 checkpoint（§2.6）。

### 3.4 类型定义**不可用于**事件枚举（量化证据）

| 运行时实际类型 | sdk/dist/v2/gen/types.gen.d.ts | sdk/dist/gen/types.gen.d.ts |
|---|---|---|
| session.step.started / session.step.ended | 0 | 0 |
| session.tool.called / session.tool.success | 0 | 0 |
| session.reasoning.delta / shell.exited | 0 | 0 |
| message.updated | 3 | 1 |
| permission.asked | 3 | 0 |

→ 类型里的 session.next.* 家族与运行时**不同名**；message.updated 只在类型里、实测窗口未见发射。

## 4. A2 — 权限

- ctx.permission keys = [hook, list, get, reply]；hook(pe,Ae) 内部 permission.hook(pe,(be)=>ne(()=>Promise.resolve(Ae(be))))
  → **回调返回值被 Promise.resolve 包裹 ⇒ 支持异步等待外部决定**；注册返回 {dispose}（Registration）。
- **hook 名不校验**：evaluate / ask / before / permission.ask 四个名字注册**全部成功**返回 {dispose} → 不能用「注册成功」判断名字有效。
- evaluate **实测触发**（cfg2 设 permission.bash=ask，headless run）：

    {"where":"permission.hook.evaluate.fired",
     "reqKeys":["sessionID","agent","action","resources","metadata","source","effect"],
     "req":{"sessionID":"ses_f21...","agent":"build","action":"shell","resources":"[array 1]",
            "source":{"type":"tool","messageID":"msg_...","id":"call_..."},"effect":"ask"}}

  - 只有**一个** payload 参数（无独立 output）；effect 在**输入**里。
  - 返回 undefined 后：permission.asked 事件发出、请求未被自动允许、随后 permission.replied → **undefined = 不改 effect（行为上成立）**。
  - **未测**：返回 allow/deny 字符串能否改写 effect（该 spike 不冒险自动放行）。
- ctx.permission.reply：单对象入参，形状即 SDK 生成路由：
      { path:{requestID:string}, body:{ reply:"once"|"always"|"reject", message?:string }, query?:{directory?,workspace?} }
  （PermissionReplyData 在 sdk/dist/v2/gen/types.gen.d.ts:7903；PermissionV2Reply = "once"|"always"|"reject" 在 :2463）
- PermissionRequest = {id, sessionID, permission, patterns[], metadata, always[], tool?{messageID,callID}}（:2029）

## 5. A3 — rpc

- ctx.rpc 是**函数**、带 .register（arity 1），源码形状：
      ctx.rpc(spec) => Object.assign(Object.fromEntries(Object.keys(spec.methods).map(m=>[m,(args,{signal})=>...])), {events:{subscribe, on}})
  → caller 侧逐方法可调用 + 反向事件通道；register 注册 callee 侧 spec。**register 存在且可调用（结构已验证）**。
- **但 TUI 侧没有 rpc**：@opencode-ai/plugin/dist/tui.d.ts 的 TuiPluginApi = {app, attention, command?, keys, keymap, mode, route, ui, tuiConfig, kv, state, client, event, renderer, slots, plugins, lifecycle} —— 无 rpc；全 dist 内 rpc 只此一处。
- ⇒「rpc.register 作 **TUI↔服务端**通道」**不成立**；TUI→服务端可用通道是 api.client（完整 OpencodeClient）与 api.event（TuiEventBus.on(type,handler)）。
- rpc.register 的真正对端（另一 server 插件实例？HTTP 路由？）**未验证** —— 需 P1 实测。

## 6. A4 — 热重载

时间线（同一进程 pid 9016，探针自带随机 inst 标签）：

    17:17:54.976  setup.invoked                       (v2 形态开始)
    17:18:54.611  setup.returned-cleanup.called      <- 旧实例 cleanup 被调用
    17:18:54.614  setup.invoked  inst=xuhfbu         <- 新实例 setup 重放
    17:19:42.062  setup.returned-cleanup.called      <- 第二次（我 edit 文件）
    17:19:42.103  setup.invoked  inst=4d3e2u

- 宿主为**每个插件文件**建 watcher：watcher subscribe path="...\aa-p0-probe\index.js" type=file；另加 .opencode 目录 watcher（ignores=3）。
- ⇒ **重载会重放 setup() 且旧实例的 cleanup 被调用**（setup() 的返回值被当作清理函数）。
- 注意：msg="loading plugin" 会在同一 run 内重复出现但**不一定**伴随 setup 重放 → 不能只看该行判断重载。

## 7. 双入口

- **服务端入口（已验证）**：项目 .opencode/plugins/<dir>/index.js 自动发现，日志：

    msg="loading plugin" id="C:\...\aa-p0\proj\.opencode\plugins\aa-p0-probe"
      entrypoint=file:///C:/Users/34296/AppData/Local/Temp/opencode/aa-p0/proj/.opencode/plugins/aa-p0-probe/index.js role=server

- opencode debug config 的配置来源**不含 cli.json**：只有 opencode.json、opencode.jsonc、config 目录、项目 .opencode/。
- 日志有 message="migrated cli config" from=[tui.json, kv.json] to=...cli.json → cli.json = V1 tui.json 的继任者（TUI 通道）。
- **TUI 侧确有插件通道**：隔离运行 TUI 时日志出现 role=cli message="plugin reconciliation started/completed" component=plugin plugins=12（多次）。
- **但本地路径未生效**：cfg/cli.json 写 {"plugins":["C:\\...\\aa-p0\\tuiplug"]} 后，两次 TUI 启动（隔离 config/data/state），tui.log **从未生成**，plugins=12 数量不变
  → **cli.json 装载本地文件路径：未能实证**。静态上 TuiPluginModule={id?,tui,server?:never}、TuiPluginStatus.source:"file"|"npm"|"internal" 说明文件型 TUI 插件在设计上存在，怀疑是 **spec 形式**问题（或许只接受 npm spec / 需 package.json 包装 / 需 opencode plugin add）。

## 8. 与现存插件共存

三次真实加载（run1/run2/perm2）都出现**按序独立加载、错误互不影响**：

    msg="loading plugin" id="...proj\.opencode\plugins\aa-p0-probe" entrypoint=file:///...        -> OK
    msg="loading plugin" id=@slkiser/opencode-quota@latest entrypoint=file:///C:/Users/34296/.cache/opencode/npm/@slkiser/opencode-quota@latest/.../dist/index.js
      -> WARN failed to load plugin ... PluginModule.LoadError: Missing key at ["default"]["effect"] ["default"]["setup"]
    msg="loading plugin" id=@te-river/opencode-team-mode@latest entrypoint=file:///C:/Users/34296/node_modules/@te-river/opencode-team-mode/dist/index.js -> OK（打印面板）

- 结论：探针**不影响**它们（team-mode 正常启动），也不因它们失败（逐插件隔离错误）。
- **顺带发现（对用户有价值）**：@slkiser/opencode-quota@latest 在 V2 2.0.18 上**加载失败**（V1 形状）；cli.json 里的 @te-river/opencode-alibabatokenplan@latest 属 TUI 通道，未验证。

## 9. 对设计文档的影响

### §2.5 事件→timeline 投影映射表：**整表需重写**

- 源列改用第 3.3 节实测名：
  - 用户 prompt 行 → session.next.prompted / session.inbox.enqueued（+ session.execution.started）
  - assistant 文本行 → session.text.started / session.text.delta / session.text.ended（+ session.step.streamed）
  - reasoning 行 → session.reasoning.started / session.reasoning.delta（data 内含 ordinal/state）
- 「tool execute.before/after hook」行：V2 **已无** tool.execute.* hook（那是 V1 Hooks），改为事件 session.tool.input.started / input.ended / called / progress / success / failed；called 里的 executed 字段可区分「仅生成未执行」。
- 「permission evaluate hook / 请求事件」行：hook 侧保留（已实测可用），事件侧补 permission.asked / permission.replied。
- 「会话开始/结束」行：改为 session.execution.started / session.execution.interrupted / session.step.started / step.ended / step.failed；结束态用 session.idle / session.error / execution.interrupted。
- 表下「P0 spike 逐项核对」注释：已核对，**结论是「类型定义不可信、以运行时刻为准」**。
- **需新增一行**：投递模型 = 单次 ctx.event.subscribe()（全量）+ 插件侧按 type 与 location.directory 双重过滤（原表假设 per-type subscribe 可靠投递，实测不成立）。

### §2.3 JSON-RPC 方法表：**3 行需改**

- session.list 行：TUI 对账通道从 ctx.rpc 改为 **TUI 侧 api.client（HTTP SDK）**（ctx.rpc 在 TUI 侧不存在）。
- session.getSnapshot 行：注明投影输入 = §2.5 重写后的实测事件集；durable.seq 可作检查点序号。
- session.steerTurn 行：维持 capability=false 待测（ctx.session 有 create/get/prompt/interrupt/update/move/wait/switchModel/switchAgent/context/generate/command/synthetic，**无 steer、无 list**）。

### §2.4 两条通道分工：**结论保留、通道名改**

- 「server ctx 无 session.list」：**实测成立**。
- 「TUI 数据层有 session.list/get/status/cost/hierarchy、message.list、permission.list、form.reply」：实际是 api.state.session.{get,messages,status,permission,todo,diff,count} + api.client（HTTP，含 session.list、permission.reply）。**form.reply 在 TUI API 里不存在**，需按 api.client 路由重写。

### §4 插件包结构 / §4.1 共存防御

- 包结构：Plugin.define({id, async setup(ctx){}}) → 明确写成 **export default { id, async setup(ctx){} }（对象，非函数）**；TUI 入口是 export default { id, tui }（类型已证，未实测装载）。
- §4.1 第 1 条（绝不抛错出链）：hook 链抛错**未测**，仍为设计假设。
- §4.1 第 5 条（审批 hook 中立）：**已获实测支撑**（undefined = 不改 effect）；建议补一句「返回字符串改写 effect 未验证，P1 先证再用于远端放行/拒绝」。
- §4.1 建议新增：**事件必须先按 location.directory 过滤**（流跨 location 全局，实测）。
- §4.2 热重载：**成立**（setup 重放 + cleanup 被调用），可从假设升级为事实。

### §8.3 假设清单

- A1：方法保留，但**必须加一句「不得以类型定义核对」**（量化：6 个实测类型名在 v1/v2 types 中 0 命中）。
- A2：改为「读**运行时** ctx 实测」（类型定义 1.18.24 不含 ctx.permission/ctx.event/ctx.rpc）+ 实测 hook 触发。
- A3：判定改为**「结构存在、TUI↔服务端通道不成立（TUI 侧无 rpc）」** → 设计改走 api.client HTTP；rpc 对端待 P1 确认。
- A4：升级为**已验证**（cleanup + 重放，2 次）。
- 建议新增 A10：cli.json 装载本地路径/包形态（本次未通过）。

## 10. 侧效应 / 清理

- **未改**仓库（D:\Github\Agents-Anywhere）与用户配置（C:\Users\34296\.config\opencode\* 全程只读）。
- 我启动的进程：PID 6372 / 10220（TUI 首测）、13680（perm2）、17796（tui2）→ **全部已关闭**；用户原 PID 9016 **存活未动**（末次核验：remaining opencode-cli pids: 9016）。
- 副作用（如实报告）：opencode debug paths/config 与探针运行使**用户 live service(9016) 为 temp location 加载了探针插件**；已把探针改写为 no-op 触发重载使其静默，探针文件保留在 temp 目录（可随时删除）。
- 成本：**2 次极短提示**（deepseek-flash，各约 50 token）；另 1 次因参数错误未产生模型调用。
- 证据文件（均在 C:\Users\34296\AppData\Local\Temp\opencode\aa-p0\）：probe.log（live service 全量 ctx 域 dump + 事件观测）、probe-perm.log、probe-perm2.log（受控 run + evaluate hook 证据）、run1.log、perm2.out、tui-run.log、tui-run2.out（TUI 侧 plugin reconciliation）、cfg/cli.json（TUI 通道实验）、cfg2/opencode.jsonc（permission.bash=ask 实验）、proj/.opencode/plugins/aa-p0-probe/index.js、tuiplug/index.js。
