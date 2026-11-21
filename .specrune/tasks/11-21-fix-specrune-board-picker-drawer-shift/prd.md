# 修复 SpecRune 看板项目选择空态与 Duo 外屏抽屉位移

## Goal

进入 SpecRune 看板时不再自动选中第一个项目，改为展示项目列表让用户主动选择；修掉 iPhone Duo 外屏抽屉开合时看板内容整体上下位移。

## Confirmed Facts

- **自动选择来源**：`Views/SpecRune/SpecRuneTasksView.swift` 的 `.task` 与 `.onChange(of: projects)` 都会在探测后调用 `selectFirstProjectIfNeeded`——`probeProjects()` 跑完就自动 `select(repo:)` 第一个 SpecRune 项目。未选中期间任务列显示 `ContentUnavailableView("未选择项目")`，所以用户先看到空态、随后被自动带进项目（2026-11-21 真机/模拟器复现）。
- **项目与探测状态已齐备**：`SpecRuneBoardModel` 有 `deviceProjects`（按名称排序）、`specRuneRepos[path]`（`true`/`false`/`nil`=未探测）、`probeFailures[path]`（探测失败原因）。探测 = 读 `.specrune/workflow.md`（`SpecRuneKit.isSpecRuneProject`），每个项目只探测一次。
- **已有项目选择 UI**：rail 的「项目」按钮弹出 `SpecRuneProjectPickerSheet`（可复用的列表形态：启用/未启用/失败原因/选中勾）。
- **Duo 外屏抽屉**：compact width 走 `SidebarDrawer(presentation: .drawer)`；`ChatDetailNavigation` 在卡片内包一层 `NavigationStack` + `.padding(insets)`。`ChatPageToolbar` 读 `\.sidebarDrawerObscuresDetail`（抽屉打开或位移中为 true），抽屉打开时 `.toolbar(.hidden, for: .navigationBar)`。
- **位移实测（Duo 外屏 466×678pt，iOS 27.1 模拟器）**：SpecRune 面板「工作流 · 1」在抽屉关闭时 y=92，抽屉打开后 y≈11.7（上移约 80pt），关闭抽屉恢复 y=92。AX 树坐标同源验证。根因是导航栏隐藏后 NavigationStack 内容区扩展、List 顶部 inset 重算，不是卡片位移本身（卡片只做绘制层平移）。
- **隐藏导航栏是 2026-11-05 的旧修复**：抽屉一开就盖住详情，导航栏在卡片位移中会被系统重画一次（闪现又消失），故改为不渲染。规范记于 `.specrune/spec/ios/duo-layout.md`「合盖外屏外壳 = 原版抽屉」节。
- **会话页同样隐藏导航栏**：用户只报告 SpecRune 面板，但根因在 `ChatPageToolbar` 通用层；修复应验证会话页一并受益。
- **验证环境**：Xcode 27.2、iPhone Duo 模拟器 iOS 27.1（UDID 138A5F69-4F9D-4FE2-A215-E1DAB226A92F，当前合盖=外屏）；`idb ui describe-all` 读 AX 树、按 AXFrame 中心 `idb ui tap`、`simctl io screenshot --display=1`（外屏）/`--display=3`（内屏）。

## 分解决定

decompose_reason: 两个小修复共享同一屏与同一验证回路（Duo 外屏 SpecRune 面板），拆开会让第二次验证重复搭环境；合计 2 项交付、8 条验收，未超阈值，单任务执行。

## Requirements

- **R1 不再自动选项目**：进入 SpecRune 看板时不做任何自动 `select(repo:)`；首次进入停在项目列表，由用户点击决定。
- **R2 项目列表即空态**：未选中项目时任务列显示该设备的项目列表，而不是「未选择项目」提示。
- **R3 三态可辨**：列表项区分「SpecRune 项目（可点）」「探测中（进度指示）」「非 SpecRune / 探测失败（置灰 + 原因）」，失败原因沿用 `probeFailures`。
- **R4 选择即加载**：点击可用项目后走既有 `model.select(repo:)` 加载任务列表，行为与 rail 项目选择器一致（含 rail 选择器的选中勾同步）。
- **R5 空/加载态可读**：设备无项目时给出明确空态（而不是「未选择项目」）；dashboard 未加载完时显示加载态。
- **R6 抽屉位移消除**：Duo 外屏抽屉打开/关闭时，SpecRune 面板内容纵向位置保持不变（导航栏隐藏造成的位移被消除或补偿）。
- **R7 不回归旧问题**：修复不得重新引入 2026-11-05 的「抽屉打开时导航栏闪现又消失」。
- **R8 范围**：只改 iOS；Connector、Server、契约不动。

## Acceptance Criteria

- [ ] Duo 外屏点击侧栏「SpecRune」进入看板：首屏是项目列表，不再自动进入某个项目（AX/截图确认）
- [ ] 项目列表正确区分三种状态：可点项目、探测中、置灰的非 SpecRune/失败项（含原因文案）
- [ ] 点击项目后加载该项目的任务列表；rail「项目」选择器仍可用且与当前选中项一致
- [ ] 设备无项目时显示明确空态，不出现「未选择项目」误导文案
- [ ] Duo 外屏抽屉打开与关闭时，SpecRune 面板内容纵向位置一致（AX y 坐标或截图对比，差值 0）
- [ ] 抽屉打开时导航栏无「闪现又消失」现象（录屏/逐帧截图抽查）
- [ ] iOS 构建通过（`xcodebuild build`）
- [ ] 模拟器实跑验证通过（Duo 外屏；内屏回归抽查）

## Out of Scope

- SpecRune 写操作、搜索、筛选等新功能
- Connector / Server / 契约改动
- Duo 内屏三栏布局调整
- SidebarDrawer 抽屉动效与位移实现重构
- Android / Web 端

## Open Questions

（无阻塞项。抽屉位移的修法（撤销隐藏 vs 隐藏+补偿）属技术决策，在 design.md 记录并以模拟器实测择定。）
