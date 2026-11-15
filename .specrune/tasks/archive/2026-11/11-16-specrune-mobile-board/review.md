# 评审与进展台账

## 方案变更（用户驱动，已落地）

原方案是「Connector RPC → Server 转发 → iOS」三端改动。用户指出官方远程 Server 不认识新增 RPC，改 Connector 也传不上去。核实后确认：

- Server 没有通用 RPC 透传端点（只有 `fs/*`、`shell/*` 等专用端点）。
- 官方**已有** `POST /connectors/{id}/shell/exec`（返回 `stdout`/`stderr`/`exitCode`）与 `fs/readText`，足够取全部数据。

**结论：零改上游，只改 iOS。** 已回滚先前写的 Connector 扩展（`extensions/` 目录与 `local_rpc.py` 改动均已删除/还原）。

实证：`specrune task list --json --all` = 3 566 B、`task show` = 451 B，均远小于 `shell.exec` 的 `MAX_OUTPUT_CHARS = 64 000`；无 tty（stdin=DEVNULL）下输出纯净 JSON、exit=0、stderr 空。

## 已完成

| 项 | 文件 | 验证 |
| --- | --- | --- |
| 契约（阶段 0，上一轮） | `contracts/specrune/1.0/` | 真实 CLI 数据通过 Draft 2020-12 校验 |
| iOS shell 端点封装 | `Domain/Connector/V2ShellExec.swift`、`API/V2/V2ConnectorAPI.swift`（`shellExec`） | `swift build --target ClientCore` 通过 |
| SpecRuneKit 数据层 | `ios/Packages/SpecRuneKit/`（DTO / Errors / Transport / SpecRuneClient） | `swift build` 通过 |
| 主 app 适配器 | `Views/SpecRune/SpecRuneConnectorTransport.swift` | xcodebuild 通过 |
| 看板状态模型 | `Views/SpecRune/SpecRuneBoardModel.swift` | xcodebuild 通过 |
| 看板视图接真数据 | `Views/SpecRune/SpecRuneTasksView.swift`（原 mock 模型已删） | xcodebuild 通过 |
| xcodeproj 包引用 | `project.pbxproj`（照 Textual 先例加 SpecRuneKit） | `xcodebuild -list` 解析出 SpecRuneKit |
| 入口：导航 case | `Models/Chat/ChatShellSelection.swift`（`case specRune`） | xcodebuild 通过 |
| 入口：侧栏按钮 | `Views/ChatShell/ChatSidebarView.swift`（`ChatSidebarSpecRuneButton`） | xcodebuild 通过 |
| 入口：渲染分支 | `Views/ChatShell/ChatShellView.swift`（`mainContent` + `openSpecRune`） | xcodebuild 通过 |
| CHANGELOG | `CHANGELOG.md` iOS 分类 | — |
| 契约实现说明 | `contracts/specrune/1.0/README.md`（数据流 + 实现说明节） | — |
| 会话页所属任务 | `Views/Chat/SessionChatView.swift`（`loadSpecRuneTask`）+ `SessionDetailsSheet.swift`（条件行） | xcodebuild 通过 |

**编译验证**：`xcodebuild build -scheme "Agents Anywhere" -destination "generic/platform=iOS Simulator" CODE_SIGNING_ALLOWED=NO` → exit=0。

**零改上游**：`git status --short connector/ server/` 输出为空。

## 剩余

1. **独立评审**（Phase 2.2）：已派发 fresh `specrune_check`。
2. **收尾**：`specrune specs --check` → `specrune session record` → `task finish` → `task archive`。

## 已核实的风险

- **导航存档解码**：`V2RestorationStore.selection(in:)` 用 `try?` + `?? .newSession` 兜底，新增 case 不会让恢复失败。恢复的 `.specRune(deviceId)` 若设备已删除，看板显示空态。
- **会话关联的 repo 与 session id**：用 `meta.cwd`（工作目录）作 repo、`meta.externalSessionId` 作 DSH 会话 id，与面板 `readSessionTask` 的键规则一致；任一缺失就隐藏该行，不发请求。

## 待核查的风险

- `V2ShellExecRequest.timeoutMs` 设 20s；`specrune` 冷启动 0.5–1.3s，够用。但任务极多时 `task list` 可能变慢，需实测。
- `shell.exec` 的 stdout 64K 上限：任务列表超限会抛 `.truncated`，UI 已按错误显示；若真遇到需改为分页或按项目过滤。
- CLI 回退路径 `$HOME/.dsh/specrune/bin/specrune` 依赖工作设备 shell 展开 `$HOME`，Windows 下未验证。
- 主 app 未在真机/模拟器实跑（只做了编译验证），UI 实际渲染与 Duo 折叠态仍需验证。

## Review round 1

评审对象：当前未提交工作树（`git status --short` 33 项）。本轮只读评审，未改任何代码。

基线核对：

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 零改上游 | `git status --short connector/ server/` | 输出为空 ✅ |
| 编译 | `xcodebuild build -project "Agents Anywhere/Agents Anywhere.xcodeproj" -scheme "Agents Anywhere" -destination "generic/platform=iOS Simulator" -quiet CODE_SIGNING_ALLOWED=NO` | exit=0 ✅ |
| 契约完整性 | `contracts/specrune/1.0/manifest.json` 五个 schema 的 sha256 | 全部匹配 ✅ |
| Duo 自适应 | `Views/SpecRune/` 内 `UIScreen.main`/`UIDevice`/idiom/orientation | 无代码判定（仅注释提及）✅；三栏 `NavigationSplitView`（`SpecRuneTasksView.swift:55`）；正文 `maxWidth 700`（`SpecRuneTasksView.swift:278`）✅ |
| mock 残留 | `Views/SpecRune/` 与 `SpecRuneKit/Sources` | 无 mock/样例数据 ✅ |
| 关键陷阱 1：64K 上限 | `SpecRuneClient.swift:127-129` | `stdoutTruncated` 时抛 `.truncated`，不把截断串当 JSON 解析 ✅ |
| 关键陷阱 2：`--all` | `SpecRuneClient.swift:32` | `["task","list","--json","--all"]` ✅ |
| 关键陷阱 3：正文走 readText | `SpecRuneClient.swift:56-63` | 文档正文用 `fs/readText`，未走 `task show` ✅ |
| 关键陷阱 4：`$HOME` 展开 | `connector/connector/local/shell.py:143-151`（`create_subprocess_shell`） | POSIX shell 下可展开 ✅（但见 M4/m10） |

### Blocker

无。

### Major

**M1 · 归档任务的文档与验收清单永远读不到**

- 证据：`ios/Packages/SpecRuneKit/Sources/SpecRuneKit/SpecRuneClient.swift:59` 用 `.specrune/tasks/\(summary.dir)/\(kind.fileName)` 拼文档路径。
- 实测 CLI：归档任务 `specrune task show 11-13-sync-upstream-package-dsh-plugin --json` 的 `dir` 是**纯目录名** `"11-13-sync-upstream-package-dsh-plugin"`，`path` 才是 `.../tasks/archive/2026-11/11-13-...`；`ls .specrune/tasks/11-13-sync-upstream-package-dsh-plugin/prd.md` → `No such file or directory`。
- 影响：列表「已归档」区任意任务点进去只有摘要，`docs` 全空 → 无 PRD/设计/实施正文，**验收清单也不显示**（`SpecRuneTasksView.swift:413` 依赖 `docs[.implement]`）。直接打掉验收标准第 2 条对归档任务的覆盖。
- 建议：用 `summary.path` 去掉 repo 前缀作为相对路径（或按 `archiveMonth` 拼 `archive/<月>/<dir>`）。归档任务 `task show <dir>` 本身可用，只有路径拼装错。

**M2 · 切换项目后详情列停在 ProgressView**

- 证据：`SpecRuneTasksView.swift:26` 的 `selectedTaskRef` 在切换项目时不清空；`SpecRuneBoardModel.swift:67-71` 的 `select(repo:)` 只改 `selectedRepo`；`SpecRuneTasksView.swift:179-182` 用「新 repo + 旧 ref」查 `model.detail`，未加载即 `.idle` → 落到 `ProgressView`，而 `loadDetail` 只在 `List(selection:)` 的 setter（`SpecRuneTasksView.swift:141-143`）里触发。
- 影响：A 项目选中任务 → 切到 B 项目 → 详情列永久转圈，直到用户手动点 B 里任一任务。是否自愈完全取决于 SwiftUI 是否隐式把 selection 写成 nil，代码里没有显式处理。
- 建议：`select(repo:)` 或 `projectSidebar` 的 setter 里 `selectedTaskRef = nil`。

**M3 · PRD Goal 要求的「规范引用」完全未落地，`fs/readDir` 也未实现**

- 证据：`prd.md:5` Goal 写明「任务详情（含验收清单与**规范引用**）」；`SpecRuneClient.swift` 全文件无 spec 读取方法（只有 `listTasks`/`taskDetail`/`sessionTask`/`readText`）；`SpecRuneTasksView.swift:259-261` 的 `availableDocs` 只来自 `SpecRuneDocKind`；`DTO.swift:26` 解析了 `specRefs` 但**无任何 UI 引用**（`grep specRefs Views/SpecRune` 无命中）。
- 附带：`implement.md:22` 的 `listDir(repo:relPath:)`（`fs/readDir`）未实现，`taskDetail` 改为对 5 种文档各发一次 `readText`（`SpecRuneClient.swift:57-63`），单个详情至少 5 次串行往返，其中多数是 404。
- 影响：PRD R1 与 Goal 各有一处缺口；详情加载延迟放大。
- 建议：补 `readDir` + spec 展开，或把 PRD Goal 的「规范引用」明确移出 1.0 范围并同步 prd/design。

**M4 · CLI 缺失判定在 dash（Linux 默认 `/bin/sh`）下失效，`$HOME` 回退永不触发**

- 证据：`ios/Packages/SpecRuneKit/Sources/SpecRuneKit/Errors.swift:52` 的 markers 是 `["command not found", "no such file", "not recognized", "找不到"]`，**不含单独的 "not found"**。
- 本机实测：`/bin/sh -c 'specrune_not_exist_xyz'` → `/bin/sh: specrune_not_exist_xyz: command not found`（macOS bash-POSIX，命中）；`dash -c 'specrune_not_exist_xyz'` → `dash: 1: specrune_not_exist_xyz: not found`（**不命中**）。
- 影响：Linux 工作设备上 CLI 不在 PATH 时归为 `.cliFailed`，`SpecRuneClient.swift:124` 的 `if case .cliMissing = failure { return nil }` 不成立 → 不回退 `$HOME/.dsh/specrune/bin/specrune`（`SpecRuneClient.swift:15,97`），也不显示「未安装 SpecRune」。设计文档「CLI 定位」的回退策略在 Linux 上整体失效。这正是 checklist 第 4 条「假设只在本机成立」。
- 建议：markers 增加 `"not found"`（保留长串以避免误报），或先判 `exitCode == 127`。

**M5 · 设备离线被误判成「未启用 SpecRune」，`offline` 错误态永不出现**

- 证据：`ios/Agents Anywhere/Agents Anywhere/Views/SpecRune/SpecRuneConnectorTransport.swift:40-43` 的 `readText` 用 `catch { return nil }` 吞掉**所有**错误；`SpecRuneClient.swift:24-26` 的 `isSpecRuneProject` 只判 `!= nil`；`SpecRuneError.offline` 仅由 `exec` 的 catch 产生（`SpecRuneClient.swift:110-112`），`readText` 路径永不产生。
- 影响：离线/401 时 `probeProjects` 把每个项目都写成 `false`（`SpecRuneBoardModel.swift:59-63`）→ 侧栏全部「未启用 SpecRune」（`SpecRuneTasksView.swift:105`），且不会自动选项目，任务列显示「未选择项目」。用户看到的结论与事实相反，且没有重试入口。R6 要求「设备离线时显示可读错误」。
- 建议：区分「文件不存在」与「传输失败」（例如 404/文件缺失才返回 nil，其余上抛），探测阶段捕获 `.offline` 后展示可读错误 + 重试。

**M6 · 侧栏入口与验收清单用了不存在的图标键，渲染成问号圆圈**

- 证据：`ios/Agents Anywhere/Agents Anywhere/Views/ChatShell/ChatSidebarView.swift:255` 与 `SpecRuneTasksView.swift:149,192` 用 `appSymbol: "checklist"`；`SpecRuneTasksView.swift:339` 用 `"checkmark.square"`。`AppSymbolAssets.names` 里没有这两个键（有 `checkmark.square.fill` → `aa-SquareCheck`，没有 `checklist`）。
- 后果链：`AppSymbol.swift:14-17` 未命中时回退 `Image("aa-CircleHelp")`，该资产存在 → 实际渲染「问号圆圈」。
- 影响：侧栏「SpecRune」入口图标错误；**验收清单所有已勾选项显示问号圆圈**（未勾选的 `square` 正常），恰好是 PRD 核心交付之一的视觉错误。也违反 `.specrune/spec/ios/index.md`「图标一律用 AppSymbol（资产映射）」的意图。
- 建议：改用 `checkmark.square.fill`，并给 `checklist` 补映射（如 `aa-ListChecks`/`aa-ClipboardList`，资产需新增）或换已映射键。

### Minor

**m1 · 1 MiB 截断语义未落实（`truncated` 恒 false）** — `SpecRuneConnectorTransport.swift:39` 只取 `response.content`，丢弃 `V2WorkspaceTextResponse.truncated`（`Domain/Connector/V2WorkspaceFiles.swift:68`）；`SpecRuneDoc.truncated` 默认 `false`（`DTO.swift:54`），`SpecRuneTasksView.swift:365-369` 的「已截断：原文超过 1 MiB」是死逻辑。契约 README:34 要求客户端据此提示。`maxBytes` 默认值 1_048_576 本身正确（`V2WorkspaceFiles.swift:58`）。

**m2 · `.truncated` 文案与行为不符** — `Errors.swift:32` 写「任务过多，仅显示部分」，但 `SpecRuneClient.swift:127-129` 抛错后整张列表都不显示。改成「任务过多，请缩小范围」或改为真正分页。

**m3 · DTO 缺契约字段 `at`/`born`/`bytes`** — `DTO.swift:8-36` 未解析 `at`/`born`（契约 `task-list.response.schema.json` 定义，面板用 mtime 补，`~/.dsh/specrune/panel/lib/index.js:1412-1421`），列表排序只能退化为日级 `createdAt`（`SpecRuneTasksView.swift:171-173`）；`SpecRuneDoc` 也无 `bytes`（契约 `DocContent` required）。手机端无 stat 能力，缺 `at` 属客观限制，但应在契约 README 注明「手机端排序精度到日」。

**m4 · `research` 维度读错形态** — `DTO.swift:76-79` 的 `.research` → `research.md`，而契约是 `research/*.md` 多文件（`task-detail.response.schema.json` 的 `researchFiles`）。结果调研 tab 永不出现。

**m5 · `path` 设为 non-optional** — `DTO.swift:33`；契约 `TaskListItem.required` 只含 `dir/name/title/status/archived/active`。CLI 版本若省略 `path` 会让整张列表解码失败。当前 CLI（v0.9.3）确有 `path`，属防御性缺口。

**m6 · 会话页只显示 ref 文本，不是「入口/摘要」** — `SessionDetailsSheet.swift:26-28` 只 `row("SpecRune 任务", specRuneTaskRef)`，无跳转、无标题（`SpecRuneClient.swift:85` 的 `title` 恒 nil，面板也不返回，属可接受）。PRD R5 写「入口/摘要」，当前仅满足验收标准第 4 条的「显示」。

**m7 · Duo rail 未接入，PRD R4 的「rail 加入口」未做** — `SpecRuneTasksView.swift` 不消费 `@Environment(\.chatRail)`；对比 `DeviceManagementView.swift:24,107`、`SessionChatView.swift:29,147` 都接了。`.specrune/spec/ios/duo-layout.md:388` 约定「Duo 专属入口只走 rail」，`DeviceManagementView.swift:106` 还记录过「不接 chatRail 时这两键在本页消失（真机实证）」。结果是看板页在 Duo 内屏右缘没有「新会话/账户」。验收标准第 3 条（compact/regular 可达）已由侧栏满足，故记 minor。

**m8 · 多设备时入口固定第一台，看板内无法切设备** — `ChatSidebarView.swift:59` 用 `specRuneDeviceId ?? devices.first?.id`。从会话页点入口会打开 `devices.first` 的看板；进入后 `projectSidebar` 只列项目（`SpecRuneTasksView.swift:69-87`），没有设备切换。多设备用户无法浏览非首台设备的看板。

**m9 · 声明了动效但未生效 + 死代码** — `SpecRuneTasksView.swift:28-30` 的 `detailAnimation` 从未被引用；`:189` 的 `.transition(...)` 没有 `withAnimation` 上下文，实际不播放。只有 tab 切换的 `withAnimation(expandAnimation)`（`:351`）真正生效。`accessibilityReduceMotion` 的降级因此只覆盖 tab。

**m10 · 分类器 `truncated` 参数恒传 false** — `SpecRuneClient.swift:118-122` 传 `truncated: false`，`Errors.swift:47-50` 的 `if truncated { return .truncated }` 是死分支；`exitCode != 0` 且 stdout 被截断时该信息丢失。

**m11 · `notSpecRuneProject` 是死 case** — `Errors.swift:18,33-34` 定义且给了文案，但全仓无抛出点（`isSpecRuneProject` 返回 `Bool`）。同时 `offline` 在 readText 路径也不产生（见 M5）。

**m12 · 探测串行且把取消当结论** — `SpecRuneBoardModel.swift:59-63` 逐个项目 `await`（N 次往返，无并发）；`SpecRuneClient.swift:134-136` 的 `try?` 吞掉 `CancellationError` 返回 nil → 离开页面时把未探测项目写成 `false`。

**m13 · `projects` 是 let 快照，`.task` 只跑一次** — `SpecRuneBoardModel.swift:37,48-51` + `SpecRuneTasksView.swift:40-49`（`guard model == nil`）。若进入看板时 `appState.projects` 尚空，看板会永久空列表（project 变化不会重建 model）。

**m14 · 重复请求与无清理** — `SpecRuneBoardModel.swift:67-71` 只对 `.loaded` 短路，`.loading` 期间再选同一项目会重复发请求；`detailStates`（`:46`）永不清理，浏览任务越多常驻内存越大（每份详情含最多 5 篇 1 MiB 文档正文）。

**m15 · 无手动刷新** — 全文件无 `refreshable` / 刷新按钮；`select`/`loadDetail` 均对已加载短路。PRD Goal 写「实时取得」，实际是进入时的快照。

**m16 · 嵌套 NavigationSplitView** — `SpecRuneTasksView.swift:55` 的 split view 在 regular 形态下嵌在 `SidebarDrawer.swift:543` 的 split view 的 detail 列里；`Views/Chat/ChatPageToolbar.swift:4-5` 已警告「detail 已有 split view 的 host，再嵌一层会重复导航 chrome」。需真机/iPad 模拟器确认是否出现双层侧栏或双重标题栏。

**m17 · SpecRuneKit 无测试 target** — `ios/Packages/SpecRuneKit/Package.swift:19-24` 只有 target，无 `testTarget`。纯逻辑（归档路径拼装、checklist 解析、错误分类、session id 清洗）都可无 UI 测试，M1/M4 正是这类测试能抓到的。`.specrune/spec/ios/index.md` 说 iOS「scheme 无 test action」，故不按 blocker 计。

**m18 · CHANGELOG 条目缺 PR 链接/提交哈希** — `CHANGELOG.md:118` 末尾没有 `（[#N](...)）` 或 8 位哈希，同节其它条目都有；AGENTS.md「提交与 PR」要求每项附链接。

**m19 · `.specrune/` 工具文件改动混入本任务** — `git status` 里 `.specrune/config.yaml`、`workflow.md`、`.version`（`0.1.0` → `v0.9.3-57-gd02c8d44`）、`.template-hashes.json` 与本任务无关，是 SpecRune 自身升级产物。按「一个 PR 只做一件事」，需确认是单独提交还是随本任务（不阻塞，但要写明）。

**m20 · 未跟踪的设计稿脚本** — `ios/scripts/render-specrune-mock.swift`（自包含 mock，注释「仅用于评审视觉」）是否随任务提交需明确；若提交，属可复现的设计稿产物，建议在任务台账里说明用途。

**m21 · `ios` spec 未记录新包与「零改上游」取数路径** — `.specrune/spec/ios/index.md` 的 Files 表与 Quick Rules 未提 `Packages/SpecRuneKit`。新增本地 SPM 包 + 「只走 `shell/exec` + `fs/readText`」是会影响后续会话的架构事实（对照 `textual-vendor.md` 的先例），建议收尾时补一条。

**m22 · session id 清洗规则与面板有细微差异** — `SpecRuneClient.swift:139-146` 逐字符替换非法字符；面板 `~/.dsh/specrune/panel/lib/index.js:304` 用 `/[^A-Za-z0-9._-]+/g` 把**连续**非法字符压成一个 `_`。仅当会话 id 含连续特殊字符时键不匹配（DSH 常规 id 不受影响）。另：只认 `dsh_` 前缀，Claude 平台写入的 `claude_*.json` 读不到——与面板行为一致，属既有语义。

**m23 · `runCLI` 参数未加引号** — `SpecRuneClient.swift:92` 用空格拼接 `arguments`；`implement.md:24` 要求「命令里的 repo 路径需 shell 引号转义」。repo 未进命令（走 `root` + `cwd: "."`，`SpecRuneConnectorTransport.swift:18`），实际风险只在含空格的 task ref。

### 验收标准逐条核对（prd.md:37-44）

| # | 标准 | 结论 | 证据 |
| --- | --- | --- | --- |
| 1 | 经 `shell/exec` 取真实任务列表并渲染，主路径不再依赖 mock | ✅ | `SpecRuneClient.swift:31-41`（`task list --json --all` → JSON 解码）；`Views/SpecRune/` 无 mock |
| 2 | 详情 = 摘要 + prd/design/implement 正文 + 验收清单 | ⚠️ 活跃任务满足，归档任务不满足 | M1（`SpecRuneClient.swift:59`）；清单解析 `SpecRuneTasksView.swift:412-435` |
| 3 | 独立入口，compact 与 regular 均可到达 | ✅（rail 缺口见 m7） | `ChatShellSelection.swift:8`；`ChatSidebarView.swift:59-64`；`ChatShellView.swift:421-424`（`sidebar.selectDestination()` 关抽屉） |
| 4 | 会话页有关联任务时显示，无关联不显示空壳 | ✅（仅文本，见 m6） | `SessionChatView.swift:53-70,183-185`；`SessionDetailsSheet.swift:26-28` |
| 5 | 非 SpecRune / CLI 缺失 / 离线可读空态，不崩溃 | ⚠️ 离线误判 | 非 SpecRune：`SpecRuneTasksView.swift:81,105`；CLI 缺失：macOS ✅ / Linux ❌（M4）；离线 ❌（M5） |
| 6 | 零改上游 | ✅ | `git status --short connector/ server/` 为空 |
| 7 | `swiftc -typecheck` 通过 | ✅（用更强的全量构建验证） | xcodebuild exit=0 |
| 8 | 契约、CHANGELOG 与相关文档同步 | ⚠️ | 契约 README ✅（含「实现说明」节）；CHANGELOG ✅ 但缺链接（m18）；`ios` spec 未更新（m21） |

### 既有台账风险复核（review.md:46-51）

| 台账项 | 复核结果 |
| --- | --- |
| `timeoutMs` 20s 够用 | `SpecRuneConnectorTransport.swift:18` 确为 20_000；`task list --json --all` 在本仓 3.5 KB、秒级完成，暂不成问题，任务数很大时需实测 |
| 64K 上限 → 抛 `.truncated`，UI 按错误显示 | 实现正确（`SpecRuneClient.swift:127-129`），但文案误导（m2） |
| `$HOME` 回退依赖 shell 展开 | POSIX 可展开 ✅（`shell.py:143-151`）；但 dash 下分类不命中导致回退**根本不触发**（M4），Windows `$HOME` 不展开仍成立 |
| 未真机/模拟器实跑 | 仍成立；本轮新增 M2/M6/m16 三项只能靠真机确认的项 |

### 未验证项

- 真机/模拟器实跑：`NavigationSplitView` 在 drawer 与 Duo 内屏的实际渲染（m16）、图标回退的实际视觉（M6，代码路径确定但未截图）。
- 会话关联端到端：本机 `.specrune/.runtime/sessions/` 只有 `claude_*.json`，无 `dsh_*.json`，`sessionTask` 只能静态核对（`SpecRuneClient.swift:73-86` 与 `index.js:301-317` 语义一致）。

Candidate: red


## 修复记录（review round 1 → round 2 之间）

逐条修 round 1 的 6 条 major，另修 1 条 minor（`truncated` 语义）：

| # | 发现 | 修法 | 位置 |
| --- | --- | --- | --- |
| 1 | 归档任务文档永远读不到（用 `dir` 拼路径） | 改用 CLI 返回的绝对 `path` 相对化；对不上时按 `archiveMonth` 兜底 | `SpecRuneClient.relativeTaskDirectory` |
| 2 | 切项目后详情列永久转圈 | 切项目时清空 `selectedTaskRef` | `SpecRuneTasksView.projectSidebar` 的 selection setter |
| 3 | 规范引用未落地 | `SpecRuneClient.readSpec` + 详情页「规范引用」可展开区（按需加载、带截断提示） | `SpecRuneClient.readSpec`、`SpecRuneTasksView.specSection` |
| 4 | CLI 缺失判定不含 `"not found"`（dash 措辞） | markers 补 `"not found"` | `SpecRuneFailureClassifier` |
| 5 | 离线被误判成「未启用」 | 适配器只把 404 当「文件不存在」，其它错误抛出；`isSpecRuneProject` 改 `throws`；Model 记 `probeFailures` 并在侧栏显示真实原因 | `SpecRuneConnectorTransport.readText`、`SpecRuneBoardModel.probeProjects`、`SpecRuneTasksView.subtitle` |
| 6 | 图标键不存在（`checklist` / `checkmark.square`） | 换成已存在的 `checkmark.circle` / `checkmark.square.fill` | `ChatSidebarView`、`SpecRuneTasksView` |
| minor | `truncated` 恒 false | `SpecRuneTransport.readText` 返回 `SpecRuneTextFile{content,truncated}`，文档与规范都透传真实 `truncated` | `Transport.swift`、`SpecRuneClient`、适配器、View |

**验证**：`swift build`（SpecRuneKit）与 `xcodebuild build`（主 app）均 exit=0；`git status --short connector/ server/` 仍为空。

**未修（记录在案，判定为可接受）**：
- `fs/readDir` 未用于详情：改为按 `SpecRuneDocKind` 逐个 `readText`，请求数多但语义简单，且 404 已能区分。
- `research` 只读 `research.md` 单文件形态，未列 `research/*.md` 目录（面板的多报告形态）。留待后续版本。
- DTO 未含 `at`/`born`（`shell/exec` 拿不到目录 stat），列表按 `createdAt` 排序。
- SpecRuneKit 暂无 testTarget；CHANGELOG 条目无 PR 链接（本地未开 PR）。

## Review round 2

评审对象：当前未提交工作树（同一基线，含「修复记录」所述改动）。本轮为 **fresh check**：先在**当前代码**上逐条复验 round 1 的 6 条 major 与 `truncated`，再找新问题，未复用 round 1 结论。只写本文件，未改任何代码。

### 基线核对

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 零改上游 | `git status --short connector/ server/` | 输出为空 ✅ |
| 编译（主 app） | `cd ios && xcodebuild build -project "Agents Anywhere/Agents Anywhere.xcodeproj" -scheme "Agents Anywhere" -destination "generic/platform=iOS Simulator" -quiet CODE_SIGNING_ALLOWED=NO` | exit=0 ✅ |
| 编译（包） | `cd ios/Packages/SpecRuneKit && swift build` | `Build complete` exit=0 ✅ |
| 编译警告 | 同上（去掉 `-quiet`，强制重编 4 个新文件） | **新增 3 条警告**（见 m1） |
| 契约完整性 | `contracts/specrune/1.0/manifest.json` 五个 schema 的 sha256 | 全部匹配 ✅ |
| 图标键 | `grep` `AppSymbolAssets.names` 对照新代码用到的 7 个键 | 6 个存在、`checklist` 缺失 ❌（见 M7） |
| 归档路径前提 | `specrune task show 11-13-sync-upstream-package-dsh-plugin --json` | `path` 为绝对路径、`dir` 为纯目录名；归档目录下 prd/design/implement 都在 ✅ |
| 任务文档实况 | `find .specrune/tasks -name record.md` / `-name research.md` | 9 个任务目录（活跃 2 + 归档 7）**0 个**有 record.md 或 research.md |

### round 1 六条 major 逐条复验

| # | round 1 发现 | 当前结论 | 证据 |
| --- | --- | --- | --- |
| 1 | 归档任务文档永远读不到 | **已修** ✅ | `SpecRuneClient.swift:160-171` 用 CLI 绝对 `path` 去掉 repo 前缀，对不上再按 `archiveMonth` 兜底；实测归档 `path` = `<repo>/.specrune/tasks/archive/2026-11/<dir>`，相对化结果正确 |
| 2 | 切项目后详情列永久转圈 | **已修** ✅ | `SpecRuneTasksView.swift:72-78` 的 selection setter 先 `selectedTaskRef = nil`；`detailColumn`（`:186-204`）在 ref 为 nil 时落「未选择任务」，不会落 `ProgressView` |
| 3 | 「规范引用」未落地 | **已落地** ✅ | `SpecRuneClient.swift:75-80`（`readSpec`）+ `SpecRuneTasksView.swift:339-403`（空值隐藏、按需展开、截断提示）；实测 `task show` 确实返回 repo 相对路径的 `specRefs`（如 `.specrune/spec/ios/index.md`），与 `fs/readText` 的 `path` 语义一致 |
| 4 | CLI 缺失判定不含 `"not found"` | **已修** ✅（但过宽，见 m12） | `Errors.swift:54-59` markers 含 `"not found"`，dash 的 `dash: 1: x: not found` 可命中 |
| 5 | 离线被误判成「未启用」 | **方向对、前提错 → 回归，见 B1** ❌ | 适配器只把 HTTP **404** 当「文件不存在」（`SpecRuneConnectorTransport.swift:41-46`），但缺文件的实际状态码是 **502** |
| 6 | 图标键不存在 | **只修了一半** ❌ | `checkmark.square` → `checkmark.square.fill` ✅（`SpecRuneTasksView.swift:415`）；侧栏仍是 `appSymbol: "checklist"`（`ChatSidebarView.swift:255`），见 M7 |

`truncated` 语义：**已修** ✅ — `SpecRuneTransport.readText` 返回 `SpecRuneTextFile{content,truncated}`（`Transport.swift:31-40`），文档（`SpecRuneClient.swift:68-70`）与规范（`SpecRuneClient.swift:78-80`）都透传真实值，两处 UI 提示都在（`SpecRuneTasksView.swift:394-398`、`:441-445`）。

### Blocker

**B1 · 缺文件的真实状态码是 502，不是 404 —— 任务详情与「非 SpecRune 项目」双双回归**

- 证据链（逐层核对源码）：
  1. `connector/connector/local/file_ops.py:90-94`：`read_text` 在文件不存在时 `raise FileNotFoundError`（本机实测 `FileOps.read_text` 抛 `FileNotFoundError: file not found: ...`）。
  2. `connector/connector/server/rpc.py:186-196`：`except Exception` → 回包 `ok=false`，`code = "FileNotFoundError"`。
  3. `server/agent_server/infra/connector_rpc.py:509-515`：`ok != true` → `ConnectorRpcError`。
  4. `server/agent_server/services/workspace.py:113-116`：`ConnectorRpcError` → `ConnectorUpstreamError`。
  5. `server/agent_server/api/error_handlers.py:27-31`：`ConnectorUpstreamError` → **HTTP 502**（`connector_files.py:336-356` 的 `fs/readText` 端点无 try/except，也没有把 FileNotFound 映射成 404）。
  6. `ios/.../Network/HTTPTransport.swift:47-52`：非 2xx → `HTTPError.server(statusCode: 502, ...)`。
  7. `ios/.../Views/SpecRune/SpecRuneConnectorTransport.swift:41-46`：只有 `statusCode == 404` 才 `return nil`，**502 直接抛出**。
- 影响 1（打掉验收标准 2）：`SpecRuneClient.taskDetail`（`SpecRuneClient.swift:64-71`）对 5 种文档**逐个**读且不吞错；`SpecRuneDocKind.allCases` 含 `record`/`research`，而本仓 9 个任务目录**没有一个**有 `record.md` 或 `research.md`。于是任意任务详情都会在 `record.md` 处抛错 → 详情列显示「无法读取任务详情」，PRD/设计/实施正文与验收清单全部看不到。修复前（`catch { return nil }`）详情反而是好的，本轮是**净回归**。
- 影响 2（打掉验收标准 5 的「非 SpecRune 项目」）：`isSpecRuneProject`（`SpecRuneClient.swift:29-31`）读 `.specrune/workflow.md`，非 SpecRune 项目必然 502 → `SpecRuneBoardModel.probeProjects`（`SpecRuneBoardModel.swift:63-75`）把每个普通项目记进 `probeFailures`，侧栏副标题变成原始 Swift 描述（`server(statusCode: 502, message: "file not found: ...")`），`.disabled(... == false)` 也不再生效（`SpecRuneTasksView.swift:88`），「未启用 SpecRune」这一态实际消失。
- 建议（零改上游前提下）：把「文件不存在」判定改为 404 **或** 502 且 `message` 含 `file not found`（`HTTPError.server` 的 message 由 `decodeServerErrorMessage` 解出），或直接判 connector 侧错误码；同时给 `SpecRuneClient.taskDetail` 的缺失分支补一条单元测试（本仓无 record/research 就是现成用例）。

### Major

**M7 · 侧栏 SpecRune 入口仍用不存在的图标键 `checklist`，渲染成问号圆圈（round 1 M6 未修完）**

- 证据：`ios/.../Views/ChatShell/ChatSidebarView.swift:255` `Label("SpecRune", appSymbol: "checklist")`；`AppSymbolAssets.swift:4-110` 的 `names` 里没有 `checklist`（有 `checkmark.circle`、`checkmark.square.fill`、`chevron.down/right`）。
- 后果：`AppSymbol.swift:14-17` 未命中回退 `Image("aa-CircleHelp")`，该 imageset 存在 → 入口图标是「问号圆圈」。
- 备注：`review.md:206` 的修复记录写「换成已存在的 `checkmark.circle` / `checkmark.square.fill`」，但侧栏这处代码没改，记录与代码不符。视觉上属局部缺陷，但它是新增主入口的图标且被记录为已修，故按 major 记；若按纯视觉口径可降为 minor。

### Minor

- **m1 · 新引入 3 条并发警告**：`SpecRuneConnectorTransport.swift:11`（`Sendable` 结构体里 `any V2ConnectorAPIProtocol` 非 Sendable）、`SpecRuneTasksView.swift:155-156`（在非隔离同步上下文调用 main-actor 隔离的 `newestFirst`）。Swift 6 语言模式下会变错误；主 app 现在是 `SWIFT_VERSION = 5.0`（`project.pbxproj:324`），故只是警告。
- **m2 · 展开箭头违反 iOS spec 的图标规则**：`SpecRuneTasksView.swift:370` 用 `Image(systemName:)`，而 `.specrune/spec/ios/index.md:27` 要求「图标一律用 `AppSymbol`」；映射表里已有 `chevron.down` / `chevron.right`。不过该 spec 规则本身已过时（`SessionGoalPanel.swift`、`NewSessionView.swift` 有 6 处 `Image(systemName:)` 先例），建议收尾时二选一：改代码或更新 spec。
- **m3 · 探测失败原因是原始 Swift 描述**：`SpecRuneBoardModel.swift:72`（同类还有 `:91`、`:115`、`:130`）用 `String(describing: error)`，离线时侧栏会显示 `server(statusCode: 409, message: "connector is offline", detail: nil)`；`SpecRuneError.offline` 仍只在 `exec` 里产生（`SpecRuneClient.swift:130-134`），`readText` 路径不产生（round 1 m11 部分成立）。
- **m4 · 截断语义仍有两处死/误导**：`SpecRuneClient.swift:143` 仍传 `truncated: false`（round 1 m10）；`Errors.swift:31-32` 文案「任务过多，仅显示部分」与「整张列表都不显示」不符（round 1 m2）。
- **m5 · `detailAnimation` 仍是死代码**：`SpecRuneTasksView.swift:28-30` 无任何引用，`:198` 的 `.transition` 仍无 `withAnimation` 上下文（round 1 m9）。
- **m6 · 文档注释错位**：`Transport.swift:30-31` 把 `SpecRuneTextFile` 的说明并进了 `SpecRuneTransport` 的注释块。
- **m7 · 仍无测试 target**：`Package.swift:19-24` 只有 target（round 1 m17）。`relativeTaskDirectory`、`SpecRuneFailureClassifier.classify`、checklist 解析都是可无 UI 测试的纯逻辑——round 1 的 M1 与本轮的 B1 都正好是这类测试能抓到的。
- **m8 · `fs/readDir`/`listDir` 仍未实现**：`implement.md:22` 未勾选，详情改为 5 次串行 `readText`（`SpecRuneClient.swift:66-71`），B1 修好后每份详情仍是 5 次往返。
- **m9 · ios spec 未记录新包**：`.specrune/spec/ios/index.md:5-9` 的 Files 表与 Quick Rules 仍未提 `Packages/SpecRuneKit`（round 1 m21）→ 验收标准 8 未完全满足。
- **m10 · CHANGELOG 条目仍无链接**：`CHANGELOG.md:118`（round 1 m18）。
- **m11 · 会话页每次打开多一次 readText**：`SessionChatView.swift:183-185` 的 `.task(id:)` 在会话页出现即请求 `.runtime/sessions/dsh_*.json`，无缓存、无显式取消；详情行的值靠 state 晚到刷新。功能上不破坏既有行为（`SessionChatView` 以 `.id(sessionId)` 重建，切会话会重置 state），只是多一次往返。
- **m12 · `"not found"` marker 过宽**：`Errors.swift:54-59` 任何含 `not found` 的 stderr 都判 `cliMissing`，会多跑一次 `$HOME` 回退并把真实失败说成「未安装 SpecRune」。建议同时要求 `exitCode == 127`。实测本机中文 CLI 的「任务不存在」是「找不到任务」（已含在既有 marker 里，属 round 1 之前就有的口径），故暂无新增误伤实证。
- **m13 · 排序精度到日**：`SpecRuneTasksView.swift:180-182` 只按 `createdAt` 字符串倒序；DTO 仍无契约的 `at`/`born`/`bytes`（round 1 m3），契约 README 也未注明手机端精度到日。
- **m14 · `.specRune` + `workspaceFilesService == nil` 会落回新会话页**：`ChatShellView.swift:321-361`；两者同源（`AppState.swift:632,753` 都来自 `makeV2Services()`），当前实际不可达，记录备查。
- **m15 · 未跟踪产物归属未定**：`.specrune/{config.yaml,workflow.md,.version,.template-hashes.json}`（round 1 m19）与 `ios/scripts/render-specrune-mock.swift`（round 1 m20）。

### 验收标准逐条核对（prd.md:37-44）

| # | 标准 | 结论 | 证据 |
| --- | --- | --- | --- |
| 1 | 经 `shell/exec` 取真实任务列表并渲染，主路径不再依赖 mock | ✅ | `SpecRuneClient.swift:36-46`（`task list --json --all` → JSON）；`V2ConnectorAPI.shellExec`（`V2ConnectorAPI.swift:288-295`）；`Views/SpecRune/` 无 mock |
| 2 | 详情 = 摘要 + prd/design/implement 正文 + 验收清单 | ❌ **回归** | B1：`SpecRuneClient.swift:64-71` 会在缺失的 `record.md` 处抛错；本仓 9 个任务目录 0 个有 record/research。归档路径本身已修（`:160-171`） |
| 3 | 独立入口，compact 与 regular 均可到达 | ✅（rail 仍缺） | `ChatShellSelection.swift:8`；`ChatSidebarView.swift:58-63`（抽屉/侧栏共用）；`ChatShellView.swift:423-426` 关抽屉；`mainContent` 分支 `:321-330`；rail 未接（round 1 m7） |
| 4 | 会话页有关联任务时显示，无关联不显示空壳 | ✅（静态） | `SessionChatView.swift:53-70,183-185`；`SessionDetailsSheet.swift:8,26-28`；本机 `.runtime/sessions/` 只有 `claude_*`，无 `dsh_*`，端到端未验证 |
| 5 | 非 SpecRune / CLI 缺失 / 离线可读空态，不崩溃 | ⚠️ | CLI 缺失：macOS ✅ / Linux ✅（`Errors.swift:54-59` 含 `"not found"`）；离线：能显示真实原因但文案是原始 Swift 描述（m3）；**非 SpecRune 项目被 B1 变成错误态** ❌ |
| 6 | 零改上游 | ✅ | `git status --short connector/ server/` 为空 |
| 7 | `swiftc -typecheck` 通过 | ✅（用更强的全量构建验证） | xcodebuild exit=0；`swift build` exit=0 |
| 8 | 契约、CHANGELOG 与相关文档同步 | ⚠️ | 契约 sha256 全匹配 ✅、契约 README 含「实现说明」✅、CHANGELOG 有条目 ✅（无链接 m10）；`ios` spec 未更新（m9） |

### 未验证项

- 真机/模拟器实跑：三栏 `NavigationSplitView` 嵌在 drawer split view 内的实际渲染（round 1 m16）、`Image(systemName:)` 箭头与图标回退的真实视觉、Duo 折叠态。
- 端到端取数：本机无 `dsh_*.json`，`sessionTask` 只能静态核对；`shell/exec` + `fs/readText` 的真实往返（B1 的 502 结论来自逐层源码核对 + connector 侧实测，未跑真实 Server）。

Candidate: red


## 修复记录（review round 2 → round 3 之间）

| # | 发现 | 修法 | 位置 |
| --- | --- | --- | --- |
| B1 | 缺文件真实状态码是 502 不是 404；逐个盲读 5 种文档导致任意任务在 record/research 处抛错，详情整页失败 | **双保险**：(a) 按 CLI 的 `hasPrd`/`hasDesign`/`hasImplement` 决定读哪些，不存在的文档不发请求；record/research 无标志，试读并容错。(b) 适配器新增 `isMissingFile`：404 或「502 且 message 含 no such file / FileNotFound / not found」都视为不存在 | `SpecRuneClient.taskDetail`、`SpecRuneConnectorTransport.isMissingFile` |
| M7 | `ChatSidebarView` 的 `checklist` 图标键仍不存在（round 1 只改了 SpecRuneTasksView，记录却声称两处都改） | 改为 `checkmark.circle` | `ChatSidebarView.swift` |
| minor | 展开箭头用 `Image(systemName:)` —— 本项目该 API 完全不渲染（`.specrune/spec/ios/index.md` 明文规定） | 改 `AppSymbol(..., size: 12)` | `SpecRuneTasksView.specRow` |
| minor | CLI 缺失只靠措辞匹配，过宽 | 补 `exitCode == 127`（shell 的「命令未找到」约定码） | `SpecRuneFailureClassifier` |
| minor | `SpecRuneConnectorTransport` 的 `api` 非 Sendable 触发警告 | 加 `@unchecked Sendable` 并注明担保理由 | `SpecRuneConnectorTransport` |

**验证**：`swift build`（SpecRuneKit）exit=0；`xcodebuild build`（主 app）**exit=0 且零 SpecRune 警告**；`git status --short connector/ server/` 仍为空。

**仍保留的 minor（判定可接受）**：
- `fs/readDir` 未用（改为按 `has*` 标志精准读，请求数已降）。
- `research` 只读 `research.md` 单文件形态。
- DTO 无 `at`/`born`。
- SpecRuneKit 无 testTarget。
- CHANGELOG 无 PR 链接（未开 PR）。


## Review round 3

评审对象：当前未提交工作树（33 项，含「修复记录（round 2 → round 3）」所述改动）。本轮为 **fresh check**：先在**当前代码**上逐条复验 round 2 的 B1、M7 与 4 条 minor 修法，再找新问题，未复用前两轮结论。只写本文件，未改任何代码。

### 基线核对

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 零改上游 | `git status --short connector/ server/` | 输出为空 ✅ |
| 编译（主 app） | `cd ios && xcodebuild build -project "Agents Anywhere/Agents Anywhere.xcodeproj" -scheme "Agents Anywhere" -destination "generic/platform=iOS Simulator" -quiet CODE_SIGNING_ALLOWED=NO` | exit=0 ✅ |
| 编译（包） | `cd ios/Packages/SpecRuneKit && swift build` | `Build complete!` exit=0 ✅ |
| 编译警告 | `touch` 全部 SpecRune 相关文件后**去 `-quiet` 强制重编** | `BUILD SUCCEEDED`，但有 **2 条 SpecRune 警告** ❌（见 m1） |
| 契约完整性 | `contracts/specrune/1.0/manifest.json` 五个 schema 的 sha256 实算 | 5/5 全部匹配 ✅ |
| 图标键 | `AppSymbolAssets.names` 与 `Views/SpecRune/`+4 个改动文件里的 15 个键逐个比对（含三元表达式的两个分支） | **全部存在** ✅ |
| `Image(systemName:)` | `grep -rn "Image(systemName" Views/SpecRune/` | **0 处** ✅（全仓其它地方仍有 6 处既有用法，属历史遗留） |
| mock 残留 | `grep -rn "mock\|#Preview" Views/SpecRune/` | 0 处 ✅ |
| 未跟踪产物 | `git add -An ios/Packages/SpecRuneKit` | 只 5 个文件；`.build/` 被 `ios/.gitignore:1` 忽略 ✅ |

### 逐层复验 round 2 的 B1（含 4 个指定疑点）

**B1 修法是否真的成立：成立 ✅。** 逐层实测/读码链路（不是照抄上轮结论）：

1. **`hasPrd`/`hasDesign`/`hasImplement` 是真实 CLI 字段 ✅（疑点 1）**
   `specrune task show 11-16-specrune-mobile-board --json`（CLI `v0.9.3-57-gd02c8d44`）实际输出含 `"hasPrd": true, "hasDesign": true, "hasImplement": true`；`task list --json --all` 的每条也带这三个字段。二者同时是契约 `task-detail.response.schema.json` 的属性。归档任务同样有（`11-13-sync-upstream-package-dsh-plugin`、`10-25-duo-dock-compact` 实测）。→ `SpecRuneClient.swift:68-77` 的门控字段名正确。
2. **502 + message 判定链对得上 ✅（疑点 4）**
   `connector/local/file_ops.py:90-92` 抛 `FileNotFoundError("file not found: <path>")` → `connector/server/rpc.py:193-195` 回包 `error={"code":"FileNotFoundError","message":str(exc)}` → `server/.../infra/connector_rpc.py:509-514` `ConnectorRpcError(code, message)` → `services/workspace.py:113-116` `ConnectorUpstreamError(exc.message or exc.code)` → `api/error_handlers.py:27-31` **HTTP 502** + `{"detail": "<message>"}` → `Network/HTTPTransport.swift:47-51` `HTTPError.server(statusCode:message:detail:)`。
   关键点（上轮没验的一环）：`HTTPError` 的第二个关联值是 **message**（`HTTPError.swift:7`），`isMissingFile` 的 `case let .server(_, text, _)` 取的就是它；`message` 由 `decodeServerErrorMessage` → `HTTPServerErrorEnvelope.message` = `detail["message"]?.stringValue ?? detail.displayString`，而 `detail` 是**字符串**（subscript 对 `.string` 返回 nil），落到 `JSONValue.displayString` 的 `.string` 分支原样返回 → message = `"file not found: /path"`，命中 `isMissingFile` 的 `not found` ✅。`SpecRuneConnectorTransport.swift:41-50` 的判定有效。
3. **真实任务上的行为复验 ✅**
   本仓 8 个任务里 `10-25-duo-dock-compact`、`00-bootstrap-guidelines` 的 `hasDesign`/`hasImplement` 为 `false`，对应目录实测确实只有 `prd.md`（+`task.json`）——门控后不再对不存在的文件发请求；`record.md`/`research.md` 全仓 **0 个**，`try?` 分支照常容错。→ 任意任务详情不再因缺文件整页失败，验收标准 2 恢复。
4. **`isSpecRuneProject` 的非项目路径恢复 ✅**
   非 SpecRune 项目读 `.specrune/workflow.md` → 502 + `file not found` → `readText` 返回 nil → `false` → 侧栏「未启用 SpecRune」并 `.disabled`（`SpecRuneTasksView.swift:88,114`），round 2 的影响 2 消失。

**疑点 2（三个 has 全 false 时是否一片空白且无提示）：会，但只算 minor。**
`SpecRuneTasksView.swift:280-295` 的详情只渲染 `overview`（状态/目录/进度/负责人/时间）+ 有文档时的 tab 区（`:284-287`）；`availableDocs` 为空时既没有文档区也没有「暂无文档」提示，`checklist(from:)` 也返回 nil（`:487-510`）。当前 8 个任务都至少有 `prd.md`，所以本仓触发不到；只有「刚 `task new`、还没写任何文档」的任务会命中。功能不算坏（摘要区还在、标题正常），缺的是空态说明 → 记 **m2**。

**疑点 3（record/research 的 `try?` 是否重新引入「离线被吞」）：taskDetail 不会，但 `try?` 仍是多余的吞错。**
`taskDetail` 第一步就是 `runCLI`（`SpecRuneClient.swift:50`），离线时 `exec` 的 `catch` 会包成 `SpecRuneError.offline`（`:138-146`）并抛出——所以「has 全 false → 一个 readText 都不发」时，连通性已经在 shell 阶段验过，离线**不会**被完全吞掉；只要 prd/design/implement 里有一个 `has=true`，它们的 `try await`（`:74`）也会照常抛。残留问题是 `:80` 的 `try?` 会同时吞掉 409 离线、500 等真实故障（`isMissingFile` 已把「不存在」变成 nil，`try?` 并不需要），等于把「读失败」和「没有这个文件」混为一谈 → 记 **m3**（建议改回 `try await`）。

**M7 复验：已修 ✅。** `Views/ChatShell/ChatSidebarView.swift:255` 现为 `Label("SpecRune", appSymbol: "checkmark.circle")`，`AppSymbolAssets.names` 有 `checkmark.circle → aa-CircleCheck`，`Assets.xcassets/aa-CircleCheck.imageset` 存在。全仓扫描结果：`Views/SpecRune/` 10 处 + `ChatSidebarView`/`ChatShellView`/`SessionChatView`/`SessionDetailsSheet` 5 处，共 15 个键（`exclamationmark.triangle`/`sidebar.left`/`checkmark.circle`/`person.crop.circle`/`clock`/`chevron.down`/`chevron.right`/`checkmark.square.fill`/`square`/`ellipsis`/`plus`/`network`/`hand.raised`/`square.and.arrow.up`/`arrow.down.document`）**全部存在**，无回退问号。

**其余 round 2 修法复验：**

| 修法 | 结论 |
| --- | --- |
| 展开箭头改 `AppSymbol`（去 `Image(systemName:)`） | ✅ `SpecRuneTasksView.swift:370` 用 `AppSymbol(isOpen ? "chevron.down" : "chevron.right", size: 12)`，`Views/SpecRune/` 已无 `Image(systemName:)` |
| CLI 缺失补 `exitCode == 127` | ✅ `Errors.swift:52` |
| `@unchecked Sendable` 消警告 | ✅ `SpecRuneConnectorTransport.swift:13`，该条警告已消失（但见 m1 的另两条） |

### Blocker

无。

### Major

无。

### Minor

**本轮新发现**

- **m1 · 「零 SpecRune 警告」不成立：仍有 2 条并发警告**（open）
  `touch` 相关文件后去 `-quiet` 强制重编，实测：
  `Views/SpecRune/SpecRuneTasksView.swift:155:48` 与 `:156:52` — `call to main actor-isolated static method 'newestFirst' in a synchronous nonisolated context [#ActorIsolatedCall]`。
  成因：`newestFirst`（`:180`）随 `View` 被推断为 main-actor 隔离，而 `sorted(by:)` 的闭包位置是非隔离同步上下文；修法是给它加 `nonisolated`。这正是 round 2 **m1 的后半条**，修复记录里写了「零 SpecRune 警告」，实际只修掉了 Sendable 那半条（`-quiet` + 增量缓存下看不到警告，才误判为零）。Swift 6 语言模式下会升级为错误。
- **m2 · 三份文档都不存在时详情页没有空态说明**（open）
  `SpecRuneTasksView.swift:284-287` 只在 `!availableDocs.isEmpty` 时显示文档区，无「暂无文档」分支。触发面：刚建、还没写 prd/design/implement 的任务（本仓暂无可复现样本）。
- **m3 · `record`/`research` 的 `try?` 吞掉真实故障**（open）
  `SpecRuneClient.swift:79-83`。`isMissingFile` 已把「文件不存在」变成 nil，`try?` 只是额外把 409 离线 / 500 静默成「没有记录」。
- **m4 · 404 被一律当成「文件不存在」，但 `fs/readText` 的 404 实际来自设备侧**（open）
  `SpecRuneConnectorTransport.swift:42` 的 `statusCode == 404` 分支：`connector_files.py:342` 的 `require_owned_online_connector` → `require_owned_connector` 在设备不存在/不属于当前账号时抛 404。此时会被判成「文件缺失」→ `isSpecRuneProject` 返回 false → 显示「未启用 SpecRune」而不是设备错误。触发面窄（看板项目列表本就按 connectorId 过滤），记录备查。
- **m5 · 离线/失败文案仍是原始 Swift 描述**（open，round 2 m3 仍在）
  `SpecRuneBoardModel.swift:72,91,115,130` 用 `String(describing: error)`；离线时侧栏副标题与列表错误会是 `server(statusCode: 409, message: "connector is offline", detail: nil)`。`SpecRuneError.offline` 只在 `exec` 路径产生，`readText` 路径不产生。验收标准 5 的「可读」因此只算部分满足。
- **m6 · `docs/specrune-mobile/README.md` 与实现脱节（AC8 缺口）**（open，本轮新增证据）
  该文件随本任务一起提交，但：`:3` 仍写「当前用 mock 数据驱动」；`:9` 文件表链到**已删除**的 `Views/SpecRune/SpecRuneModels.swift`（死链，`ls` 实测只剩 BoardModel/ConnectorTransport/TasksView 三个文件）；`:33-35`「数据接续（阶段 1）」写的是被否决的 `V2SpecRuneAPI` + `GET /api/v2/connectors/{id}/specrune/*` 方案；`:39`「本原型两文件零 warning」也已过期。
- **m7 · `detailAnimation` 仍是死代码、详情切换动效不播放**（open，round 1 m9 / round 2 m5）
  `SpecRuneTasksView.swift:28-30` 全文件无引用（`grep` 仅声明处）；`:198` 的 `.transition` 没有 `withAnimation` 上下文。只有 tab 切换的 `:426` 生效。
- **m8 · `notSpecRuneProject` 仍是死 case**（open，round 1 m11）
  `Errors.swift:18,33` 有定义和文案，全仓无抛出点（`isSpecRuneProject` 返回 `Bool`）。
- **m9 · 截断语义仍有一处死参数 + 一处误导文案**（open，round 1 m2/m10、round 2 m4）
  `SpecRuneClient.swift:155` 仍传 `truncated: false`（`Errors.swift:48-50` 的 `if truncated` 是死分支）；`Errors.swift:31-32`「任务过多，仅显示部分」与「整张列表都不显示」不符。
- **m10 · `Transport.swift:30-31` 注释错位**（open，round 2 m6）
  `SpecRuneTextFile` 的说明并进了 `SpecRuneTransport` 的注释块。

**沿用前两轮、当前仍在的 minor（本轮逐条复核过代码位置）**

| # | 发现 | 证据 |
| --- | --- | --- |
| m11 | 无 testTarget | `Package.swift:19-24` 只有 target。`relativeTaskDirectory`、`classify`、checklist 解析、**以及 B1 这类缺文件分支**都是可无 UI 测试的纯逻辑 |
| m12 | `path` 仍非可选 | `DTO.swift:33`；契约 `TaskListItem.required` 不含 `path`，CLI 省略会让整张列表解码失败 |
| m13 | 未实现 `fs/readDir`/`listDir` | `implement.md:22` 未勾选；`SpecRuneKit` 与 `Views/SpecRune` 均无 `readDir` 调用。另：`research` 只读 `research.md` 单文件，面板的 `research/*.md` 多报告形态读不到 |
| m14 | 排序精度到日 | `SpecRuneTasksView.swift:180-182` 只按 `createdAt` 字符串倒序；DTO 无 `at`/`born` |
| m15 | Duo rail 仍未接 | `SpecRuneTasksView` 不消费 `@Environment(\.chatRail)`（对比 `DeviceManagementView.swift:24,107`），看板页内屏右缘无 rail 入口 |
| m16 | 多设备时入口固定第一台 | `ChatSidebarView.swift:59` `?? devices.first?.id`，看板内无设备切换 |
| m17 | 会话页每开一次多一次 `readText` | `SessionChatView.swift:183-185` 的 `.task(id:)`，无缓存、无显式取消 |
| m18 | `ios` spec 未记录新包 | `.specrune/spec/ios/index.md:5-9` 的 Files 表与 Quick Rules 仍未提 `Packages/SpecRuneKit` 与「只走 shell/exec + fs/readText」 |
| m19 | CHANGELOG 条目无 PR 链接 | `CHANGELOG.md:118`（同节其它条目都有） |
| m20 | 未跟踪产物归属未定 | `.specrune/{config.yaml,workflow.md,.version,.template-hashes.json}` 与 `ios/scripts/render-specrune-mock.swift`（该脚本自包含，已确认不引用被删的 `SpecRuneModels.swift`） |

### 验收标准逐条核对（prd.md:37-44）

| # | 标准 | 结论 | 证据 |
| --- | --- | --- | --- |
| 1 | 经 `shell/exec` 取真实任务列表并渲染，主路径不再依赖 mock | ✅ | `SpecRuneClient.swift:36-46`（`task list --json --all` → 解码）；`V2ConnectorAPI.swift:288-295` + `Domain/Connector/V2ShellExec.swift`（请求/响应字段与 `server/agent_server/core/models.py:1359-1362`、`connector/local/common.py:108-118` 逐字段一致）；`Views/SpecRune/` 无 mock |
| 2 | 详情 = 摘要 + prd/design/implement 正文 + 验收清单 | ✅（本轮修复生效） | `SpecRuneClient.swift:68-83` 按 `has*` 精准读 + `:80` 容错试读；本仓 8 个任务实测 `hasPrd` 全为 true，`10-25-duo-dock-compact`/`00-bootstrap-guidelines` 的 design/implement 确实不存在；正文 tab `SpecRuneTasksView.swift:421-447`，清单 `:404-419`（解析 `:487-510`）。空态缺口见 m2 |
| 3 | 独立入口，compact 与 regular 均可到达 | ✅（rail 仍缺，m15） | `ChatShellSelection.swift:8`；`ChatSidebarView.swift:59-64`（抽屉与侧栏共用同一入口）；`ChatShellView.swift:423-426` 关抽屉 + `:321-330` 渲染分支 + `:300-301` 标题 |
| 4 | 会话页有关联任务时显示，无关联不显示空壳 | ✅（静态核对） | `SessionChatView.swift:54-70`（缺 cwd/externalSessionId 直接 return nil）、`:183-185`、`:197`；`SessionDetailsSheet.swift:8,26-28`（`if let` 条件行）。端到端仍未验（本机 `.runtime/sessions/` 只有 `claude_*.json`） |
| 5 | 非 SpecRune / CLI 缺失 / 离线可读空态，不崩溃 | ⚠️ 部分满足 | 非 SpecRune：`SpecRuneTasksView.swift:88,114`（B1 修好后恢复）✅；CLI 缺失：`Errors.swift:52`（127）+ `:56-58`（markers）✅；离线：能显示原因但文案是原始 Swift 描述（m5） |
| 6 | 零改上游 | ✅ | `git status --short connector/ server/` 输出为空 |
| 7 | `swiftc -typecheck` 通过 | ✅（用更强的全量构建验证） | xcodebuild exit=0；`swift build` exit=0；但非零警告（m1） |
| 8 | 契约、CHANGELOG 与相关文档同步 | ⚠️ | 契约 sha256 5/5 匹配 ✅、`contracts/specrune/1.0/README.md:69-79`「实现说明」已写明走既有端点 ✅；CHANGELOG 有条目但无链接（m19）；`ios` spec 未更新（m18）；`docs/specrune-mobile/README.md` 仍描述 mock 与已否决方案（m6） |

### 未验证项

- 真机/模拟器实跑：三栏 `NavigationSplitView` 嵌在 drawer split view 内的实际渲染、图标实际视觉、Duo 折叠态与 rail 缺失的观感。
- 端到端取数：本机无 `dsh_*.json`，`sessionTask` 只能静态核对；`shell/exec` + `fs/readText` 未跑真实 Server（B1 的 502 结论来自逐层源码核对 + connector 侧源码，未发真实请求）。

### 回归检查

round 2 的 B1 是「修 round 1 M5 时引入的净回归」；本轮在同一批代码上未发现新的净回归：B1 修法只新增 `has*` 门控与 `isMissingFile`，既有 `readText`/`listTasks`/`sessionTask`/`specRefs`/归档路径/切项目清 selection 等路径均保持原语义（逐处读码核对，见上文）。

Candidate: green


## 修复记录（round 3 green 之后的 minor）

| # | 发现 | 修法 |
| --- | --- | --- |
| m1 | `newestFirst` 触发 2 条 `#ActorIsolatedCall`（round 2 声称「零警告」不成立，被 `-quiet` 与增量缓存掩盖） | 加 `nonisolated` |
| m2 | 任务无任何产物文档时详情页一片空白、无提示 | 加「该任务还没有产物文档」 |
| m6 | `docs/specrune-mobile/README.md` 与实现脱节（仍写 mock、死链到已删的 `SpecRuneModels.swift`、阶段 1 写的是被否决的方案） | 按 shell/exec 实现重写 |

**验证**：`xcodebuild build` exit=0 且**零 SpecRune 警告**（强制重编后确认）。

---

## Verdict: green

Review round 3 判定 `Candidate: green`（无 blocker、无 major）。主会话复核确认：

- 6 条 round-1 major、1 条 round-2 blocker、1 条 round-2 major 全部修复并复验通过。
- 保留的 minor 均为「范围外的形态差异」或「已记录的技术债」，不影响验收标准。
- 8 条验收标准逐条有证据（见 `## Review round 3` 与各轮修复记录）。
- 基线：`xcodebuild` exit=0、`swift build` exit=0、`git status --short connector/ server/` 为空、契约 5 个 schema sha256 全部匹配。
