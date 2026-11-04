# Duo 合盖外屏：回归原版外壳 + 复用内屏右缘竖排

## 背景与目标

Duo 合盖（外屏）现在走本仓自研的 `CompactChatShellView` 两 Tab 外壳
（2026-10-22 任务 `10-22-ios-foldable-adaptive-ui` 的 Q1 决策），与上游
原版的抽屉式 compact 外壳分叉。用户要求：外屏整体回归原版样式，唯一
新增是把内屏右缘竖排入口（新会话 + 头像）搬到外屏。

## 架构与边界

改动集中在一个文件 + 三处删除：

| 动作 | 位置 | 说明 |
|---|---|---|
| 形态分派回归单一 `sidebarLayout(layout)` | `ChatShellView.swift:47-53` | 与 `origin/main` 结构一致 |
| 删除两 Tab 外壳 | `CompactChatShellView.swift`、`CompactSessionListView.swift`、`CompactMoreView.swift` | 仅被 ChatShellView 引用，无其他调用点 |
| 侧栏底栏条件按形态收窄 | `ChatShellView.swift:193` | 见「侧栏底栏」 |
| rail 注入不变 | `ChatShellView.swift:223` | 条件仍是 `isDuoFoldableIPhone`，合盖自动生效 |

**不改**：`SidebarDrawer`、`ChatSidebarView`、`ChatPageToolbar`、rail 的
`ChatRailContext` 结构、`isDuoFoldableIPhone` 的机型判断。外屏能力全部由
既有组件承接，没有新组件。

## 形态矩阵（改后）

| 形态 | width | 外壳 | rail（新会话+头像） | 侧栏底栏 |
|---|---|---|---|---|
| 普通 iPhone | compact | 抽屉（原版，未变） | 无 | 有 |
| Duo 合盖外屏 | compact | 抽屉（本次改） | 有（本次改） | 有（本次改） |
| Duo 内屏 / iPad | regular | 双栏（未变） | 有（未变） | 无（未变） |

## 右缘竖排的落位（系统分派，不自绘）

rail 条目 placement 恒为 `.topBarTrailing`，由系统按可用宽度分派：

- 外屏竖屏（窄）：落 detail 顶栏右上，与内屏竖屏同路径。
- 外屏横屏（宽 detail）：系统重排为右缘竖排 glass 容器，与内屏横屏同路径。
- 键盘弹出压缩：`RailPinnedItem` 的 `visibilityPriority(.high)` 保留高频项，
  其余进系统「…」。

这是既有契约（`.specrune/spec/ios/duo-layout.md`「竖排 toolbar 官方规则与
最终形态」），本次不新增任何形态判断，也不自绘右侧栏——自绘会与外屏窄
宽度抢空间，且违背"系统容器内不自造控件"的既有结论。

## 侧栏底栏

`showsBottomControls` 从 `!isDuoFoldableIPhone` 收窄为
`!(isDuoFoldableIPhone && layout == .regularSplit)`：

- 内屏双栏时侧栏底栏仍清空（rail 竖排常驻可见，不重复）。
- 合盖外屏抽屉保留底栏：抽屉展开会盖住 detail 顶栏，若底栏也清空，
  用户在外屏抽屉里没有新会话/账号入口，只能先关抽屉再点顶栏。
- 这同时符合"总体样式还是原版样式"：原版 iPhone 抽屉本来就有底栏。

## 数据流与状态

- `selection`（`appState.chatSelection`）继续由 shell 单一持有；抽屉形态下
  详情由 `ChatDetailNavigation` 呈现，`onMenu` 开抽屉。
- 会话/设备/账号/设置入口全部复用 `ChatSidebarView`，与普通 iPhone 同一
  套视图，不存在第二份列表实现。
- 形态切换（合盖↔展开）不改状态层，选中会话与草稿保持——与现有
  compact↔regular 契约一致。

## 兼容性与迁移

- regular 路径零改动（内屏、iPad）。
- 普通 iPhone 原本就走 `sidebarLayout(.drawer)`，行为不变。
- 无持久化结构变化；侧栏启动设置仍只作用于 `.regularSplit`，抽屉恒闭合
  启动（`duo-layout.md`「侧栏启动设置契约」）。
- 两 Tab 时代的外屏入口（`CompactMoreView` 的设备/账号/设置）在
  `ChatSidebarView` 中均有等价入口（设备区、账号、配对、归档），无功能
  丢失；`CompactSessionListView` 与侧栏共用 `ChatSidebarSessionRow`。

## 风险与回滚

- **风险 1**：外屏竖屏时 rail 落顶栏，而欢迎页（`.newSession`）顶栏是否
  带 rail 需真机/模拟器确认；`NewSessionView` 已消费 `chatRail`
  （`NewSessionView.swift:82`），预期成立。
- **风险 2**：抽屉展开时 detail 顶栏被盖住，rail 不可见——由保留底栏兜底。
- **风险 3**：删除三个文件后 pbxproj 引用失效导致构建失败。已确认工程用
  `PBXFileSystemSynchronizedRootGroup`（pbxproj 内 3 处），文件系统同步，
  删文件不需要改 pbxproj。
- **回滚**：单次提交，`git revert` 即恢复两 Tab；无数据迁移。

## 备选方案

- **只改 Duo 外屏、保留两 Tab 给普通 iPhone**：普通 iPhone 已经是抽屉，
  两 Tab 只服务外屏，没有第二个使用者，保留等于留死代码。否决。
- **自绘常驻右缘竖排**：外屏窄，常驻竖排挤压内容，且与系统 toolbar 分派
  重复；内屏已证明"交给系统 placement 分派"是正确做法。否决。
- **外屏 rail 换成底部 Tab 或 FAB**：用户明确要"右侧栏"，且新交互形态
  会引入第三套外屏外壳。否决。
- **外屏也清空侧栏底栏（与内屏一致）**：抽屉内失去新会话/账号入口，
  多一步操作。否决，按上方「侧栏底栏」保留。

## 验证计划

1. `xcodebuild -project "Agents Anywhere.xcodeproj" -scheme "Agents Anywhere"`
   对 iPhone 模拟器 destination 构建通过。
2. 模拟器 `iPhone19,4`（Duo）合盖：启动无 Tab 栏，欢迎页 + 顶栏 rail；
   开抽屉见设备/会话/底栏，进会话可发消息。
3. 外屏横屏：rail 进右缘竖排；抽屉仍可滑出。
4. 内屏展开：双栏 + 右缘竖排不变（回归对照）。
5. 普通 iPhone 模拟器：抽屉行为与改前一致。
6. 若 Duo 模拟器不支持合盖姿态，退化为真机构建部署（命令见
   `duo-layout.md`「真机构建/部署工作流」），并记录未验证项。
