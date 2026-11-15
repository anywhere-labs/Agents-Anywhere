# 实施：SpecRune 任务看板接入手机端

**零改上游**：`connector/` 与 `server/` 一行不动，功能全部在 iOS 侧。官方远程 Server 直接可用。

## 启动前检查

- [ ] `specrune task current --json` 确认绑定本任务
- [ ] 读 `contracts/specrune/1.0/README.md`（字段结构权威，端点层已被 shell/exec 取代）
- [ ] `git status` 确认 `connector/`、`server/` 干净（这是验收项之一）
- [ ] 确认工作设备上 `specrune` CLI 可用：`specrune --version`

## 阶段 1 · iOS 取数层

- [ ] `API/V2/V2ConnectorAPI.swift` 加 `shellExec(connectorId:root:request:)`
  - 对应 `POST /connectors/{id}/shell/exec?root=`，body `{command, cwd, timeoutMs}`
  - 返回 `{cwd, command, exitCode, timedOut, durationMs, stdout, stderr, stdoutTruncated, stderrTruncated}`
- [ ] `ios/Packages/SpecRuneKit/Package.swift`（照 `Packages/Textual` 的 platforms 写法）
- [ ] `Sources/SpecRuneKit/SpecRuneClient.swift`
  - `listTasks(repo:)` → `specrune task list --json --all`，解析 stdout
  - `taskSummary(repo:ref:)` → `specrune task show <ref> --json`
  - `readDoc(repo:relPath:)` → `fs/readText`（带 maxBytes）
  - `listDir(repo:relPath:)` → `fs/readDir`
  - `sessionTask(repo:sessionId:)` → `readText .specrune/.runtime/sessions/dsh_<id>.json`
  - 命令里的 repo 路径需 shell 引号转义
  - CLI 回退：PATH 找不到时重试 `~/.dsh/specrune/bin/specrune`
- [ ] `Sources/SpecRuneKit/Errors.swift`：错误分类枚举（cliMissing / cliFailed / badJSON / truncated / notSpecRuneProject / offline）

**验证**：`swiftc -typecheck`（见下方命令）

## 阶段 2 · SpecRuneKit 模型与视图

- [ ] `Sources/SpecRuneKit/DTO.swift`：契约 1.0 字段结构（`nonisolated`）
- [ ] `Sources/SpecRuneKit/Models.swift`：DTO → UI 模型（`SpecRuneProject` / `SpecRuneTask`），保留原型的 `progress` 派生逻辑
- [ ] 把 `Views/SpecRune/SpecRuneTasksView.swift` + `SpecRuneModels.swift` 迁入包内
  - 数据源换成 `SpecRuneClient`
  - 加 loading / error / 空态 / 截断提示
  - 保留三栏自适应（`NavigationSplitView`）、弹簧动效、`accessibilityReduceMotion`
- [ ] 删掉主 app 的 `Views/SpecRune/`（已迁走）

**验证**：`swiftc -typecheck`

## 阶段 3 · 入口与会话关联

- [ ] xcodeproj 加 `XCLocalSwiftPackageReference "../Packages/SpecRuneKit"`（照 Textual 的 pbxproj 条目）
- [ ] `Models/Chat/ChatShellSelection.swift` 加 `case specRune(V2ConnectorID)`，旧存档解码兜底
- [ ] 侧栏与 rail 加入口（compact 抽屉 + regular 侧栏均可达）
- [ ] 会话页显示所属任务（`sessionTask` 有值才显示，无值隐藏）

**验证**：`swiftc -typecheck` + Xcode 编译（若可用）

## 阶段 4 · 收尾

- [ ] `CHANGELOG.md` 加「未发布」条目（iOS 分类）
- [ ] 契约 README 补一段：实现走 `shell/exec`，端点表已退役
- [ ] `specrune specs --check`
- [ ] `specrune session record`
- [ ] `specrune task finish` → `specrune task archive`

## 验证命令

```bash
# iOS 类型检查（Views 不在 SPM target，单独编）
cd "ios/Agents Anywhere/Agents Anywhere" && swiftc -typecheck \
  -sdk "$(xcrun --sdk iphoneos --show-sdk-path)" -target arm64-apple-ios27.0 \
  Views/SpecRune/*.swift Views/AppTheme.swift Views/Components/AppSymbol.swift \
  Views/Components/AppSymbolAssets.swift

# SpecRuneKit 包单独编译
cd ios/Packages/SpecRuneKit && swift build

# 零改上游核查
git status --short connector/ server/   # 应为空
```

## 风险文件与回滚点

| 文件 | 风险 | 回滚 |
| --- | --- | --- |
| `API/V2/V2ConnectorAPI.swift` | 新增方法破坏既有实现 | 纯新增协议方法 + 实现，删掉即可 |
| `Models/Chat/ChatShellSelection.swift` | 枚举新增 case → 旧导航存档解码失败 | 加兜底解码；回滚时保留兜底 |
| `Views/ChatShell/*` | 侧栏/rail 布局改动影响既有会话入口 | 改动限定在新增入口，不动既有项 |
| `Agents Anywhere.xcodeproj/project.pbxproj` | 手改 pbxproj 易错 | 照 Textual 现有条目逐行复制；出错用 git checkout 还原 |

## 已知陷阱

- `shell.exec` 的 `stdout` 上限 64 000 字符，超了 `stdoutTruncated=true` 且 JSON 会坏——任务列表要检查这个标志并提示。
- `shell.exec` 用 `create_subprocess_shell`，命令字符串必须给 repo 路径加引号（路径可能含空格）。
- 任务详情**不要**用 CLI 拿文档正文（`task show --json` 只给摘要），正文走 `fs/readText`。
- `specrune task list` 默认限流 20 条，必须带 `--all`。
- iOS `Views/` 不在 `Package.swift` 的 target 内，主 app 侧改动只能靠 `swiftc -typecheck` 或 Xcode 编译验证。
