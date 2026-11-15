# SpecRune 任务看板接入手机端

## Goal

iOS 端能**只读**浏览工作设备上的 SpecRune 任务看板：项目列表 → 任务树 → 任务详情（含验收清单与规范引用），并在会话页显示该会话所属任务。数据经 Connector 从工作设备的 `.specrune/` 与本地 `specrune` CLI 实时取得，契约见 [contracts/specrune/1.0](../../contracts/specrune/1.0/README.md)。

## Confirmed Facts

调研已确认（见 [可行性报告](../../docs/specrune-panel-mobile-feasibility.md)）：

1. **面板数据全在本机**：DSH 插件面板的 `/specrune/*` 全部来自 `.specrune/` 目录 + `specrune` CLI 的 `--json` 输出 + `git`；上游 CLI 无 HTTP server、无 daemon、无远程模式。
2. **手机是纯远程客户端**：只连 Server `/api/v2`；Server 当前**零** specrune 概念；Android 零引用，iOS 仅一个 logo 资源。
3. **本机资源已可达**：Connector 的 `local_rpc.py` 已暴露 `fs.readText` / `fs.readDir` / `shell.exec` / `terminal.*`；Server 用 `require_owned_online_connector` + `request_connector` 转发；iOS 的 `V2ConnectorAPI` 已能走 `connectors/{id}/fs/readText`。样板见 `server/agent_server/api/connector_files.py`。
4. **契约已就绪**：`contracts/specrune/1.0` 定义 projects / tasks / task / spec / session-task 五个只读端点，已用真实 CLI 数据通过 Draft 2020-12 校验。
5. **iOS UI 原型已就绪**：`Views/SpecRune/SpecRuneTasksView.swift` + `SpecRuneModels.swift`，用 mock 数据，`swiftc -typecheck`（iOS 27.2 SDK）通过；三栏自适应 + Duo 合规；设计稿见 `docs/specrune-mobile/`。
6. **接入约束**：`ChatShellSelection` 只有 `newSession` / `device` / `session` 三态，加独立 tab 需扩展该枚举并同步侧栏与 rail；项目设计系统为 `AppTheme`（黑白极简）+ `AppSymbol`（Lucide 模板）+ `glassEffect`。
7. **项目规则**：契约优先（先改 `contracts/` 再改各端）；Connector/Server 改动需过 ruff + pytest；Views 不在 SPM target，需 Xcode 编译。
8. **两端无扩展机制**：Connector 的 `LocalRpcHandler.METHODS` 与 `dispatch` 是硬编码 if 链；Server 的 `app.py` 是硬编码 `include_router` 列表；两者都没有插件/扩展注册表。
9. **iOS 已有本地 SPM 包先例**：`ios/Packages/Textual` 经 `XCLocalSwiftPackageReference "../Packages/Textual"` 接入 xcodeproj，是可复用的插件化范式。

## Requirements

- **R0 零改上游（用户追加，已实证）**：**Connector 与 Server 一行都不改**，功能整体住在 iOS 侧的独立 SPM 包 `ios/Packages/SpecRuneKit`。理由是官方远程 Server 不认识新增 RPC 方法、也没有通用 RPC 透传端点；而官方**已有**的三条端点足够取全部数据：
  - `POST /connectors/{id}/shell/exec?root=`（跑命令，返回 `stdout`/`stderr`/`exitCode`）
  - `POST /connectors/{id}/fs/readText?root=`（读文件，带 `maxBytes`）
  - `POST /connectors/{id}/fs/readDir?root=`（列目录）
  - 实证：`specrune task list --json --all` 输出 3.5 KB、`task show` 451 B，均远小于 `shell.exec` 的 64 000 字符上限；无 tty 下输出纯净 JSON。
- **R1 iOS 数据获取**：新增 `V2ConnectorAPI.shellExec`，用 `shell/exec` 跑 `specrune task list --json --all` 与 `specrune task show <ref> --json`；用 `fs/readText` 读 `prd.md` / `design.md` / `implement.md` / `.specrune/.version` / `.runtime/sessions/dsh_*.json`；用 `fs/readDir` 列任务目录。
- **R2 iOS 独立包**：新建本地 SPM 包 `ios/Packages/SpecRuneKit`（DTO + 取数 + Views 全在内），主 app 仅加包引用与一个入口注册点，遵循 `Packages/Textual` 先例。
- **R3 iOS 看板接真数据**：把现有原型迁入包内并把 mock 换成真实数据，保留三栏自适应与动效。
- **R4 iOS 独立入口**：扩展 `ChatShellSelection` 增加任务看板态，侧栏与 rail 加入口，compact/regular 均可达。
- **R5 会话页显示所属任务**：会话详情页在存在关联任务时显示该任务入口/摘要，无关联时隐藏。
- **R6 降级与空态**：非 SpecRune 项目、CLI 缺失（`exitCode != 0` + stderr 含 not found）、设备离线时显示可读空态/错误，不崩溃。

## Acceptance Criteria

- [ ] iOS 能经 `shell/exec` 从工作设备取到真实任务列表并渲染，`Views/SpecRune` 主路径不再依赖 mock 数据
- [ ] iOS 能显示任务详情：摘要 + `prd.md`/`design.md`/`implement.md` 正文 + 验收清单（`implement.md` 的 `- [ ]` 项）
- [ ] iOS 有独立入口可进入任务看板，compact 与 regular 宽度下均可到达
- [ ] iOS 会话页在存在关联任务时显示所属任务，无关联时不显示空壳
- [ ] 非 SpecRune 项目 / CLI 缺失 / 设备离线时显示可读空态，不崩溃
- [ ] **零改上游**：`connector/` 与 `server/` 无任何改动（`git diff` 为空），功能全部位于 `ios/Packages/SpecRuneKit` + 主 app 入口注册
- [ ] iOS `swiftc -typecheck` 通过
- [ ] 契约、CHANGELOG 与相关文档同步更新

## Out of Scope

- **写操作**：worktree 创建/合并/删除分支、设父（阶段 2）
- **桌面维护动作**：升级器、项目接入向导、gh/GitHub 集成
- **DSH slot 集成**：会话行按钮、app 欢迎层、品牌徽标（手机端无对应 slot 概念）
- **Android 与 Web 端**：本轮只做 iOS
- **不改 specrune CLI**、不新增磁盘格式（契约只描述既有产物）

## Open Questions

（无——端范围、入口、会话关联、写操作四项已定：iOS only / 独立 tab / 做会话关联 / 只读 MVP）
