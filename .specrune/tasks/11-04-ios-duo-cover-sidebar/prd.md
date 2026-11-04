# Duo 合盖外屏：UI 回归原版样式并新增右侧栏

## Goal

Duo 合盖（外屏，compact width）不再使用自研两 Tab 外壳，回归上游原版的
抽屉式 UI；并把内屏右缘竖排入口（新会话 + 头像）搬到外屏，让外屏也
拥有这套 Duo 专属入口。

## Confirmed Facts（代码证据）

- 形态矩阵现状：

  | 形态 | width | 实现 | 位置 |
  |---|---|---|---|
  | 普通 iPhone | compact | `SidebarDrawer` `.drawer`（原版） | `ChatShellView.swift:48` |
  | Duo 合盖外屏 | compact | `CompactChatShellView` 两 Tab | `ChatShellView.swift:51` |
  | Duo 内屏 / iPad | regular | `.nativeSidebar` 双栏 + 右缘竖排 rail | `ChatShellView.swift:165-234` |

- **上游原版 compact 形态 = 抽屉**：`origin/main` 的 `ChatShellView` 只有
  `sidebarLayout(layout)` 一条路径，compact 时 `.drawer`。两 Tab 是本仓
  2026-10-22 任务 `10-22-ios-foldable-adaptive-ui` Q1 决策的产物，且只被
  Duo 外屏使用（普通 iPhone 已走回抽屉）。
- 内屏 rail 机制：shell 注入 `.environment(\.chatRail, ChatRailContext)`，
  条件 `isDuoFoldableIPhone`（`ChatShellView.swift:223`）；页面经
  `ChatPageToolbar.railTrailing` 消费，placement 恒 `.topBarTrailing`，
  系统按宽度分派为顶栏或右缘竖排（`duo-layout.md`）。
- 两 Tab 入口在抽屉里均有等价物：`CompactSessionListView` 与侧栏共用
  `ChatSidebarSessionRow`；`CompactMoreView` 的设备/账号/设置/配对在
  `ChatSidebarView` 中齐全。
- 工程用 `PBXFileSystemSynchronizedRootGroup`，删文件不需改 pbxproj。
- 契约约束（`.specrune/spec/ios/duo-layout.md`）：侧栏启动设置只作用于
  `.regularSplit`，抽屉恒闭合启动；toolbar 内 label 禁止内容切换；rail
  条目结构恒定。

## Requirements

- **R1 外屏回归原版外壳**：Duo 合盖（compact + `isDuoFoldableIPhone`）走
  `sidebarLayout(.drawer)`，与上游/普通 iPhone 同一套外壳，无底部 Tab 栏。
- **R2 外屏获得 rail**：合盖形态注入 `ChatRailContext`（新会话 + 头像），
  条目与内屏完全相同；落位交给系统（竖屏顶栏、宽 detail 右缘竖排）。
- **R3 外屏侧栏保留底栏**：合盖抽屉里保留新会话 + 账号底栏（抽屉盖住
  detail 顶栏时仍有入口）；内屏双栏仍清空。
- **R4 删除两 Tab 代码**：`CompactChatShellView` / `CompactSessionListView` /
  `CompactMoreView` 及其 Preview，全仓零残留。
- **R5 零回归**：内屏双栏 + 右缘竖排、普通 iPhone 抽屉、iPad 双栏行为
  与改前一致。

## Acceptance Criteria

- [ ] Duo 合盖（模拟器或真机）：启动无底部 Tab 栏，显示原版欢迎页/详情；
      菜单或右滑可开抽屉。
- [ ] 外屏抽屉：设备区、置顶/最近会话、底栏（新会话 + 账号）齐全；
      点会话可进详情并收发消息。
- [ ] 外屏详情顶栏（竖屏）/右缘竖排（横屏）出现新会话 + 头像两个入口，
      点击分别进入新建会话与账号设置。
- [ ] Duo 内屏展开：双栏、右缘竖排、侧栏无底栏，与改前一致。
- [ ] 普通 iPhone：抽屉行为与改前一致。
- [ ] `xcodebuild ... build` 输出 `BUILD SUCCEEDED`。
- [ ] `grep -rn "CompactChatShellView\|CompactSessionListView\|CompactMoreView" ios/`
      零命中。
- [ ] `CHANGELOG.md` 未发布节 iOS 分类补一条用户可见变化。

## Out of Scope

- 自绘常驻右侧栏（改用系统 placement 分派）。
- 普通 iPhone 外壳调整（本来就是原版抽屉）。
- 外屏终端/文件管理适配。
- 两 Tab 时代独有的视觉（底部 Tab 栏）保留或迁移。
- 若模拟器不支持合盖姿态，真机验证可后置，但须在交付说明里写明。

## Implicit requirements sweep

- 崩溃数据保全：无新增持久化，无迁移 — not-applying
- 敏感数据：无新数据类型 — not-applying
- 权限：不新增权限 — not-applying
- 审计：UI 外壳调整，无审计需求 — not-applying
- 失败可见性：沿用现有错误横幅与连接占位 — applied（复用）
- 兼容性：内屏/普通 iPhone/iPad 零回归（R5）；无 UserDefaults 键变化 — applied
- 无障碍/本地化：不新增文案；删除的两 Tab 文案随之移除 — applied
- 状态保持：合盖↔展开切换时选中会话、草稿、WebSocket 不断（复用现有
  状态层） — applied

## Open Questions

- ~~Q1「Duo 右侧栏」指什么~~ **已定（2026-11-04）**：先把外屏恢复原版
  样式，再把内屏右缘竖排 UI 搬到外屏；不自绘右侧栏。
- ~~Q2「原版样式」范围~~ **已消解**：普通 iPhone 已是原版抽屉，本次只
  影响 Duo 外屏。
- ~~Q3 两 Tab 的更多页入口~~ **已消解**：抽屉侧栏有全部等价入口。
- 剩余技术未知（不阻塞规划，实现期验证）：Duo 模拟器能否切合盖姿态；
  外屏欢迎页顶栏 rail 的实际渲染。若模拟器不支持，退真机并记录。
