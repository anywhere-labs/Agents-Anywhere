<!-- tm_board_write · 2026-09-26T21:11:10.400Z · role=implementer · session=20260926-213919 -->
# TUI 插件真实装载验证（伪终端 / pywinpty）— 最终报告

装置根：`C:\Users\34296\AppData\Local\Temp\opencode\aa-tui-pty\`（仓库只读；未触碰 PID 9016 与端口 49374）
隔离：USERPROFILE/HOME→`<root>\home` 或 `<root>\homelt`；XDG_CONFIG_HOME/DATA/CACHE 全重定向；日志=`<home>\.local\share\opencode\log\opencode.log`
PTY：`connector\.venv` 的 **pywinpty 3.0.5**；驱动脚本 `ptytui.py`（pyte 渲染屏幕 + 逐步快照 + 原始字节）
CLI：`C:\Users\34296\AppData\Local\Programs\@opencode-aidesktop\resources\opencode-cli.exe`（v2.0.18）

## ① PTY 手段奏效 ✅
PTY 里跑 `opencode-cli.exe --version` → 捕获到 `opencode v2.0.18`（raw 65B）；`--help` 捕获 2731B。
沙箱里的 `opencode mini requires a TTY stdout` 在 PTY 下**彻底消失**。

## ② TUI 形态（--help 判定）✅
| 命令 | 结果 |
|---|---|
| `opencode mini` | **简版**界面（无 logo，`Ask anything, / for commands`） |
| `opencode --standalone`（裸跑） | **全量 TUI**（ASCII block logo、`ctrl+p commands`、`shift+tab agents`） |
| `opencode tui` | **不存在**（子命令表无此项） |
→ 全量 TUI = 裸 `opencode`；`mini` 是另一套精简渲染。

## ③ TUI 模块是否被装载
在副本 `tui.ts` 顶层加埋点（appendFileSync），并在 `setup(ctx)` 里 dump context：
- **`opencode mini`**：`tui-probe.log` = **零输出** → TUI 模块**从未被求值**；日志无任何 role=cli 插件 reconcile 行。
- **裸 `opencode --standalone`**：`tui-probe.log` =
  ```
  module-evaluated 2026-09-26T21:07:02.995Z
  setup-called 2026-09-26T21:07:03.022Z
  ```
  → **我们的 TUI 模块确实被求值、setup 确实被调用** ✅
- **对照**：把副本 `tui.ts` 改名为 `tui.ts.bak` 后重跑裸 TUI → `tui-probe.log` **零输出**（模块未被加载）。证明该埋点确实归因于我们的 TUI 入口。

## ④ setup 发现的 surface（`tui-setup.json` 原文）
context 顶层键（13）：
`options, location, app, renderer, client, data, attention, theme, themeMode, markdown, keymap, storage, ui`

| 面 | 成员 | 我们的探测 |
|---|---|---|
| `keymap` | layer, dispatch, shortcuts, commands, pending, active, mode | **无 `registerLayer`** → 不命中 |
| `command` | **整个键不存在** | 不命中 |
| `ui` | dialog, toast, format, router, panel, tabs, model, slot | 有 `toast` → 命中 `ui`；**无 `DialogAlert`/`DialogPrompt`** |
| `attention` | notify, dispose | 有 `notify` → 命中 `attention` |
| `markdown` | registerCodeBlockRenderer | — |
| `storage` | store, memory | — |
| `client` | server, location, agent, plugin, session, message, model, … (30) | — |
| `data` | on, listen, session, project, shell, location | — |
| 缺失 | `route` / `slots` / `lifecycle` / `kv` | — |

→ `describeSurfaces()` = **['ui','attention']**；`registerCommands()` = **'none'**（既无 `keymap.registerLayer` 也无 `command.register`）。

## ⑤ `/aa` 是否出现 / 可执行 ❌
裸 TUI 里输入 `/` → 命令面板只列内置命令（原文截取）：
```
/agents /btw /cd /clear /connect /continue /debug /diff /editor /effort ...
```
**没有 `/aa`、没有「Agents Anywhere」任何条目**；输入 `/aa` 后回车无任何输出/弹窗（我们的 setup 里 `registerCommands` 返回 'none'，本该如此）。
`mini` 里同样没有。

## ⑥ 风险项：副本 `execFileAsync has already been declared`（已排除，非插件缺陷）
实验早期副本报 `Die(BuildMessage: "execFileAsync" has already been declared)`（bun 编译期）。bisect：
| 副本形态 | 结果 |
|---|---|
| 仓库原目录（`file:///D:/…/opencode-plugin`） | 装载成功（且用户真实日志同样 3× 成功） |
| 副本去掉 `node_modules, lib, .yarn, yarn.lock` | **失败** |
| 同上 + 去掉 `tui.ts` | 成功 |
| 副本保留 `lib`+`.yarn` | 成功 |
| 副本只去掉 `lib`（留 `.yarn`） | 成功 |
| **重新从仓库复制**同样的裸源码副本 | **成功** |
→ 同目录原件复跑仍失败、重新复制即成 → **是复制时撞上其他 agent 并发编辑仓库的瞬时快照假象**，不是插件或打包缺陷。仓库当前状态两次复现均正常。

## ⑦ 对「登录呈现面」的结论
**TUI 目前不能作为登录/状态呈现面。** 理由（均为本轮实测）：
1. 命令注册面不存在（`/aa` 无法注册，用户无法触发）；
2. 真实 context 无 `ui.DialogAlert`/`ui.DialogPrompt` → 我们现有的弹窗路径（`ui.dialog.replace`+`DialogAlert`）拿不到内容；只有 `ui.toast` 可用；
3. `opencode mini`（简版）根本不加载 TUI 插件；
4. 桌面 App 的 TUI（用户实际在用的宿主）本轮**未能验证**（不可干扰 PID 9016）——那里的 role=cli plugin reconcile 可能给出更丰富的 context，属未证。

建议主呈现面：**桌面 App 面板 / Web + 我们服务端 bridge 的 HTTP/本地端点**（服务端插件已实证可装载、可注册）。
若将来要用 TUI：需改用宿主真实面 `keymap.layer` + `ui.toast` + `ui.slot`/`markdown`（后两者需 JSX），并在桌面 App 的 TUI 里复验。

## 进程清单（全部已关闭）
- 本轮自起：`opencode-cli.exe`（mini / bare，逐次由 harness `terminate()` 结束）+ 内联 `serve --stdio` 子进程；全部已退出。
- 核验：`Get-CimInstance … name='opencode-cli.exe'` 现在**只剩 PID 9016**（用户服务，49374 仍为 9016）；无任何进程命令行引用 `aa-tui-pty`。
- 仓库：`git status --porcelain` 23 条脏改动**全部是其他 agent 在飞的 login 改造**（auto-login.ts / login-state.ts / browser-opener.ts / onboarding.ts …），与本轮无关；我未写入仓库任何文件。

## 产物（保留，供复核）
`C:\Users\34296\AppData\Local\Temp\opencode\aa-tui-pty\`：`ptytui.py`、`logs\*.raw.txt|*.snaps.json|*.console.txt`、`logs\tui-setup.json`、`logs\tui-probe.log`、`variants\*`。
