# 设计：SpecRune 看板项目选择空态与抽屉位移

## 架构与边界

两处修复都在 iOS 主 app，不改 `SpecRuneKit`（数据层）、Connector、Server：

```text
ios/Agents Anywhere/Agents Anywhere/
  Views/SpecRune/SpecRuneTasksView.swift      ← 修复 1：空态改项目列表；去掉自动选择
  Views/SpecRune/SpecRuneBoardModel.swift     ← 修复 1：保留探测/选择 API（不改结构）
  Views/Chat/ChatPageToolbar.swift            ← 修复 2：抽屉打开时的导航栏策略
  Views/Chat/ChatPageToolbar.swift 的
    ChatDetailNavigation（同文件）            ← 修复 2：若需补偿内容位置，落点在此
```

修复 2 的根因在通用层（`ChatPageToolbar` 的 `drawerObscuresDetail` 分支），不是 SpecRune 页面特有；会话页共用同一分支，应一并验证。

## 修复 1：项目列表即空态

**数据流**：`SpecRuneTasksView.projects`（父视图传入，来自 dashboard repository）→ `.task`/`.onChange` 推给 `SpecRuneBoardModel.updateProjects` → `probeProjects()` 逐个读 `.specrune/workflow.md` 填充 `specRuneRepos` / `probeFailures` → 视图渲染。

**改动**：

1. 删掉 `selectFirstProjectIfNeeded` 及其两处调用（`.task`、`.onChange(of: projects)`）。`.onChange` 只保留 `updateProjects` + `probeProjects`。
2. `taskColumn` 的 `selectedRepo == nil` 分支从 `ContentUnavailableView("未选择项目")` 改为项目列表：
   - `List`（与任务列表同 `.insetGrouped` 风格），Section 标题「选择项目」。
   - 每行：项目名 + 状态副标题；`model.specRuneRepos[path] == true` → 可点 Button（`model.select(repo:)`）；`probeFailures[path]` → 置灰 + 原因；探测中（`nil`）→ 置灰 + `ProgressView`（caption 尺寸）。
   - 空 `deviceProjects`：`ContentUnavailableView("这个设备还没有项目")`（dashboard 未加载完时 `ProgressView`）。
3. 选择后沿用既有 `model.select(repo:)`；`taskPath.removeAll()` 不需要（此时栈为空）。
4. rail 的「项目」sheet 选择器保留不动——它是任务列表态的切换入口；选中态从同一个 `model.selectedRepo` 读取，天然同步。

**取舍**：不把列表做成 sheet 自动弹出（用户要求「显示项目列表让用户选择」，且自动弹层会挡住导航栏/rail）；列表内嵌在任务列里，与选中后的任务列表同一容器，切换无跳变。

## 修复 2：抽屉开合的内容位移

**机制**：Duo 外屏 drawer 形态下，`ChatDetailNavigation` 在卡片内建 `NavigationStack`；`ChatPageToolbar` 在 `sidebarDrawerObscuresDetail == true` 时 `.toolbar(.hidden, for: .navigationBar)`。导航栏消失后 NavigationStack 内容区扩展、List 顶部 inset 重算，内容整体上移（实测 SpecRune 面板「工作流 · 1」y 92 → 11.7，约 80pt）；抽屉收起导航栏恢复，内容下移回原位。

隐藏导航栏是 2026-11-05 为消除「抽屉打开时导航栏被系统重画一次（闪现又消失）」加的旧修复，不能简单撤销。

**方案 A（优先实验）：抽屉打开时不隐藏导航栏**

- 改动：`ChatPageToolbar.body` 去掉 `.toolbar(drawerObscuresDetail ? .hidden : .visible, for: .navigationBar)`。
- 预期：导航栏占位保留 → 内容不位移。
- 风险：2026-11-05 的闪现回归。iOS 27.1 下需实测逐帧/截图确认；若回归则转方案 B。

**方案 B：保留隐藏，补偿内容顶部空间**

- 改动：`ChatDetailNavigation` 读 `sidebarDrawerObscuresDetail`，为 true 时给 `NavigationStack` 内容加顶部占位（`.safeAreaInset(edge: .top)` 或 `.padding(.top, navBarHeight)`）。
- 补偿量：导航栏高度（标准 44pt）+ 隐藏后额外释放的安全区。需实测标定，且 SpecRune 页面有内层 NavigationStack，内层导航栏隐藏的位移要在 `SpecRuneTasksView` 侧另补——落点分散、两个页面补偿量不同，复杂度高。
- 仅当 A 的闪现无法接受时采用。

**方案 C：抽屉打开时只隐藏导航栏内容、保留占位**

- 无公开 API 能在保留导航栏高度的同时移除标题/按钮；`.toolbarBackground(.hidden)` 仍留按钮，效果接近 A 但不解决闪现。不采用。

## 备选方案

- **A：不隐藏导航栏（占位保留）** — 最简单、一次覆盖所有页面；风险是旧闪现回归，需实测。
- **B：隐藏 + 顶部占位补偿** — 保住闪现修复，但要标定两个页面的补偿量，且 SpecRune 内层 NavigationStack 的位移落点在页面内，改动分散、易回归。
- **C：仅隐藏导航栏背景/内容、保留高度** — SwiftUI 无对应公开 API，放弃。
- **D：把 SpecRune 页面的内层 NavigationStack 改成外层 push** — 会牵动详情页工具栏与 rail（per-page toolbar 契约），超出本任务范围，不做。

## 验证

1. `xcodebuild -project "ios/Agents Anywhere/Agents Anywhere.xcodeproj" -scheme "Agents Anywhere" -destination 'id=138A5F69-4F9D-4FE2-A215-E1DAB226A92F' -derivedDataPath /tmp/aa_dd build`。
2. 安装并启动模拟器 app；`idb ui describe-all` 读 AX 树，`idb ui tap` 按 AXFrame 点击。
3. 修复 1：进入 SpecRune 面板 → 确认首屏项目列表（无自动选中）；点项目 → 任务列表。
4. 修复 2：进入 SpecRune 面板 → 记录「工作流 · 1」AX y → 打开抽屉 → 截图/AX 对比 → 关闭抽屉 → 再对比；同样在会话页抽查；抽屉打开瞬间截多帧看导航栏是否闪现。
5. 内屏（display=3，展开态）回归：三栏布局与 rail 不受影响。
