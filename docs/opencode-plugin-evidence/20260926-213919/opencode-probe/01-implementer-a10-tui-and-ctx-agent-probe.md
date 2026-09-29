<!-- tm_board_write · 2026-09-26T19:54:16.112Z · role=implementer · session=20260926-213919 -->
# OpenCode 2.0.18 隔离实测报告 — A10 TUI 装载形态 + ctx.agent 能力dump

探针：`C:\Users\34296\AppData\Local\Temp\opencode\aa-probe-agent\`（临时目录，仓库只读）
隔离：`OPENCODE_CONFIG_DIR`/`XDG_DATA_HOME`/`XDG_STATE_HOME`/`XDG_CACHE_HOME`/`HOME` 全部重定向；端口 49401；CLI `opencode-cli.exe` 2.0.18；未触碰 PID 9016、未改用户配置。

## A10 — 装载形态判定（逐形态 + 原始证据）

宿主解析器（二进制反编译，决定一切）：
```js
function U0(r){ let n=(t)=>{for(let o of t){let i=r.name?[r.name,o].filter(Boolean).join("/"):s.resolve(r.directory,o||"index");
  try{return R0(i,r.directory)}catch(e){ if(!ENOENT... ) throw e }} return};
  return { server:n(["server",""]), tui:n(["tui"]), rpc:n(["rpc"]) } }
```
→ **目录形态只找 `<dir>/tui`（tui.ts / tui/index.ts），完全不读 package.json 的 `exports["./tui"]`**；只有 **package 形态**（`U0({name,directory})`）才经 `<name>/tui` 消费 `exports["./tui"]`。这正是 P0 用 `tuiplug/index.js` 失败的原因：解析出 `server=index.js, tui=undefined`。

| 形态 | 结果 | 原始证据 |
|---|---|---|
| ① cli.json plugins=本地目录 | **失败** | 无任何 `loading plugin` 行（该文件未被读入注册表） |
| ①‘ opencode.json plugins=本地绝对目录 | **成功** | `msg="loading plugin" id="...\cliplug" entrypoint=file:///.../cliplug/index.ts role=server` + `setup.invoked tag='cliplug' role=server` |
| ② npm/Git 规格 | **未验证**（离线） | `plugin add "@aa/probe-plugin"` → `NpmInstallFailedError`（包未发布/无网）；机制=install→`U0({name,directory})`→`exports["./tui"]` |
| ③ opencode plugin add | **仅接受 npm/Git** | 本地路径与 `file:` 规格均报：`Error: Plugin target must be an npm registry package or Git package specifier` |
| ④ 项目 .opencode/plugins/<dir>/ | **成功** | `msg="loading plugin" id="...\proj\.opencode\plugins\aa-probe" entrypoint=file:///.../aa-probe/index.ts role=server` |

注册表（GET /api/plugin，Basic opencode:<pw>）确认 features：
```json
{"id":"aa-probe-server","source":{"type":"local","path":"...\proj\.opencode\plugins\aa-probe\index.ts"},"features":{"server":true,"tui":true},"state":{"status":"active"}}
{"id":"aa-cliplug-server","source":{"type":"local","path":"...\cliplug\index.ts"},"features":{"server":true,"tui":true},"state":{"status":"active"}}
```
→ 只要目录里有 `tui.ts` 兄弟文件，宿主即标记 **`tui:true`**。

TUI 进程（role=cli）本沙箱**无法启动**：`opencode mini` → `Error: opencode mini requires a TTY stdout`（shell 无 TTY，无 winpty/conpty）。但 TUI 侧装载器确实存在，用户在运行的桌面 App 日志有：
`timestamp=... message="plugin reconciliation started" component=plugin id=1 role=cli`（该 log 共 679 行 role=cli）。

V2 TUI 模块契约（二进制 `xCt` 校验器）：
```js
t => typeof t==="object" && t!==null && typeof t.id==="string" && t.id.length>0 && typeof t.setup==="function"
```
→ TUI 入口必须 `export default { id, setup(ctx) }`；仓库现有的 `{id, tui(api)}` **不满足该校验**（会抛 `Invalid V2 TUI plugin module`）。TUI ctx 由 `bK()` 构建：`{options,location,app:{version,channel},renderer,client,data,attention,theme,...}`，扩展面是 routes/slots/markdown。

## ctx.agent — 可用性结论（服务端 ctx，2.0.18）

```
AGENT typeof=object methods=[ get, list, transform, reload ]   （4 个全是 function）
AGENTMEM get=function  list=function  reload=function  transform=function
DRAFT keys=[ list, get, default, update, remove ] types={ 全 function }
DRAFTLIST isArray=True len=7
```
- `ctx.agent.list()` → **对象** `{location:{directory,workspaceID,project}, data:[...7 个 agent]}`（非数组）。
- `ctx.agent.transform(cb)` 回调拿到的 draft：`{ list(), get(id), default(id?), update(id,fn), remove(id) }`；`draft.list()` 返回**数组(7)**。
- agent 项形状：`{ id, name, description?, system?, request:{settings,headers,body}, mode:"primary"|"subagent", hidden:bool, permissions:[{action,resource,effect}] }`
  例：`{"id":"build","name":"Build","mode":"primary","hidden":false,...}`；`{"id":"compaction",...,"hidden":true}`；`{"id":"general","mode":"subagent"}`
- HTTP 等价路径：`GET /api/agent`、`GET /api/agent/{agentID}`。

## ctx 全域名与方法名 dump（存在性 typeof，服务端 ctx）
```
app        {name:string, version:string, channel:string}
location   {directory:string, workspaceID:undefined, project:object}
options    {}
agent      {get:fn, list:fn, transform:fn, reload:fn}
aisdk      {hook:fn}
command    {list:fn, transform:fn, reload:fn}
event      {subscribe:fn}
experimental / generate / model / provider / integration / plugin / reference / skill / storage / vcs / websearch / worktree   （对象，未逐个展开）
mcp        {list:fn, transform:fn, reload:fn}
permission {hook:fn, list:fn, get:fn, reply:fn}
rpc        function
session    {hook,create,get,switchAgent,switchModel,prompt,generate,command,synthetic,interrupt,update,move,wait,context} 全 fn
shell      {hook:fn}
tool       {reload:fn, list:fn, transform:fn, hook:fn}
ABSENT: config, project, workspace, ui, attention, kv, keymap, lifecycle, client, renderer, data, lsp
```
（顶域键序：app,location,options,agent,aisdk,command,event,experimental,generate,model,provider,integration,mcp,permission,plugin,reference,rpc,skill,storage,tool,vcs,websearch,worktree,session,shell）

## 对实现路径的建议
- **agent 目录：走 `ctx.agent`（进程内），不要走 HTTP。** `draft.list()` 已直接给出 `id/mode/hidden/description/permissions`，无需 auth/端口；`ctx.agent.list()` 作为只读快照亦可。HTTP `/api/agent` 仅作兜底。
- **TUI：** 采用 **形态④ 项目 `.opencode/plugins/<dir>/`**（已实证 role=server + features.tui=true），并**在目录里放 `tui.ts`（或 `tui/index.ts`）**——目录形态不读 `exports["./tui"]`，仓库现布局 `src/tui/index.ts` 需加一个顶层 `tui.ts` shim。模块须改为 `export default { id, setup }`（现为 `{id,tui}`，会被 `xCt` 判非法）。若走 npm 发布形态，则保留 `exports["./tui"]` 即可被 `<name>/tui` 解析。**cli.json 不是插件配置载体，勿再用。**
