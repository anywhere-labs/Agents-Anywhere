# OpenCode 插件 验证记录

本文件记录 `@agents-anywhere/opencode-plugin` 与 Connector 侧 OpenCode runtime 的验证状态。行为与假设的权威说明见 [README](./README.md)。

> 基线：宿主 **opencode-cli 2.0.18**（Windows）。事实来源为隔离实测报告（`opencode-p0`、`opencode-dist`、`opencode-probe`、`opencode-subagent`、`opencode-audit`）与仓库源码。凡未实跑的结论一律标「未验证 / 被阻塞」并附原因，不以「结构存在」冒充「已跑通」。

> **引用前缀换算**：本文所有 `opencode-<task>/<NN>-<role>-<topic>.md` 形式的引用，原写作
> `.git/opencode-team/20260926-213919/opencode-<task>/…`。那批报告原先只存在于 `.git/` 下（不受版本控制），
> 2026-09-27 与 8 个未推送提交一起被一次误删毁掉；现已恢复到**受版本控制**的
> [`evidence/20260926-213919/`](./evidence/20260926-213919/)，逐份出处与可信度分级见
> [RECOVERY.md](./evidence/20260926-213919/RECOVERY.md)。旧路径不再存在，遇到请按此换算。

> 形态决策（把 OpenCode 接入改为 Agents Anywhere 侧对端中转）的实测判据集中在
> [`docs/opencode-server-surface.md`](../opencode-server-surface.md)：
> 服务发现（`service.json` + `GET /api/info` + Basic）、location 用 `?directory=` 而非请求头、
> 会话与子会话可全量枚举（本目录 83 条 / 76 条带 `parentID`）、目录面（91 个插件含 `failed` 态、
> 79 个模型含跨 provider 重复 `id`、16 个 skill、13 个 agent 含 7 个 subagent）、事件词表
> （`session.execution.*` / `session.child.*` / `mcp.status.changed`），以及 4 条未证项。
> 本文继续作为**插件形态**的验证台账。

## 一、自动化检查（本地已执行）

| 范围 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| 插件单元 + 集成测试 | `cd opencode-plugin; corepack yarn test` | `tests 231 · pass 229 · fail 0 · skipped 2`（EXIT=0） | `tsx --test tests/unit/*.test.ts tests/integration/*.test.ts`；本轮「默认浏览器加固」实跑 |
| 插件类型检查 | `cd opencode-plugin; corepack yarn typecheck` | 通过（`EXIT=0`，四套 tsconfig 含 `tsconfig.tests.json`） | 「版本门 + 测试接入」任务实跑；该任务同时修掉 5 文件 7 处既有类型错误 |
| 打包漂移门 | `cd opencode-plugin; corepack yarn check:build` | 通过（重打包 + 重建后逐字节比对 `lib/` 一致） | 同上；另有一次负例验证（给 `lib/index.js` 追加 1 字节 → FAIL） |
| 插件全链检查 | `cd opencode-plugin; corepack yarn check` | 通过（`typecheck → check:build → build → test` 全绿，EXIT=0） | 「默认浏览器加固」本轮实跑；改 `src/` 后须先 `yarn build` 刷新 `lib/`，否则 `check:build` 报漂移 |
| Connector OpenCode runtime | `cd connector; uv run pytest tests/test_opencode_provider.py tests/test_opencode_bridge_client.py tests/test_opencode_live_transport.py -q` | `36 passed in 4.70s` | `opencode-p2/03-implementer-fix-rev3.md:36` |
| Connector 全量 | `cd connector; uv run pytest tests -q` | `23 failed, 853 passed, 3 skipped` | `opencode-p2/03:42`；失败集与基线逐条一致、无新增（Windows symlink/chmod、codex/claude 二进制属环境性） |
| Server（OpenCode 相关） | `uv run --with tzdata pytest tests/test_auth.py tests/test_plugin_device_code.py tests/test_admin_dashboard.py -q` | `71 passed in 38.22s` | `opencode-p5/01-implementer-server-web-implementation.md:60` |

> 注：上表「插件全链检查」由 `yarn check` 一次覆盖 `typecheck → check:build → build → test`，**已实跑通过**（`EXIT=0`）。若在**干净 checkout** 上复跑，需先 `corepack yarn install`；`check:build` 需要完整仓库布局（`../connector` 与 `src/` 均在）。README「本地构建与安装」给出完整命令。

> 注（A10 TUI 面收尾轮，实测快照）：本轮 `corepack yarn typecheck` 报 **1 处错误**，`corepack yarn test` 报 `tests 264 · pass 257 · fail 5`——**全部落在 `src/server/onboarding.ts` 与其测试 `tests/unit/onboarding-env.test.ts`**（另有并行任务正在改这些文件，属在飞状态，**非 TUI 回归**）：tsc 唯一错误 `src/server/onboarding.ts:556 TS18047: 'gate' is possibly 'null'`；5 个失败全为 `onboarding-env.test.ts` 的 Connector 复用/能力判定用例。TUI 自身零回归：`npx tsc -p tsconfig.tui.json` 的唯一输出即上述同一 server 错误（`src/tui/**` 自身无错误）；`tests/unit/tui-commands.test.ts` + `tui-entry-shim.test.ts` = **13 passed / 0 fail**；`corepack yarn build` 与 `corepack yarn check:build` 均通过（`EXIT=0`）。

> 注（构建漂移轮，实测快照）：真机上「服务端 available 永远停在 `starting`」的**直接原因是构建漂移**，不是上一轮记的「`duplicate model id` 毒消息卡住通知泵」——`connector/connector/runtimes/opencode/runtime.py` 在 11:22 拿到 events 分支的 `runtime_health_update("running")`，但之后没再跑 `yarn build`，`lib/connector/` 里跑的那份副本仍只有 `else` 分支（全包只有 1 处该调用；重建后为 2 处）。上一轮据以宣布「新代码确实进了包」的那条 `Select-String` 命中的正是 `else` 分支的旧行 —— **判据没验过就用，比没证据更糟**。同轮 `corepack yarn check` 实跑：`EXIT=0`，`tests 319 · pass 317 · fail 0 · skipped 2`。改 `../connector` 之后同样必须先 `yarn build`，否则 `check:build` 会报漂移（这条门是有效的，本轮就是被它抓住的）。

### 宿主 HTTP 面（`opencode serve`）——判定"能不能不写插件"用

只读实测，用隔离配置与数据目录，不碰用户 `~/.config/opencode`、不建真实凭据、不打模型：

```bash
CLI="$LOCALAPPDATA/Programs/@opencode-aidesktop/resources/opencode-cli.exe"   # opencode v2.0.18
ROOT=/tmp/aa-serve-probe; PROJ="$ROOT/proj"; PORT=14098
mkdir -p "$ROOT"/{config,data,state,cache} "$PROJ"; cd "$PROJ"
OPENCODE_CONFIG_DIR="$ROOT/config" XDG_DATA_HOME="$ROOT/data" \
XDG_STATE_HOME="$ROOT/state" XDG_CACHE_HOME="$ROOT/cache" \
  "$CLI" serve --port "$PORT" > "$ROOT/serve.log" 2>&1 &
PW=$(sed -n 's/.*server password //p' "$ROOT/serve.log" | head -1)         # 启动即打印
DIRH="x-opencode-directory: $(node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$PROJ")"
curl -s -u "opencode:$PW" -H "$DIRH" "http://127.0.0.1:$PORT/api/session" | head -c 200
curl -s -u "opencode:$PW" -H "$DIRH" "http://127.0.0.1:$PORT/api/model" | head -c 200
# 路由存在性逐个取码（404 = 不存在）：/api/session/{id}/children /api/doc /api/health /api/question/request
# 子会话归属：POST /api/session {"title":..,"parentID":..} 后回读列表与详情，看 parentID 是否出现
```

**判据自身的坑**：不带 `x-opencode-directory` 时**每一条路径**都返回 `200 + Web UI 的 HTML`，包括 `/api/health`。用它测"路由在不在"必然得出"全都在"的错误结论——必须先看 `content-type` 是不是 JSON。

## 二、已验证项（附证据）

| 项 | 证据 |
| --- | --- |
| 服务端插件装载（file / 目录源 + 项目自动发现） | `opencode-dist/02` §2 矩阵 Z4/Z5/Z9：`msg="loading plugin" … entrypoint=…/index.ts role=server` 且发布端点；Z1/Z7 证明目录态只认根 `index.*`、**不读 `exports`** |
| 目录态与包态两条装载路径并存 | `dist/02` §0/§3；根 `opencode-plugin/index.ts`、`tui.ts` shim 引用 `./src/...` 而非 `lib/`，产物缺失时不静默失载 |
| TUI 模块契约 `{ id, setup }` | `opencode-probe/01` §A10：宿主 `xCt` 校验器要求 `typeof t==="object" && … typeof t.setup==="function"`；旧 `{ id, tui(api) }` 判 `Invalid V2 TUI plugin module` |
| **全量 TUI 会装载本模块** | `opencode-tui-pty/01` §3：裸 `opencode --standalone` 下 `tui-probe.log` = `module-evaluated` + `setup-called`；把副本 `tui.ts` 改名后重跑 → 探测日志**零输出**（归因确认） |
| **`opencode mini` 不加载 TUI 插件** | `opencode-tui-pty/01` §3：`mini` 下 `tui-probe.log` 零输出，且无任何 role=cli 插件 reconcile 行 |
| **TUI 真实 ctx 面清单（13 键）** | `opencode-tui-pty/01` §4：`options, location, app, renderer, client, data, attention, theme, themeMode, markdown, keymap, storage, ui` |
| **TUI 不支持命令注册** | `opencode-tui-pty/01` §4/§5：`keymap` = `layer, dispatch, shortcuts, commands, pending, active, mode`（**无 `registerLayer`**）；`command` 键**整个不存在**；`ui` = `dialog, toast, format, router, panel, tabs, model, slot`（**无 `DialogAlert`/`DialogPrompt`**）。故 `describeSurfaces`=`['ui','attention']`、`registerCommands`=`'none'`，`/` 面板无 `/aa`（§5） |
| TUI 只作**状态提示**（`ui.toast` + 可选 `attention.notify`） | `src/tui/index.ts:announceStatus/describeSurfaces/registerCommandLayer`；`tests/unit/tui-commands.test.ts`：`announceStatus()` toast 文案含「已加载/未登录/`/aa-login`」（13 tests pass） |
| **已删的面调用**（`registerLayer`/`command.register`/`DialogAlert`/`DialogPrompt`） | `tests/unit/tui-commands.test.ts`「REGRESSION: removed surfaces (registerLayer / command.register / dialogs) are never called」：在 A10 真实 ctx + 三处 tripwire 下跑完 setup + 全部命令 + `announceStatus` + `dispose`，`forbidden` 恒为 `[]` |
| 命令注册仅在 `keymap.layer` 是函数时尝试、否则静默 `none` | `tests/unit/tui-commands.test.ts`「command registration uses keymap.layer only and degrades silently to "none"」：函数 → `'keymap'`；非函数 → `'none'`；抛错 → `'none'`（均不逃逸） |
| 目录含 `tui.ts` 即标 `features.tui=true` | `opencode-probe/01` §A10 注册表两例 `{"server":true,"tui":true}` |
| 子会话事件确实进入 `ctx.event.subscribe()` 全局流 | `opencode-subagent/02` §3.1/§3.2/§3.4：`session.created/renamed/agent.selected` 各带自身 sid 抵达 |
| 事件驱动的冷启动盲区、订阅不回放 | `opencode-subagent/02` §3.5；对应 README「会话发现恒为 partial」 |
| `session.created` 运行时无 `info`、`ctx.session.get` 无 `parentID`、`GET /session/{id}/children` 404 | `opencode-subagent/02` §2 表②③、§3.3、§4.3 |
| 权限 hook 返回 `undefined` = 不改 `effect` | `opencode-p0/01` §4：`permission.hook.evaluate.fired` 触发后请求未被自动允许 |
| 版本门（声明 + 运行期探测 + 越界标注） | `package.json` `engines.opencode:" >=2.0.6 <3"`；`src/shared/version-gate.ts`；`tests/unit/version-gate.test.ts`、`tests/integration/version-gate.test.ts` |
| 打包 `lib/` 与 `check:build` 漂移门 | `package.json` scripts `build`/`check:build`；`dist/02` §0（目录态免构建 → shim 指向源码） |
| Connector 只读面 + agent catalog | `tests/test_opencode_agent_catalog.py`；`connector/connector/runtimes/opencode/runtime.py:162-168,470-478`；`connector/connector/server/runtime_rpc.py:65,186-197` |
| 热重载重放 `setup()` 并调用旧实例 cleanup | `opencode-p0/01` §6 |
| 与现存插件共存互不影响（逐插件隔离错误） | `opencode-p0/01` §8 |
| 事件名以运行时刻为准（类型定义 0 命中） | `opencode-p0/01` §3.4 量化表 |
| 授权页「拉起默认浏览器」：不硬编码浏览器/ProgID、URL 原样传递、失败回退且 fail-soft | `src/server/browser-opener.ts`（argv 直传：win32 `rundll32.exe url.dll,FileProtocolHandler <url>` → 回退 `explorer.exe <url>`；darwin `open`；linux `xdg-open`；全程不经 shell）；守护测试 `tests/unit/browser-opener.test.ts`：断言命令行不含 `edge\|chrome\|firefox\|iexplore\|msedge\|MSEdgeHTM\|ChromeHTML`，且含 `&` 与 `%` 的授权 URL 逐字符原样传入 |

| **宿主自带 HTTP 面（`opencode serve`）实测存在**：`GET /api/session`（`{data,cursor}` 分页）、`/api/session/{id}`、`/api/session/{id}/message`、`/api/session/{id}/permission`、`/api/permission/request`、`/api/model`、`/api/provider`、`/api/agent`、`/api/command`、`/api/integration`、`/api/config`、`/api/location`、`/api/event`（SSE，`server.connected` + heartbeat） | 本轮隔离实测（复现命令见 §五「宿主 HTTP 面」）；`opencode v2.0.18`。需要 Basic（`opencode:<serve 日志里的 server password>`）**且**带 `x-opencode-directory: <encodeURIComponent(目录)>`；不带该头时所有路径回落到 Web UI 的 HTML，**任何"200 即存在"的判据都是假信号**（本轮第一次实测就中了这一枪） |
| **`/api/model` 每条带 `providerID`，但 `id` 本身跨 provider 重复**（真机 79 条里 `longcat-2.5-preview-free`、`space-bunny-free`、`mimo-v2.6-pro`、`mimo-v2.6-flash` 等重复） | 本轮对活服务实测。⇒ **换到 HTTP 面并不能免掉重复 id 问题**；正确做法是按 `providerID/modelID` 组目录键（两条都保留、都可选），而不是像 `#listModels` 那样塌成一条。本行更正本文件上一版"HTTP 面天然分键、不必塌缩"的错判 |
| **宿主服务可被外来进程直连，无需插件**：`~/.local/state/opencode/service.json` = `{id, version, url, pid, password}`；`GET /api/info` 带 `Authorization: Basic opencode:<password>` 返回 `{version, pid, urls[], paths.tmp}`；客户端须比对 `pid`/`version` 判记录是否过期（二进制内建逻辑如此） | 本轮实测：`/api/info` → HTTP 200 `{"version":"2.0.18","pid":18772,"urls":["http://127.0.0.1:49374"],…}`。密码可用 `OPENCODE_PASSWORD` / `OPENCODE_SERVER_PASSWORD` 固定（二进制内 `L6("OPENCODE_PASSWORD").pipe(cK(()=>L6("OPENCODE_SERVER_PASSWORD")))`） |
| `/api/health`、`/api/doc`、`/api/question/request`、`/api/session/{id}/children`、`/api/session/{id}/fork` 在 2.0.18 **不存在**（404） | 同上（逐条取 HTTP 码） |

## 三、未验证项（附原因）

| 项 | 原因 | 依据 |
| --- | --- | --- |
| **桌面 App 的 TUI（用户实际宿主）装载与可用面** | 不可干扰 PID 9016（用户服务），该宿主未实跑；其 role=cli context 可能比 CLI 更丰富，属**未证**。CLI 侧已证实：全量 `opencode` 装载、`mini` 不加载、`/aa` 命令**不存在**（无注册面） | `opencode-tui-pty/01` §3/§4/§5、§7④ |
| **`keymap.layer` 的可写性与入参形状** | 该成员在 A10 的真实 ctx 里**存在**（属 `keymap` 成员表），但其可写性/参数形状**未在真机确认**；本轮按「是函数才尝试调用、否则静默 `none`」实现，未验证注册是否成功 | `src/tui/index.ts:registerCommandLayer`；`tests/unit/tui-commands.test.ts`；`opencode-tui-pty/01` §4 |
| **已结案（真机活服务实测，判词为「能」）：`GET /api/session` 暴露 `parentID`** | 用户机器上活着的共享服务（`~/.local/state/opencode/service.json` → `url=http://127.0.0.1:49374`、`pid=18772`、`version=2.0.18`）返回 50 条会话，**其中 39 条带 `parentID`**。⇒ 子会话归属在 HTTP 面上**可以**认领 | 本轮实测；`subagent/02` §5 |
| **已结案（判词为「否」，且本行更正本文件上一版结论）：新建会话时 `parentID` 会被忽略** | 隔离空库里 `POST /api/session {"parentID":…}` 被接受但静默丢弃，回读列表与详情都无该键；`/api/session/{id}/children` 在 2.0.18 的 115 条路由里不存在。**注意**：本行曾写作"HTTP 面同样不暴露 parentID"——那是拿**没有子会话的隔离库**当样本得出的错判，列表面与创建面是两件事 | 本轮实测（§五「宿主 HTTP 面」） |
| 子会话内 `permission.asked` 的 sessionID 归属 | 需真实模型跑一次工具；子会话需 `task` 工具派生 ⇒ 需可用模型 | `subagent/02` §5、§6 |
| `ctx.session.{create,prompt,interrupt,switchModel,switchAgent}` 的真实入参形状 | `create({parentID})` 三种入参形状均被忽略（落库 `parent_id` 为 NULL），其余方法入参未逐个实测 | `subagent/02` §4.1、§4.6 |
| A11：permission hook 返回字符串能否改写 `effect` | spike 未冒险自动放行，只证 `undefined` 不改变 effect | `p0/01` §4「未测：返回 allow/deny 字符串能否改写 effect」 |
| A12：`Plugin.define(...)` 与 `export default { id, setup }` 等价 | 设计二版列为待核验；仅旁证 team-mode 产物中 `Plugin.define` 为恒等函数 | `design/02` L83、L109；`research/03` L117 |
| `ctx.model` 项形状映射 | A10 只 dump 了 `ctx.agent`，`ctx.model` 未逐个展开 | `probe/01` ctx 域 dump；README「目录面」 |
| 真实 `uv run` 的 Connector 闭环（含包内 `lib/connector/` 启动） | 需插件在真机 OpenCode 内触发 `uv` spawn；本轮只跑了 pytest，未触发插件侧 spawn 闭环 | `p2/03` §4（仅 pytest）；README「Connector 前置」 |
| macOS/Linux 全链路实测 | 全部实证只在 Windows（2.0.18） | `opencode-audit/01` §5 |
| **真实平台浏览器启动未实跑**：`rundll32`/`explorer`/`open`/`xdg-open` 均未在真机真开一次浏览器 | 本机测试以注入的假 `run` 断言 argv 与回退链，**不真开浏览器**；真机启动需图形会话且会干扰用户桌面 | `tests/unit/browser-opener.test.ts`（假 `run`） |
| **真实宿主注入 `ctx.options` 的形态未实跑**：`options.autoLogin` / `options.loginMode` 等是否真被 OpenCode 传入插件 `setup()` | 无可用模型网关，真机 TUI（`role=cli`）装载未跑；仅按 `setup(input)` 契约编码 | README「配置项（`options`）与环境变量」；本文件 §四 |

| **HTTP 面的 location 语义未证**：真机 `GET /api/session` 带与不带 `x-opencode-directory: D:/Github/Agents-Anywhere` 都返回同样的 50 条 ⇒ 该头**没有**在列表上起到 rev3 裁定 1 要求的"只暴露本 location 会话"作用（可能该路由不按 location 过滤，也可能值格式/权限另有要求） | 只做了两个样本的对照，未穷举多目录实例；换形态前必须先把这条测透——它是"串台"防线的地基 | 本轮对活服务的对照 GET |
| **`/api/permission/request` 与 `/api/session/{id}/permission/{requestID}/reply` 的实际可用性未证** | 实测时该面返回 0 条待审批（没有正在跑的回合），只证路由存在且返回 200；`reply` 未发过真请求（会改宿主状态） | 本轮实测 + `openapi.json` 115 条路由 |

## 四、被阻塞项（附解除条件）

| 项 | 阻塞原因 | 解除条件 |
| --- | --- | --- |
| 真实环境端到端复核（真实模型回合 → timeline → 审批） | 用户配置的模型网关整体不可用：`lxns-maiden/empurple/uni/ris` 均 HTTP 502，`api.deepseek.com/v1/models` HTTP 401 | 网关恢复或换可用凭据后重跑 `subagent/02` §1 的 `opencode run` 装置 |
| web-next 构建 / 类型检查 | `web-next/node_modules` 不存在（`Test-Path` = False），无依赖无法构建 | 在 `web-next/` 执行一次 `corepack yarn install` |
| git 规格安装在 Windows / v2.0.18 | OpenCode 内嵌 `npm-cli.js` 子进程分派 bug：`opencode-cli.exe "B:\~BUN\bin\npm-cli.js" --version` 只打印自身帮助 → `NpmInstallFailedError: git dep preparation failed` | 上游修复该分派（或换平台/版本）后重跑 `dist/03` §7 步骤 |

## 五、复现命令

先按 [README](./README.md)「本地构建与安装」完成 `corepack yarn install`（本包是独立 Yarn 4 项目）。

在 `opencode-plugin/`：

```bash
corepack yarn typecheck
corepack yarn check:build
corepack yarn test
```

在 `connector/`：

```bash
uv sync
uv run pytest tests/test_opencode_provider.py tests/test_opencode_bridge_client.py \
  tests/test_opencode_live_transport.py tests/test_opencode_agent_catalog.py -q
```

隔离探针（需要自带 `opencode-cli.exe`，会重定向 `XDG_*` / `HOME` 到临时目录，不碰用户配置）：

```powershell
# 装置与判定原文见：
#   evidence/20260926-213919/opencode-dist/03-implementer-git-spec-install-layout-probe.md §7
#   evidence/20260926-213919/opencode-subagent/02-implementer-child-session-event-flow-spike.md §1
```

## 六、手动验收清单（需有 TTY 与可用模型的真机）

启动方法见 [README](./README.md#安装进-opencode形态-b已实证)。仅监听回环地址时跳过真机手机步骤。

- [ ] 启动日志出现 `msg="loading plugin" … entrypoint=file:///<path>/opencode-plugin/index.ts`，且端点文件 `~/.agents-anywhere/opencode-bridge/endpoints/<pid>-<port>.json` 生成（两者缺一即未装上）。
- [ ] 全量 TUI（`opencode`）装载 TUI 插件并弹出一条状态 toast（未登录时文案指向服务端命令 `/aa-login`）；`opencode mini` **不**加载 TUI 插件（已实测）。**`/aa` 命令不存在**（2.0.18 无命令注册面），不要期待它出现在 `/` 面板；登录/退出走服务端 `/aa-login` 与缺凭据自动触发。桌面 App 宿主下待复验。
- [ ] `api.client.session.list({ roots:false })` 返回带 `parentID` 的条目，且 `session-index.json` 原子落盘；会话列表按索引过滤子会话。
- [ ] 登录三步走（**无需任何环境变量**）：无凭据启动即**自动触发**登录 → 图形环境**自动拉起默认浏览器**打开授权页（含 `&` 与 `%` 的 URL 未被截断）→ 文件 `~/.agents-anywhere/opencode-plugin/login.json` 写出 `status:"pending"` + `authorizationUrl`（日志给出该文件路径）；点一次「授权」后文件变 `status:"connected"`，日志出现 `已连接：账号 …，设备 …`。环境变量（`AGENT_AA_LOGIN=device`/`loopback`）与 `AGENT_AA_AUTO_LOGIN` 仅为**高级 / 无头备用**路径。
- [ ] 真实模型回合下时间线增量与最终结果正确投影；`session.discovery` 恒为 `partial` 且不伪造 `complete`。
- [ ] 子会话内触发工具审批时，`permission.asked` 的 sessionID 被正确认领（当前子会话审批为 fail-closed，须逐条确认归属）。
- [ ] 卸载：设 `AGENT_AA_CLEANUP=1` 重启后，本插件数据目录与 `opencode-bridge/` 被清理、自有 Connector 被杀，且不建立远端连接；核对 README「残留清单」中未清理项。
- [ ] 按 README「Connector 前置」确认 `uv` spawn 的 Connector 闭环（源码解析顺序：`AGENT_CONNECTOR_SOURCE` → 包内 `lib/connector/` → `../connector`）。
- [ ] macOS/Linux 全链路复跑（本记录全部实证为 Windows）。
