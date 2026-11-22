# 评审与进展台账

## 实施记录

### 修复 1 · 项目列表即空态

- `Views/SpecRune/SpecRuneTasksView.swift`
  - 删除 `selectFirstProjectIfNeeded`，`.task` 与 `.onChange(of: projects)` 只保留探测，不再自动 `select(repo:)`。
  - `taskColumn` 的 `selectedRepo == nil` 分支由「未选择项目」空态改为 `projectPicker(model)`：`List` + Section「选择项目」，行三态（SpecRune 项目可点 / 探测中 ProgressView / 置灰并显示 `probeFailures` 或「未启用 SpecRune」）。
  - 新增 `isLoadingProjects`：dashboard 加载中显示加载态，加载完成且无项目才显示「这个设备还没有项目」。
- `Views/ChatShell/ChatShellView.swift`：传入 `isLoadingProjects: appState.isDashboardLoading`。
- rail「项目」sheet 未改动，与列表共用 `model.selectedRepo`。

### 修复 2 · 抽屉开合位移

- `Views/Chat/ChatPageToolbar.swift`：删除 `drawerObscuresDetail ? .hidden : .visible` 的导航栏隐藏（连同对应 `@Environment` 属性）；抽屉打开时导航栏保持渲染，只被卡片遮住，NavigationStack 内容区不扩展。
- `.specrune/spec/ios/duo-layout.md`：更新「合盖外屏外壳 = 原版抽屉」节，记录新契约与旧隐藏方案被推翻的原因。
- `CHANGELOG.md`：SpecRune 条目补「先选项目」与「合盖打开侧栏内容不再跳动」。

### 实验与方案选择

- 方案 A（不隐藏导航栏）在 Duo 外屏实跑通过：内容位置与抽屉关闭时一致、逐帧录屏导航栏全程可见无闪现 → 采用。
- 方案 B（隐藏 + 顶部占位补偿）未采用：SpecRune 页有内层 NavigationStack，补偿量需分页面标定，改动分散。

## 验证记录（Duo 外屏 iOS 27.1 模拟器，Xcode 27.2，带签名模拟器构建）

| 项 | 方法 | 结果 |
| --- | --- | --- |
| 进入看板不自动选项目 | 侧栏 → SpecRune，读 AX | 首屏「选择项目」+ 列表；无自动 select |
| 项目列表三态 | AX + 截图 | 「测试/Bilibili-Evolved/clawd-on-desk、SpecRune 项目」可点；「未启用 SpecRune」置灰 |
| 点项目进任务列表 | idb tap → AX | 「工作流 · 1」y=92、任务行 y=122.33 |
| 抽屉打开内容不位移 | 抽屉关闭 y=92 → 打开截图对比 → 关闭 AX | 打开时内容位置一致（截图），关闭后 AX 精确恢复 y=92 |
| 导航栏无闪现 | 录屏 15fps 逐帧检查 | 卡片位移全程导航栏可见 |
| rail 项目 sheet | 点 rail「项目」→ AX | sheet 正常弹出、选中态正确 |
| 任务详情页 | 点任务行 → AX | 导航栏/标签条/概览正常 |
| 内屏回归 | — | 未实测：模拟器合盖无法展开（DeviceHub 按钮操作失败）；逻辑上 nativeSidebar 下该环境值恒 false |

## Review round 1

评审对象：当前未提交工作树（6 个改动文件）。独立子代理只读评审，另跑了 `xcodebuild` 模拟器构建与 Duo 外屏实跑复核。

### 验收标准核对

| # | 验收项 | 代码 | 验证 | 结论 |
| --- | --- | --- | --- | --- |
| 1 | 首屏项目列表、不自动选中 | ✅ | ✅ 实跑 | 满足 |
| 2 | 三态区分 | ✅ | ⚠️ 实跑只见可点/置灰（探测过快） | 部分（代码支撑） |
| 3 | 点项目加载 + rail sheet 一致 | ✅ | ✅ 实跑 | 满足 |
| 4 | 无项目明确空态 | ✅ | ⚠️ 未实测（设备有 15 个项目） | 部分（代码支撑） |
| 5 | 抽屉开合内容不位移 | ✅ | ✅ 双方实跑 y 差值 0 | 满足 |
| 6 | 导航栏无闪现 | ✅ | ⚠️ 仅模拟器逐帧；旧问题为真机反馈 | 部分（见 M2） |
| 7 | iOS 构建通过 | — | ✅ 独立构建 | 满足 |
| 8 | 模拟器实跑 + 内屏抽查 | ✅ | ⚠️ 外屏 ✅；内屏未实测 | 部分（见 M1） |

### 分级问题与处置

| 级别 | 问题 | 处置 |
| --- | --- | --- |
| major | M1 内屏回归未实测（AC8） | 逻辑等价性已论证（nativeSidebar 不设置该环境值→恒 false）；模拟器合盖无法展开，DeviceHub 按钮操作失败。**记录为未实测 + 等价性说明**，见下方「遗留」。 |
| major | M2 真机证据强度不足（AC6/R7） | 模拟器逐帧已验证；真机构建安装成功但设备锁屏无法启动。**已请用户解锁真机复验**（见最终回复）；spec 已注明「真机尚未复验」。 |
| minor | m1 `isLoadingProjects` 语义与既有用法不一致 | **已修**：改为 `isDashboardLoading && !hasLoadedConnectors`（与 ChatShellView:236 同模式）。 |
| minor | m2 首屏 picker 与 rail sheet 对「探测中」文案不一致 | **已修**：抽出文件级 `specRuneProjectStatusText`，两处共用。 |
| minor | m3 项目消失时 taskPath 未清 | **已修**：`.onChange(of: model?.selectedRepo)` 置 nil 时 `taskPath.removeAll()`。 |
| minor | m4 spec/注释「被卡片遮住」表述与实测不符 | **已修**：duo-layout.md 改为「导航栏随卡片位移，抽屉打开时在露出的卡片窄条内可见但不可交互」，规则改为「不要用隐藏导航栏换取布局空间」。 |
| minor | m5 两处「处理抽屉导航栏重画」注释过时 | **已修**：改为「保证抽屉形态下导航栏占位不变（内容不位移）」。 |
| minor | m6 ChatPageToolbar 注释偏重且与 spec 重复 | **已修**：精简为防回归提示 + spec 指向。 |
| minor | m7 CHANGELOG 归属 | **已修**：位移修复并入 Duo 抽屉条目，SpecRune 条目只保留「先选项目」。 |
| minor | m8 implement.md 进度未同步 | **已修**：按实际完成勾选。 |
| minor | m9 未实测项需标注 | **已记录**：见「遗留」。 |
| minor | m10 既有死代码 `projectName` | 既有死代码（HEAD 已存在），非本次引入，按最小修改不处理。 |
| minor | m11 只跑模拟器 destination | 已补真机 destination 构建（`/tmp/aa_dd_device`，BUILD SUCCEEDED），安装到 DiPhone 成功。 |

### 结论

无 blocker，可合并；majors 均为验证覆盖问题（内屏未实测、真机未复验），已记录并在最终回复中请用户真机验收。

## 遗留

- **内屏回归未实测**：模拟器当前合盖，DeviceHub 折叠按钮操作失败。等价性论证：`SidebarDrawerNativeSplitView` 不设置 `sidebarDrawerObscuresDetail`（默认 false），原代码在内屏即 `.toolbar(.visible)`，移除隐藏与内屏行为等价。
- **真机未复验**：DiPhone 已安装新构建，但设备锁屏无法启动（`BSErrorCodeDescription = Locked`）；需用户解锁后观察抽屉开合是否有导航栏闪现。
- **「探测中」与「设备无项目」空态未实测**：现有设备 15 个项目且探测过快，代码路径存在但无实跑证据。

## 抽屉动效重构（2026-11-21 深夜迭代，用户驱动）

**toolbar 漂移根因**（60fps 逐帧实测）：关闭抽屉时系统把竖排 toolbar 短暂切成顶部水平布局再回来（约 0.13s）。已逐一排除：卡片形状切换、位移幅度（0.5 屏宽仍复现）、抽屉状态环境值、位移实现（offset 替代 GeometryEffect）、导航栏恢复时机（延迟 150ms）、`axisBehavior(.verticalPreferred)`、隐藏导航栏、不渲染 toolbar 按钮、透明按钮（系统 toolbar 不重画内容）。

**最终定位**：卡片位移本身让系统在动画结束时重新解析 `toolbarVerticalBehavior`（Apple 文档确认值变化会触发内容重排过渡）。卡片不位移后逐帧验证零重排。

**方案（用户确认）**：
- 卡片固定不位移，侧栏滑出覆盖；导航栏全程不动。
- 侧栏用 `.background(.ultraThinMaterial)` 玻璃材质（`glassEffect` 的玻璃层固定在布局位置、不跟随位移，会提前露出标题）。
- 标题条放布局流并**单独加同步位移**（`safeAreaBar`/`safeAreaInset` 固定在安全区；父级 offset 也不会带着它走，模拟器/真机实测）。
- 删除不再使用的 `SidebarDrawerTranslation` 与缩放/遮罩配置。

**验证**：模拟器 60fps 逐帧（toolbar 零重排、标题跟随滑入/滑出）+ 真机用户验收（「都正常了」）。提交 `e5191d47`。

## 最终验收（2026-11-22）

用户确认：**真机与模拟器、真机内屏与外屏均测试正常**。此前「内屏回归未实测」「真机未复验」两项遗留由此关闭。
