# Duo（折叠屏）机型判断与宽屏布局契约

来源：2026-10-24 "Duo 内屏横屏内容列宽度"五轮修复复盘。分支
`feat/ios/foldable-compact-tabs`（9eb1e23d / 53698fdc / 4cad46af；
内容已并回 main 并删枝，2026-10-28）。

## 机型判断：`isDuoFoldableIPhone`

位置：`ios/Agents Anywhere/Agents Anywhere/Views/Chat/Composer/ChatControlMetrics.swift`

```swift
let isDuoFoldableIPhone: Bool = {
    #if targetEnvironment(simulator)
    ProcessInfo.processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"] == "iPhone19,4"
    #else
    // utsname().machine == "iPhone19,4"
    #endif
}()
```

契约：
- **真机**读 `utsname().machine`；**模拟器**必须走
  `SIMULATOR_MODEL_IDENTIFIER`——模拟器的 machine 只返回宿主架构
  （arm64），机型判断永远 false，Duo 模拟器将无法复现折叠屏分支。
- ~~iOS 27.1 SDK 没有任何折叠姿态/形态公开 API~~（2026-10-25 修正：
  Xcode 27.1 (27A9275) SDK 实证，**UIKit 公开了完整的折叠 API**，此前
  "没有任何公开 API"的结论只对 SwiftUI 成立）。可用符号（头文件已验证，
  均 iOS 27.1+）：
  - `UIArrangementViewController`（`setViewController(_:for:)` /
    `updateArrangement(_:)`，primary/secondary 两个 placement）
  - `UISplitArrangement`（竖屏高>宽自动上下堆叠）/ `UIOverlayArrangement`
  - `UIHinge`（closed/partiallyOpen/fullyOpen + angle）、
    `UIHingeInteraction`（这就是"折叠姿态 API"）
  - `UIViewReservedRegion`（division=折叠带 / occlusion=摄像头遮挡，
    带 `isActive`，须现查不能缓存）
  - **SwiftUI 无对应符号**（swiftinterface 0 匹配；外部文章声称的
    SwiftUI `ArrangementView` 系 AI 辅助写作失实）。SwiftUI 接入用
    UIViewControllerRepresentable 包装，见
    `Views/Chat/DuoArrangementHost.swift`。
  机型 id 判断仍保留：它回答"这台设备是不是折叠屏"（布局分支启用条件），
  arrangement/hinge API 回答"屏幕当前怎么折"——两者职责不同，都要用。
- 新折叠机型落地时**只改这一个常量判断**，布局分支不动。

## 三层宽度约束（宽屏聊天内容）

聊天 detail 列的内容宽度由三层独立约束叠加，分居三个文件。宽屏
（detail 列 > 760pt，如 Duo 内屏横屏 951pt、隐藏侧栏）时三层全部生效，
文字列明显窄于输入框；列宽 < 760pt（竖屏 669pt、开侧栏 651pt）时均不
触发——**症状只在特定形态出现是条件性约束的直接特征**。

| # | 约束 | 文件 | Duo 值 | 其他机型 |
|---|------|------|--------|----------|
| 1 | 内容列上限 | `ChatPageContentColumn.swift` `.frame(maxWidth:)` | 2200 | 760 |
| 2 | ScrollView 系统阅读边距 | `ChatTimelineView.swift` `.contentMargins(.horizontal, 0, for: .scrollContent)` | 0（全局） | 系统默认 |
| 3 | composer/内容上限 | `ChatControlMetrics.maximumContentWidth` | 2000 | 780 |

已知取舍：约束 2 是全局的——普通机型竖屏文字边距从 ~32-40pt 变为
~16-20pt（列 padding 兜底），18 Pro 模拟器人工验收通过（2026-10-24）。

## 错误模式（会再犯的）

- **逐层猜限宽**：修掉一层还有下一层；正确动作是
  `grep -rn "maxWidth: [0-9]\|contentMargins\|maximumContentWidth" --include='*.swift' ios/`
  全量穷举（别 head 截断——第一次就是被 head -15 吞掉了 760 那行）。
- **用 padding/offset 精确平移 SwiftUI 内容**：`contentMargins`、
  `padding` 与 safe area 叠加后偏移非线性（实测 margins 0/16/36 →
  实际 0/16/74pt）；`offset` 是纯平移但会裁掉溢出侧、每行可视文字变少。
  宽度问题的正解是找到并修改约束本身，不是在其外围补偿。
- **双产物目录**：`Debug-iphonesimulator` 与 `Debug-iphoneos` 独立；
  只为真机构建的改动在模拟器上不存在。换环境复现前先确认构建产物。
- **用 `verticalSizeClass == .compact` 判断"横屏矮空间"**：Duo 横屏展开
  高 669pt 是 regular（同 iPad），判断永不成立——浮层面板照常 240 高、
  顶部顶进消息流标题栏玻璃下（2026-10-26 真机翻车一轮）。尺寸类看不见
  "键盘要吃掉大半高度"这件事；矮空间判断用实测几何：面板高度 =
  `min(240, 可视高度 − dock 实测高度 − 60)`（SessionChatView 传
  `geometry.size.height`，dock 用 onGeometryChange 采自身高度）。
- **水平方向 size class 同样不可靠**：Duo 半折叠下屏的
  `horizontalSizeClass` 实测也不是 compact（2026-10-26 真机验证失败）。
  需要按形态分派行为时，优先找已有状态语义（如"键盘是否展开"）而不是
  给屏幕形态分类；实在要分形态就用实测宽度/高度阈值。
  例外：`ChatShellView` 用 `horizontalSizeClass` 选 sidebar 布局是正当的
  ——它对齐的是 `NavigationSplitView` 自身的系统 trait（系统组件拿什么
  分派，我们就拿什么分派），不是猜测真实几何；上面同一会话还踩过
  `verticalSizeClass` 的同型坑（见上一条），教训是"size class ≠ 真实
  几何"，不是"size class 处处禁用"。
- **SwiftUI 手势只在不透明内容上命中**：HStack 中间的 `Spacer` 空白区
  不参与 DragGesture 命中，手势会缩到角落文字处。挂手势前补
  `.contentShape(Rectangle())`（指令面板标题行整行可拖，2026-10-26）。
- **异步焦点块禁止捕获状态快照**：`NativeComposerEditor.updateUIView`
  的 become/resignFirstResponder 异步化（Duo 假死修复）若闭包捕获旧
  `isFocused` 快照，转场中 UIKit 短暂 resign（synchronize 已写回
  false）后旧快照 true 会强行弹回键盘，形成键盘/布局反复弹跳
  （15PM 展开抽屉复现，上游同步版无此环）。异步执行时必须读实时值
  （ComposerDraft 是 class，捕获引用即可）。附带教训：修 A 引入 B
  后，先 diff 上游同文件找我们独有的行为差，再动手。
- **键盘避让的 ignoresSafeArea 挂载层级**：挂视图内容层无效（父容器
  已按键盘 safe area 压缩 frame）；要修整列不压缩，挂在包裹该列的
  GeometryReader 上；且只能挂 sidebar/main 之一——连输入框所在层
  一起豁免会让键盘避让失效，引发焦点循环（双栏挂 GR、抽屉挂
  ChatShellView 侧栏内容，均 2026-10-27 真机验证）。抽屉形态底栏
  随键盘上移是遗留（insets 是 GR 参数污染，内容层修不动）。
- **Duo 横屏点新会话闪现玻璃大圆（已解 2026-10-27）**：根因是
  `deviceMenu` 的 toolbar label 在 isPreparing 时切换内容
  （ellipsis↔spinner）——宽 detail（Duo 横屏）下系统 toolbar 渲染路径
  对 label 内容切换有 bug，spinner 错位到输入框下方且尺寸放大成大圆。
  触发矩阵：Duo 横屏有；竖屏（标准 toolbar 槽位）无；15PM 横屏
  （detail 572pt 窄）无。上游同复现。修复：toolbar 图标无条件恒定，
  isPreparing 转圈走 ChatHeaderStatus.preparing（导航栏 status 槽，
  复用既有 isProgress mini spinner 体系）。
  **规则**：系统 toolbar/容器内的 label 禁止内容切换（图标恒定，
  状态反馈走 status 槽）；页面内容层的同类切换（workspaceButton）安全。
  **教训一**：视觉瞬态 bug 先问用户"哪个元素在动、什么状态在变"——
  用户一句"…变成 loading 圈且位置错了"抵过前面十轮盲试构建；观测
  手段受限时应更依赖用户观测，不是更少。
  **教训二**："上游也有 ≠ 不可修"——那是共同代码的交互 bug，修法是
  绕开触发动作（去掉 label 切换），不是修系统动画层。
  **教训三**：条件化修复（宽屏恒定/窄屏切换）两版（@State 异步置位、
  GeometryReader 同步取值）均有漏网帧回归——条件分支天然带竞态，
  无条件方案 + 反馈换位优先。
  已试且无效的完整清单（别再试）：transaction 压动画、清 draft 焦点、
  glassEffectID 注释/共享 namespace、detail 包 NavigationStack、
  ToolbarItem 合组、整页 opacity transition、自绘右缘竖排。

## 右缘竖排 toolbar（iOS 26 宽 detail 系统容器）收编规则

> 已被 req:ios/duo-layout.md#竖排-toolbar-官方规则与最终形态 取代
> （2026-10-28）；正文保留为历史。结论性修正：条目**应收 Label（图标
> +标题）**而非零修饰裸图标（Label 化后系统"…"溢出菜单才有内容、
> 不再是死控件）；键盘期折叠的真因是**溢出**而非键盘，解法是
> `visibilityPriority` + `ToolbarOverflowMenu`，**不是**高度阈值撤注入。

宽 detail（Duo 横屏）下系统把 `topBarTrailing` items 重排成右缘竖排
glass 容器。往里放自定义控件受两个正交维度约束（2026-10-27 八轮
真机/模拟器实证）：

1. **注入层级：只收页面级**。shell 级（ChatShellView 的 content
   closure 上）声明的 toolbar 项不进竖排、留顶部导航栏；页面级
   （页面 body 内，经 ChatPageToolbar.railTrailing / environment
   `chatRail` 注入）与 folder/… 同源，进竖排。
2. **内容形式：只收零修饰 label**。纯 symbol / 裸 `Image(uiImage:)`
   可以；带 frame/clipShape 修饰链的被踢回顶部；自定义 SwiftUI
   视图（AccountAvatarView 等）被直接丢弃。裸 UIImage 按自身
   size(pt) 显示——裁剪/缩放必须在像素层完成（居中裁方+圆蒙版，
   `UIGraphicsImageRenderer` format.scale=3 防"像素数当 pt"渲染
   巨大），渲染经 onChange 驱动 @State 缓存。
3. **toolbar 项是 per-page 的**（2026-11-16 实测）：`ChatPageToolbar` 挂在
   `NavigationStack` **外层**时，`navigationDestination` push 出来的页面不会
   继承那份 toolbar——右缘 rail 整个消失，只剩返回按钮。每个 destination
   页面都要自己再挂一次同一个 `ChatPageToolbar`（把修饰器抽成计算属性复用，
   不要复制签名）。

键盘弹出（detail 高度骤减）时系统把竖排折叠成**点不动的溢出
"…"**——用 detail 高度阈值（>450）在键盘态主动撤注入，侧栏底栏
（同一开关）恢复，键盘收起换回。iOS 27 另有 `topBarPinnedTrailing`
可钉顶栏不进竖排（未采用，形态不符）。

**方法论**：黑盒系统容器调试，先枚举正交维度（层级/形式/时机），
一轮只变一个并记录矩阵——本轮前四轮把"层级"与"形式"混着试全灭，
拆开后两轮破案。移动端黑盒 UI 调试中用户是最高效观测器（本轮与
玻璃圆圈轮两次验证，用户插话均为转折点）。

## 双栏侧栏顶部偏移

`SidebarDrawer.swift` `SidebarDrawerNativeSidebar.topLift`：
竖屏（safe area top ≥ 40pt）上移 -56pt（抵消 Liquid Glass 容器额外顶部
inset ~21pt + 竖屏收紧 35pt，实测验收值）；横屏不下移为负——固定上移
会把 logo 推出屏幕（横屏改为 +14pt 微调）。这些是测量值不是推导值，
调整前先截图量化。

## 表格/滚动内容的视口宽度（2026-10-24 表格修复，b7d1d4f7）

横向 `ScrollView` 给内容的宽度提案是 **nil**（内容可无限宽），布局期
从 proposal/bounds 都拿不到视口宽。任何需要"视口宽"做自适应的滚动
内容，只能用 `onGeometryChange` 从 ScrollView 自身 frame 发布进
`@State` 再传入布局（见 `ChatMarkdownTable.viewportWidth`）。

表格列宽契约：列宽 = clamp(单行理想宽, 76, min(260, max(76, 视口/列数)))，
表格窄于容器时富余均分拉伸（拉伸阶段不设上限），宽于容器保持横向滚动。

## 文字断行（已调查，非 bug，别再追）

SwiftUI `Text` 对 CJK+西文混排的断行与 CoreText 理想排版存在每行
±1~2 字的确定性偏差（字体回退与行尾计算差异）。同宽度下断点确定性
复现（旋转实验验证），无缓存泄漏、Textual 无责、上游无同款报告。
用户观感差异多来自段落内半角字符占比（半角 ≈9pt vs 中文 17pt，同宽
度行字符数差可达 12）。

**判别手法（下次直接用）**：

1. 旋转实验分流：横→竖→横断点**复原** = 确定性排版（平台行为，非
   缓存 bug）；断点**变化** = 布局固化在过渡宽度（真 bug，查缓存链）。
2. CoreText 权威复算（`swift /tmp/wrap.swift`，命令行即可跑）：

```swift
import CoreText
// width = 布局日志拿到的块提案宽度（如 803）
let attr = NSAttributedString(string: 段落原文,
    attributes: [kCTFontAttributeName as NSAttributedString.Key:
        CTFontCreateWithName("PingFangSC-Regular" as CFString, 17, nil)])
let setter = CTFramesetterCreateWithAttributedString(attr)
let frame = CTFramesetterCreateFrame(setter, CFRange(),
    CGPath(rect: CGRect(x: 0, y: 0, width: 803, height: 10000), transform: nil), nil)
let line = (CTFrameGetLines(frame) as! [CTLine])[0]
// CTLineGetStringRange + CTLineGetTypographicBounds → 第一行尾字与宽度
```

3. 块提案宽度用临时布局日志拿（`MarkdownBlockLayout.sizeThatFits`
   打 proposal），日志代码带 `AA-DIAG:` 标记，完事 grep 清理。

## 双屏（半折叠）契约（2026-10-25 任务 10-25-ios-duo-dual-screen）

- 布局：`DuoArrangementHost`（UIKit 桥）+ `.split` 最简配置；**不要**给
  arrangement 加 axes/viewProperties（真机实测 primary 会被挤成窄条）。
- 输入 dock 永远做浮层 + `keyboardLayoutGuide` 锚定，**不要**放进 pane
  （pane 布局被 arrangement 截断，键盘下 dock 跳位）；
  **不要**用 keyboard frame 通知算抬升量（lift 实测波动 395↔495）。
- dock 浮层容器必须 `hitTest` 穿透（否则消息流无法滑动）；
  hosting 必须 `[.intrinsicContentSize]`（否则指令面板被裁）。
- 视图实例稳定 > 一切：pane↔浮层切换会重建 SwiftUI 实例、丢输入焦点。
- 外层 `.ignoresSafeArea(.keyboard)` 必须加（否则键盘压缩容器重排 pane）。

## iOS 27.1 arrangement API 的 Swift 调用形态（2026-10-25 SDK 实证）

SwiftUI **无**任何 arrangement/hinge 公开符号（swiftinterface 0 匹配；外部
文章声称的 `ArrangementView` 系 AI 写作失实）。全部走 UIKit，Swift 化名与
ObjC 头文件差异如下（`@available(iOS 27.1, *)`）：

```swift
let vc = UIArrangementViewController()
vc.setViewController(host, for: .primary)      // NS_REFINED_FOR_SWIFT: forPlacement → for
vc.updateArrangement(.split)                    // UISplitArrangement.split 静态成员
// ❌ splitArrangement() 不存在（头文件 +splitArrangement 的 Swift 化）
// ❌ UISplitArrangement.ViewProperties() 无公开 init：
// ✅ var props = split.defaultViewProperties   // 拷贝默认值再改
```

`UIHostingController.sizingOptions` 赋值不能在 `[a, b]` 数组循环里做——
数组把类型擦成 `UIViewController`，编译报"no member"，必须逐个写。

## 真机构建/部署工作流（2026-10-25）

```bash
# Xcode 开着会锁 build.db，用独立 derivedDataPath：
xcodebuild -project "Agents Anywhere.xcodeproj" -scheme "Agents Anywhere" \
  -destination 'id=<UDID>' -allowProvisioningUpdates \
  -derivedDataPath /tmp/duo_dd_dev build
xcrun devicectl device install app --device <UDID> \
  "/tmp/duo_dd_dev/Build/Products/Debug-iphoneos/Agents Anywhere.app"
xcrun devicectl device process launch --device <UDID> com.dae.sr1023
```

- **bundle id 两套**：真机构建 `com.dae.sr1023`（签名配置），模拟器构建
  `com.agentsanywhere.app`——launch 时用错会 NotFound。
- 构建脚本必须以 `BUILD SUCCEEDED` 判定后再 install；grep 到 error 行返回
  0 会让 `&&` 链继续装旧产物（本轮实测踩坑）。
- 真机锁屏时 `devicectl launch` 报 `BSErrorCodeDescription = Locked`，
  解锁后手动打开或重试。
- **"是不是我们引入的"判定——上游对照法**（2026-10-27 实战 5 分钟出
  结论）：`git worktree add /tmp/up origin/main` 后在其 ios 目录用
  `PRODUCT_BUNDLE_IDENTIFIER=com.dae.sr1023 DEVELOPMENT_TEAM=…` 覆盖
  官方签名构建，装真机复现。疑点先做这个对照再动手修——玻璃圆圈
  bug 走了十轮盲试，此法可开局即定性。

## 键盘跟随（2026-10-25 真机验收）

半折叠/展开下点输入框，消息流要滚到最新：
- 视口高度骤减（onGeometryChange，键盘 inset 不进 GeometryProxy.safeAreaInsets）
  直接 `position.scrollTo(edge: .bottom)`——**不要**走 scrolling.requestBottom
  状态机：pendingBottomRequest 计算属性在键盘布局动荡期因 viewport 样本
  失效返回 nil（begin 拿不到请求，日志实证）。
- 侧栏/非输入列控件用 `.ignoresSafeArea(.keyboard)` 固定。
- updateUIView 内**禁止同步** becomeFirstResponder（聚焦触发布局变化时
  与键盘 reload 同步重入，主线程假死；异步派发即可）。
- 根本心法：系统键盘避让本身就是"内容上推"设计，不要自建容器对抗。


## 输入行（ComposerLayout）多按钮排布契约（2026-10-26）

`Composer/ComposerLayout.swift` 是自定义 Layout，子视图按**声明顺序**定位：

| 索引 | 内容 | 位置 | 条件 |
|---|---|---|---|
| 0 | +（附件/选项） | 左缘 | 恒定 |
| 1 | 编辑器 | 中间 | 恒定 |
| 2 | 发送/停止 | 右缘 | 恒定 |
| 3 | 指令 ⌘ | 发送左一格 | `showsCommands` |
| 4 | 收起键盘 ⌄ | 指令左一格 | `draft.isFocused` |

- **声明顺序即视觉顺序**：往输入行加按钮时，在 ChatComposer 闭包里
  按目标位置声明；紧邻发送键的位置留给高频主操作（误触考量，
  2026-10-26 收起键曾放发送旁被用户要求挪到指令左侧）。
- `editorWidth` 的 `extra = (count-3) × touchTarget`：新增条件按钮
  自动收窄编辑器，无需逐处改宽度。
- 条件按钮组合（3/4/5 个子视图）由 count 判断放置，无法感知身份——
  无指令的 runtime 下收起键会落在发送旁（已知边缘，暂不修）。
- ChatComposerDock 的指令面板是**浮层**（overlay + dockHeight 偏移），
  不占布局流；新增弹出类 UI 照此模式（见 guides 铁律 16）。

## Composer 输入框：回归上游，放弃单行/手动跟随方案（2026-10-28）

上游模式即正确答案：`expanded: draft.isExpanded` + 高度
`min(160, max(72, height*0.30))`，`sizeThatFits` 在测得高度超上限时自动
切回 `isScrollEnabled = true`，内部滚动与光标跟随全部交还系统。
本轮弃用的两条岔路及教训：

- **Duo 全域 collapsed 单行（44 钳制）**：ComposerLayout 在 collapsed 下
  `sizeThatFits` 恒返回固定胶囊高度，编辑器只是居中向外溢出绘制——
  玻璃不长高、文字"跳出输入框"，第三行起溢出的编辑器视图盖住尾部
  按钮导致收键盘键失灵。**给不自适应的容器调高度上限是治标**。
- **手动 setContentOffset 光标跟随**（scrollEnabled=false 下程序设置
  仍生效）：内容偏移无系统回收，状态残留，与增高切换互相干扰。为
  钳制方案打的补丁，钳制一撤就必须整块删除，不能留。
- `scrollEnabled=false` 是上游固有设定（sizeThatFits 自适应增高的
  前提），不是我们加的——不要动它。
- 收起键盘按钮**直接 `editor.finishEditing()`（同步 resign）**，不要
  只写 `draft.isFocused = false` 走 updateUIView 异步收起链：输入过
  文字后该链真机竞态失效（键盘不落）。按钮事件上下文里同步 resign
  安全；危险的只是布局中间态里的同步 setContentOffset（曾致
  CALayer NSException 闪退，见上文）。

## 尾部状态行必须在布局流内（2026-10-28）

ChatTimelineContent 尾部的发送/运行状态行（"正在处理任务…"，恒定
32pt、无状态时 Color.clear 占位）是上游刻意的**布局流元素**。曾为省
末条消息后的 20pt 间距改成底部 overlay 浮层——运行中状态文字直接浮
盖末条消息、与工具调用/推理文本重合。省间距的收益远小于叠字，回归
上游原样；间距问题如再修，方向是调 VStack spacing，不是挪出布局流。

## 竖排 toolbar 官方规则与最终形态（2026-10-28，多轮真机实证收敛）

权威来源：Apple iPhone Duo Tech Talks 111461-111466 + Lab Q&A（本地技能
`iphone-duo-porting` / `swiftui-iphone-duo`，SDK 接口文件为一手验证）。

**最终结构**（ChatPageToolbar，签名即契约）：

```swift
// shell 注入（ChatShellView，Duo 内屏恒注入、结构恒定）
struct ChatRailContext {
    let onNewSession: () -> Void
    let onAccount: () -> Void
    var avatarImage: UIImage?     // 像素层 38pt@3x 圆形蒙版成品
}
// 页面消费（NewSessionView / SessionChatView）
ChatPageToolbar(railTrailing: [ChatRailButton],     // id 编入头像就绪状态
                pageTrailing: [AnyView],            // 一般为空
                overflowActions: [ChatOverflowAction]) // 进系统"…"第一层
struct ChatRailButton: Identifiable { let id: String; let view: AnyView }
struct ChatOverflowAction: Identifiable {
    let title: String
    var systemImage: String? = nil   // 溢出菜单行图标，缺失=纯文字行
    var isDisabled = false
    var isDestructive = false        // 红字角色（如删除设备）
    let handler: () -> Void
}
// 2026-10-29 勘误：旧签名缺 systemImage/isDestructive，曾导致图标全丢
// （见下文「溢出菜单动作必须带图标」节），新动作勿照旧版抄写。
// RailPinnedItem = ToolbarItem + visibilityPriority(.high)（iOS 27 门控）
```
- 条目一律 `Label(标题, image: 资产名)`——竖排显图标、系统"…"溢出菜单显
  标题；纯图标/纯标题/自定义 view 条目不进竖排。例外：动态头像用裸
  `Image(uiImage:)`（竖排唯一实证可进的形态）。
- 高频项 `.visibilityPriority(.high)`（iOS 27+，RailPinnedItem 包装）：
  键盘压缩竖排时保留在栏内；溢出自下而上，低优先级组先进"…"。
- 次级动作放 `ToolbarOverflowMenu`（iOS 27+）直接进系统"…"第一层——
  **禁止自造 ellipsis 菜单**（会形成"…"套"…"两层）。
- Duo **内屏与合盖外屏恒注入**同一套条目（placement 恒 `.topBarTrailing`，
  系统自行分派：横屏进右缘竖排、竖屏进顶栏）。
- 侧栏底栏按形态收窄：内屏双栏恒空（竖排常驻可见）；合盖外屏的抽屉
  **保留**底栏——抽屉展开会盖住 detail 顶栏，此时 rail 不可见，清空底栏
  就没有新会话/账号入口。

**踩坑实录（每条都有真机证据）**：
- 系统"…"溢出是死控件时不可交互——但条目无标题时菜单为空也表现为死；
  Label 化后系统"…"正常弹菜单。
- `ToolbarItemGroup` 是竖排溢出的最小单位，组内任一放不下整组折叠。
- 相邻同 placement 的组会被并成一个大胶囊；`ToolbarSpacer(.fixed)` 断开。
- `toolbarMinimizationBehavior` 只管**滚动**触发的折叠（官方文档），
  与键盘溢出折叠是两回事。
- 键盘期对 toolbar 做任何增删/结构切换（撤注入、组↔菜单、placement
  切换）都会在恢复后**丢条目**——恒定结构 + 官方优先级机制才是解。
- 运行时更新条目**内容**系统不重画（头像异步就绪后不出现，点新会话
  换页才出现）：把状态编进 ForEach id（placeholder→avatar 换 id 强制
  重建条目）。
- rail 检测不用几何比例猜：官方信号 `toolbarVerticalEdge`（iOS 27.1+，
  nil=水平条）；本仓最终连它也不需要——Duo 内屏恒注入即可。

## 合盖外屏外壳 = 原版抽屉（2026-11-04）

- Duo 合盖（compact width）与普通 iPhone 共用 `sidebarLayout(.drawer)`，
  没有独立外壳。两 Tab 的 `CompactChatShellView` / `CompactSessionListView`
  / `CompactMoreView` 已删除；判据仍是 `horizontalSizeClass`，不要给外屏
  再加设备型号分支。
- Duo 专属入口只走 rail（`chatRail` 注入条件 `isDuoFoldableIPhone`），
  竖屏落 detail 顶栏、横屏进右缘竖排；**不自绘常驻右侧栏**（外屏窄，
  常驻竖排会挤压内容，且与系统 placement 分派重复）。
- 历史：两 Tab 是 2026-10-22 `10-22-ios-foldable-adaptive-ui` 的 Q1 决策
  （普通 iPhone 与外屏统一两 Tab），2026-11-04 用户要求外屏回归原版后
  撤销。外屏原有入口（设备/账号/设置/配对）在 `ChatSidebarView` 均有
  等价实现，删两 Tab 不丢功能。
- **抽屉打开期间不渲染详情导航栏**（`ChatPageToolbar` 读
  `\.sidebarDrawerObscuresDetail`）：抽屉一开就盖住详情，导航栏在卡片
  位移中会被系统重画一次，表现为"顶部 toolbar 闪现又消失"（2026-11-05
  真机反馈）。nativeSidebar 下该环境值恒 false，内屏不受影响。
- **不要用 `toolbarVerticalBehavior(.disabled)` 调位置**：Apple 的 Duo
  规则是外屏 toolbar 永远竖排在侧边；该开关必须当稳定选择，禁止随方向
  或视图状态切换。2026-11-05 试过"横屏禁用竖排回顶部"，系统在旋转时
  重建 toolbar，横屏观感反而怪，已撤回。**位置交给系统分派**。
- **不要自绘右缘竖排**：做过两版（两个按钮 / 带「…」溢出），均撤回。
  系统 toolbar 自己会分派竖排，自绘等于重造 glass 容器与按钮间距，
  尺寸和材质对不齐。

## 溢出菜单动作必须带图标（2026-10-29）

`ChatOverflowAction` 有 `systemImage` 字段，渲染处有图标走
`Label(title, systemImage:)`——**溢出菜单迁移时图标最容易丢**：把自造
"…"菜单（`Button(title, systemImage:)`）搬进系统 `ToolbarOverflowMenu`
时，只搬标题不搬 SF Symbol 会让所有 "…" 二级菜单变纯文字（用户对照
上游发现，2026-10-29 修复 `e9eeaa6e`，13 个动作全部按上游原值补回：
sparkles/folder/info.circle/number/doc.on.doc/square.and.pencil/pencil/
key/trash）。新增溢出动作时对照上游同名菜单选图标。

## 机型门控的保留理由（swiftui-iphone-duo 审计结论 2026-10-28）

`isDuoFoldableIPhone` 共 4 处（2026-11-04 外屏外壳回归原版后减一处），属
skill 红旗（`if isIPhoneDuo`）但**有意保留**：rail 注入/侧栏底栏按形态
收窄/内屏内容宽度上限是折叠屏专属产品行为，用
`horizontalSizeClass == .regular` 替代会误伤 15PM 横屏（同样 regular
width）。已知的取舍：内屏聊天列全宽（2200 上限）违背 Rule 21"更宽≠
更长文本行"，是用户决策"折叠屏铺满"。审计其余全合规（无 UIScreen/
orientation/自定义 bar；adaptive grid、ViewThatFits、可读上限、系统
容器齐全）。sheets 36 处未设 presentationPlacement——2026-10-28 真机
半折叠姿态抽查通过，系统默认落位合理，无需逐处补设。

## 侧栏启动设置契约（2026-10-28，fa61170f 单测锚定）

`ChatSidebarState` 持有三个 UserDefaults 键（常量集中定义，禁止裸字符串）：

```swift
static let openOnLaunchDefaultsKey  = "chat.sidebar.openOnLaunch"   // Bool，默认 true
static let rememberStateDefaultsKey  = "chat.sidebar.rememberState" // Bool，默认 false
static let lastOpenDefaultsKey       = "chat.sidebar.lastOpen"      // Bool，分栏开合快照
```

**优先级矩阵**（ChatShellView 启动解析 `defaultOpen`）：

| rememberState | lastOpen 存在 | 启动态 |
|---|---|---|
| true | 是 | lastOpen（记忆恢复，设置页"启动时展开侧栏"置灰） |
| true | 否 | 退回 openOnLaunch |
| false | — | openOnLaunch（默认 true = 现行为） |

- **快照时机**：`onChange(sidebar.isOpen)` 且 `layout == .regularSplit` 即时写；
  rememberState 开关刚打开时立即落当前值（避免"开启记忆后首启仍用默认"空窗）。
- **抽屉形态恒闭合启动**，两个设置都不作用于它（抽屉盖内容）。
- **错误写法**：把 lastOpen 写进 `isOpen(in:)` 内部——该函数是纯查询，
  写入应在 shell 的 onChange 层（副作用与查询分离）。
- **测试锚**：`ChatSidebarStateTests.launchDefaultControlsTheInitialSplitState`
  （defaultOpen=false 闭合启动 / 抽屉不受影响 / 显式开合不被同值 setLayout 重置）。
