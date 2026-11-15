# DSH SpecRune 插件面板移植到手机 App 的可行性调研

日期：2026-11-16 · 结论：**数据可达但 UI 逻辑不能直接移植；推荐分阶段、以「原生重写 + Connector 代理」方式落地，不建议移植代码本体。**

## 一、要移植的对象是什么

「DSH specrune 插件面板」= 安装在 `~/.dsh/specrune/` 的 DSH 客户端插件（`specrune-dsh-host` + `specrune-panel`）：

| 部分 | 位置 | 规模 | 性质 |
| --- | --- | --- | --- |
| 宿主半侧（Node） | `panel/lib/index.js` | 1672 行 | 在 DSH Electron 主进程注册 `/specrune/*` HTTP 路由，`ctx.subprocess` 调本地 `specrune` CLI + `git` |
| 客户端半侧（React） | `panel/lib/client.js` | 3630 行 | 通过 DSH 的 `slots` 服务注入侧栏/主区/覆盖层 UI |
| 宿主桥 | `plugin.js` | 939 行 | 逐轮上下文注入 + 三个 subagent provider（implement/check/research） |
| 组合补丁 | `cordis.patch.yml` | — | 往 profile 插 5 条 loader 项 |

面板 UI 功能全集（`client.js` 组件）：

- `SpecRunePage` 主区：项目卡片列表、任务树、归档折叠、排序、滚动还原
- `TaskDetail` / `TaskDetailView`：任务详情、验收标准 checklist、spec 引用、实现/检查上下文
- `ProjectExpand` / `WtTree` / `WtComposer`：git worktree 树（dirty/ahead）、新建/检出/合并/删除分支、设父（`.git/specrune-bases.json`）
- `AddProjectWizard`：接入项目向导（登记/初始化/导入/克隆/创建/gitinit + 安装项目级适配）
- `SessionRowAction` / `SessionRowLead`：**挂在每个会话行上的入口按钮**，把「会话」和「任务」关联
- `AppWelcome` / `BrandBadges`：app 级欢迎层与品牌徽标、注入状态提示
- 升级器：版本 dry-run 预览 → 异步执行 → 日志轮询

## 二、数据从哪来（决定性事实）

面板所有数据都来自**本机资源**，没有一处来自云端 Server：

1. **本机文件**：直读项目下 `.specrune/` 目录（`workflow.md`、`.version`、tasks、spec）
2. **本机 CLI**：`specrune task list --json` / `task show <ref> --json` / `init` / `import` / `update` 等
3. **本机 git**：`git worktree`、分支、`merge --no-ff`、写 `.git/specrune-bases.json`
4. **本机工作区注册表**：DSH 的 workspace registry（侧栏同一本账）

而上游 SpecRune 本体（`/Users/Dae/.dsh/specrune/bin/specrune`，Go 二进制）**没有 HTTP server、没有 daemon、没有远程模式**；注入桥是 spawn 子进程、stdio 一帧一问、无常驻端口。`SpecRune Desktop.app` 是 **Tauri 2** 应用，前端是独立 Web 应用（`web/src`，约 5000 行），通过壳内 Go httpd 的 `/api/*`（`/api/tasks`、`/api/projects`、`/api/worktrees`、`/api/gh/*`）直读 `.specrune`。

**即：两套宿主（DSH 面板 `/specrune/*`、Tauri 桌面 `/api/*`）是同一数据模型的两种本机实现，都依赖「能读本地 `.specrune` + 能跑本地 CLI/git」。**

## 三、手机 App 的现实

手机端（`android/` Kotlin·Compose、`ios/` SwiftUI）是**远程客户端**：只连 Server `/api/v2`，看不到任何工作设备本地文件。

- Server（`server/agent_server`）**零** specrune 概念；`contracts/`、`dsh-bridge` 契约也无 specrune 面。
- Android 零 specrune 引用；iOS 仅有一个 logo 资源（`AAWordmark`）。
- 移动端 UI 结构（home/sessiondetail/files/terminal/devices…）里**没有任务看板**。

**但本地资源已经可达**：Connector（工作设备上的进程）已有 `local_rpc.py` 暴露 `fs.readText` / `fs.readDir` / `shell.exec` / `terminal.*`，Server 通过 RPC 转发，手机端 `V2ConnectorAPI` 已经能走 `connectors/{id}/fs/readText` 这类路径。

## 四、可行性判断（分层）

| 层 | 能否移植 | 说明 |
| --- | --- | --- |
| **数据获取**（`.specrune` + CLI 输出） | ✅ 可行 | 经 Connector 代理：新增 specrune 类 RPC method（或复用 `shell.exec` 跑 `specrune task list --json`），Server 加只读 API，手机消费 JSON。符合现有 local_rpc↔Server↔mobile 架构模式。 |
| **只读看板 UI**（项目列表/任务树/任务详情/spec 引用/归档） | ⚠️ 需重写，不可移植 | React + DSH slots 代码在 SwiftUI/Compose 上完全无复用价值；只能按功能清单用原生重写。数据契约（`task list --json` 的 schema）可共享。 |
| **git worktree 操作**（创建/合并/删除分支、设父） | ⚠️ 需重写且要新增 capability | 写操作，涉及 `git merge` 等，需在 Connector 加受控 RPC + Server 授权/审计，远不止 UI 移植。 |
| **会话行按钮 / 欢迎层 / 品牌徽标**（DSH slot 集成） | ❌ 概念不成立 | 手机端没有「DSH 侧栏会话行」这一 slot 体系，等同重新设计入口（如手机会话详情页加「关联任务」抽屉）。 |
| **项目接入向导**（含原生目录选择器 `pick-directory`） | ❌ 不适用 | 手机没有工作设备的文件系统选择器；只能在桌面端完成接入，手机上只读展示。 |
| **宿主桥 / subagent provider / 上下文注入** | ❌ 无需移植 | 这是 DSH 桌面运行时能力，与手机无关。 |
| **升级器 / GitHub 集成（Tauri `/api/gh/*`）** | ❌ 不建议 | 桌面维护动作，手机上做价值低、风险高。 |

## 五、结论与建议

**结论：不能"把 UI 逻辑移植"到手机 App；但"把 specrune 看板能力搬上手机"是可行且合理的，前提是先补齐一条 Server↔Connector↔Mobile 的 specrune 只读数据链，再原生重写一个精简看板。**

推荐分阶段：

1. **阶段 0（契约先行）**：定义 specrune 数据契约（复用 `specrune task list/show --json` 的稳定子集），写入 `contracts/`。这是整个方案的地基，也是 AGENTS.md 的强制规则。**草案已出：[contracts/specrune/1.0](../contracts/specrune/1.0/README.md)**（projects / tasks / task / spec / session-task 五个只读端点，含 schema 与 error code，已用真实 CLI 数据校验）。
2. **阶段 1（只读看板，MVP）**：Connector 加 `specrune.tasks` / `specrune.task` 只读 RPC（内部执行本地 CLI）；Server 暴露只读接口并按账号/设备鉴权；手机端新增「任务」屏（V2 项目→任务树→任务详情），原生重写，不含任何写操作。这一阶段就能让手机上"看到任务看板"。
3. **阶段 2（写操作，谨慎）**：worktree 分支管理按需上，逐条加受控 RPC + 审计，默认关闭。
4. **明确不做**：DSH slot 集成（会话行按钮、覆盖层、欢迎层）、桌面专有的接入向导、升级器、gh 集成。

**移植成本的真实分布**：UI 代码零复用（3630 行 React 作废，需要原生重写看板 + 详情 + 树）；真正可复用的是**数据契约与 CLI 输出格式**；真正的工作量在 **Connector/Server 的数据链**和**写操作的安全模型**，而非 UI。

## 六、关键证据路径

- 插件本体：`~/.dsh/specrune/panel/lib/{index.js,client.js}`、`~/.dsh/specrune/plugin.js`、`cordis.patch.yml`
- 上游 CLI（Go 二进制，无 server）：`~/.dsh/specrune/bin/specrune`
- Tauri 桌面（另一套本机实现）：`/Users/Dae/Downloads/codes/SpecRune/tauri-revive/tauri-app/web/src/api.ts`
- 本地 RPC 现有能力：`connector/connector/server/local_rpc.py`（`fs.readText`/`shell.exec`/`terminal.*`）
- 手机端已具备的取数通道：`ios/Agents Anywhere/Agents Anywhere/API/V2/V2ConnectorAPI.swift`（`connectors/{id}/fs/readText`）
- Server 无 specrune：`server/agent_server`（全仓 grep 零命中）
