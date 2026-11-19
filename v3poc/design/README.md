# AA 设计系统（v3 PoC）

iOS PoC（`v3poc/ios/`）是基准，Android PoC（`v3poc/android/`）照着它一比一实现：同样的颜色、字号、间距、圆角、动画参数、图标和交互。这里记录两端共用的数值和 Android 上做不到或做法不同的地方。

## 文件

| 文件 | 内容 |
| --- | --- |
| [`TOKENS.md`](TOKENS.md) | token 的来源、玻璃叠色、描边、开关与生成校验规则 |
| `tokens.json` | 颜色（`[浅色, 深色]`，`#RRGGBBAA`）、字体（iOS Dynamic Type「大」档的字号 / 行高 / 字重）、尺寸、动画（SwiftUI 的 `response` / `dampingFraction`）。数值从 iOS 代码和截图量出来，pt 直接当 dp 用 |
| `../android/tools/tokens2kotlin.py` | `tokens.json` → `AATokens.kt`（`AAColors`、`AAFonts`、`AAMetrics`、`AAMotion`）。改了 tokens 之后运行 `python3 -I v3poc/android/tools/tokens2kotlin.py` |
| `../android/tools/svg2compose.py` | iOS 资源目录里的 `aa-*.svg`（Lucide 路径和三个 Agent 标志）→ `AAIcons.kt`（Compose `ImageVector`），并带上 iOS `AppSymbolAssets` 里 SF Symbol 名到图标的对应表，所以两端按同一个名字取到同一个矢量 |

iOS 端没有读 `tokens.json`，数值仍写在 Swift 里；`tokens.json` 是从 iOS 抄出来的，iOS 改了要同步过来。

## 组件对照

| iOS | Android | 一致的地方 | 不一致的地方和原因 |
| --- | --- | --- | --- |
| `AppTheme` 颜色、`.systemBackground` | `AATheme` / `AA.colors` | 浅深两套颜色、页面底色（白 / 黑），WebView 下面没有接缝 | 玻璃上的次要文字比 iOS 的 `secondaryLabel` 深（对比度要求，见「对比度」） |
| `RoundedRectangle(style: .continuous)` | `continuousRect`（Kyant shapes，连续曲率 G2） | 所有非胶囊的圆角矩形：Sheet、审批区、输入框卡片、菜单、选项卡片；抽屉卡片的圆角取系统报告的屏幕圆角（`WindowInsets.getRoundedCorner`，每个角分别取，拿不到时 44 dp） | 胶囊（按钮、Toast、「到底部」）仍是普通半圆，和 SwiftUI `Capsule` 默认一致 |
| SwiftUI `Text` + Dynamic Type | `AAText` + `AAFonts` | 字号、字重、单行文字的高度（SF 的 ascent + descent ≈ 1.19 × 字号） | 字体不同：iOS 是 SF + 苹方，Android 是 Roboto + Noto Sans CJK，字宽和字形不一样，同一行字在 Android 上长短略有差别。Android 默认会把含中文的一行撑到 Noto CJK 的高度（≈ 1.45 × 字号），`AAText` 把单行文字的高度改回 SF 的高度，否则每个中文行都比 iOS 高 3–4 dp |
| `AAWordmark`（Caveat） | `AAWordmark` | 同一个字体文件 `caveat_wght.ttf`，字重 500 | 无 |
| `AppSymbol`（Lucide 资源） | `AASymbol` / `AAIcons` | 同一份 SVG 转成矢量，名字和尺寸相同 | iOS 也全部走 Lucide 资源，没有直接用 SF Symbol 的地方。Android 自己加了三个图标：`ChevronLeft`（Sheet 返回）、`CircleStop`、`SquareFill`（停止按钮），都是 Lucide 风格 |
| `SessionAgentIcon` | `AgentIcon` | Codex / Claude Code / DeepSeek 标志相同，其他用 Lucide Bot | 无 |
| `ProgressView()` | `AASpinner` | 8 根辐条、每步转 1/8 圈 | 手画的，辐条粗细和透明度是目测 |
| `.glassEffect(.regular)` | `Modifier.glass(GlassKind.Regular)` | 形状、尺寸、高光描边、阴影、按下变暗；开启时模糊 + 折射线程（Kyant backdrop） | 折射是 Kyant 的透镜近似（Android 13+），没有液态变形；降级时是不透明实色（见下文「毛玻璃」） |
| `.buttonStyle(.glass)`（审批区按钮） | `GlassButton` → `GlassKind.Button` | 胶囊 48 dp、内边距、字号，嵌套按钮采样已绘制的审批区；降级为浅色 #F8F8F8 / 深色 #3E3E3E 实色 | 模糊时由嵌套表面着色和提亮共同合成，见 TOKENS.md |
| `.glassProminent` | `GlassKind.Prominent` | 浅色黑底白字、深色白底黑字 | 浅色灰色立体边缘高光仍待 iOS 参考截图取色，现有渐变细边不能视为已对齐 |
| `AppGlassButton` 圆形（顶栏） | `GlassCircleButton` | 44 dp、图标 20 dp | 无 |
| `ChatPageToolbar` | `ConversationPage` 里的 `Toolbar` + `TopEdge` | 左右圆形按钮、两行标题、状态图标 | iOS 用系统滚动边缘效果；Android 用线程 backdrop 分层模糊并渐隐，关闭玻璃时改用页面色渐变 |
| `ChatComposer`（胶囊 ↔ 展开卡片） | `Composer` | 收起 48 dp / 左右 32 dp / 圆角 24；展开左右 12 dp / 圆角 26；同一套高度公式和 0.24 s 动画；发送 / 停止按钮 36 dp，禁用时 0.42 × 0.5 透明度 | 输入框是 `BasicTextField`，选择柄、放大镜、输入法是 Android 的 |
| `ApprovalDock` | `ApprovalDock` | 圆角 24 卡片、盾牌图标标题、两行等宽命令、三个按钮（按宽度把「本会话都允许」收进「更多」菜单） | 无 |
| 「到底部」胶囊、Toast | `GlassCapsule` | 位置（输入框上方 50 dp）、出现时缩放 + 弹簧 | 无 |
| `SidebarDrawer`（卡片平移 + 圆角 + 点击条） | `SidebarDrawer` | 同样的弹簧（response 0.34、阻尼 0.9）、0.2 s 投影、过半阈值、主卡片圆角 44 dp、侧栏 0.95 → 1 缩放、白色遮罩、右侧点击关闭 | Android 的左边缘是系统返回手势，只能用 `systemGestureExclusion` 在屏幕中段排除一段（系统最多允许每边 200 dp），从这段之外的左边缘拖动是系统返回 |
| `.sheet` + `presentationDetents([.medium, .large])` | `AASheet` | 中 / 大两档、拖动条、圆角 36、底部浮起 8 dp、下拉关闭；中档不压暗背景，大档不透明并出现遮罩 | Sheet 是在同一个窗口里画的（圆角是连续曲率），不是独立的系统窗口；中档高度按屏幕比例（0.52），Pixel 9 比 iPhone 高，所以 Sheet 顶边位置略低 |
| `SheetCloseButton`、Sheet 标题栏 | `SheetHeader` | 左上 44 dp 玻璃圆钮（关闭 X / 返回 ‹）、居中标题 | 无 |
| `Menu`（长按菜单、顶栏「…」） | `AAMenuHost` | 250 dp 宽、圆角 22、44 dp 行高、图标在右、分隔线、从锚点缩放出现、背景压暗 | iOS 菜单是系统画的（带模糊和弹性滚动）；Android 随「面板和菜单的玻璃」决定模糊或不透明底色，长按没有 iOS 的「预览上浮」效果 |
| `Toggle` | `AASwitch` | 63 × 28 dp 轨道、37 × 24 dp 胶囊滑块、2 dp 内缩；按住等比放大 1.5 倍，可水平拖动 | Android 13+ 且面板玻璃有效时使用模糊透镜；其余情况滑块保持不透明白色 |
| 按钮按下（普通项变暗 / 玻璃控件等比放大） | `Modifier.pressable(Press.Dim / Scale)` | 没有 Material 水波纹 | 无 |
| 返回 | 预测性返回（`enableOnBackInvokedCallback`） | — | 只保留这一个 Android 习惯：依次关闭 Sheet、抽屉、键盘 |

## 毛玻璃

iOS 的液态玻璃由系统合成，能模糊并折射下面的任何内容，包括 WKWebView；iOS 的对比度由系统处理，不增加自定义染色。Android 上试过的方案：

| 方案 | 结果 |
| --- | --- |
| Kyant `backdrop` 2.0.1，WebView 不加硬件层（当时 CPU 软件渲染的模拟器） | 当时放弃：`tile memory limits exceeded`，线程闪烁、空白 |
| 同上，host GPU 模拟器、release 包 | 仍然闪烁：10 s 录屏 599 帧里 137 帧线程空白、69 次一闪而过的空白；341 次 tile 报错。原因不在软件渲染，而在 WebView 的绘制函数被带着 RenderEffect 重复执行（Kyant backdrop #16、Haze #99） |
| Kyant + `webView.setLayerType(LAYER_TYPE_HARDWARE)` | WebView 先画进自己的硬件层，backdrop 录制的是这张纹理：录屏 600 帧 0 空白、0 闪烁；tile 报错一次 4 次、一次 0 次 |
| Kyant + `offscreenPreRaster = true` 单独 | 仍有线程整片空白的帧，不够 |
| **Kyant + 硬件层 + `offscreenPreRaster`（现在用的）** | 录屏 0 空白、0 闪烁，两次都 0 次 tile 报错。release 包、宿主空闲时帧时间 p50 / p90：关玻璃 24 / 31 ms，开玻璃 31 / 36 ms；渲染进程 PSS 基本不变（168 → 170 MB） |
| 窗口级模糊（停止） | `FLAG_BLUR_BEHIND` + `blurBehindRadius` 在模拟器上能出模糊（整屏），说明 SurfaceFlinger 能做；`setBackgroundBlurRadius`（每窗口背景模糊）在这个模拟器上不生效，SurfaceFlinger 层里没有 blur region（窗口主题设了 `windowIsTranslucent` 也一样）。公开 API 下每个窗口只有一块模糊区域，要把每块玻璃拆成独立窗口，还要处理和主窗口同帧移动、输入法焦点、无障碍；用户否掉了双窗口方案，不再继续 |
| 自己写的 `AAFrostedGlass` | 保留为「原生内容上的模糊」（侧栏底部栏：录制侧栏列表，RenderEffect 模糊），以及所有降级情况下的外观 |

**顶部模糊渐变**（iOS 26 的 scroll edge effect）：状态栏和顶栏下面的线程用同一个 backdrop 来源模糊，越往下越弱并淡出：三份不同半径（20 / 10 / 4 dp）的模糊各自用竖直渐变遮罩叠起来，近似可变半径，上面再叠一层淡出到透明的页面色（在顶栏标题处的不透明度和模糊玻璃相同，保证标题对比度）。只做顶部，底部不模糊。不模糊的情况下保持页面色渐变（淡出到页面颜色，不是半透明着色）。

**规则：只有真正在模糊的地方才半透明。** 开关打开、Android 12+、不在省电模式、系统没有提高对比度或关闭动画时：WebView 上方的玻璃（顶栏按钮和标题、输入框、审批区、「到底部」、Toast）用 Kyant 录制线程后模糊 + 鲜艳度，Android 13+ 再加透镜折射；原生内容上方用 RenderEffect 模糊。其余情况（开关关闭、省电模式、Android 12 以下、系统提高对比度 / 关闭动画、下面没有可录制的内容）一律用**不透明实色**（`glassTintOpaque`、`sheetBackgroundOpaque`、`glassButtonTint`），描边和阴影保留，控件和下面的内容依然分得开。Sheet 和菜单由「面板和菜单的玻璃」单独控制；关闭时用不透明实色。Sheet 中的选项卡片始终不透明。

开关：「账户」Sheet 里的「毛玻璃效果」，保存在 SharedPreferences，立即生效；Android 12 及以上默认开，Android 12 以下不能开（RenderEffect 需要 API 31），设置里写明原因；省电模式下自动暂停并提示「省电模式下已暂停」，可以用「省电模式下也开启」覆盖。关闭时形状、尺寸、描边和阴影都不变，只是不录制、不模糊、改实色。通过 `LocalGlassMode` 和 `LocalWebBackdrop` 传给所有玻璃控件。

## 面板、菜单与嵌套玻璃

- 「毛玻璃效果」是总开关；「省电模式下也开启」只覆盖省电策略，不覆盖 Android 版本和无障碍降级。
- 「面板和菜单的玻璃」只控制 Sheet 和菜单。开启后，仅在它们显示或退出动画尚未结束期间额外录制整屏；全部关闭后停止录制。会话区控件仍使用单独的 WebView backdrop。
- Sheet 中档是玻璃，后面的页面不压暗；拖到大档时渐变为完全不透明。里面的卡片始终是不透明白色 / `#2B2B2B`。
- 审批区先导出自身绘制结果，内部按钮再模糊这层；Sheet 内的玻璃按钮同理。不能越过父玻璃直接采样线程，否则深色叠层的亮度不正确。
- 「模糊程度」连续取值 0…1，默认 0.5。改变模糊半径和表面着色强度，不改变折射、提亮和边缘；清透端仍保留至少 0.5 个物理像素的模糊。关闭玻璃时滑块禁用。
- 面板开关节省了额外录制和合成工作；实际省电比例尚待受控真机测量，不能由帧时间推算。

## 描边与按压

玻璃模糊时使用 Kyant 的顶部 / 底部高光，再叠加 0.5 dp 外缘：圆角两端较深，长直边较淡。外缘色来自 `glassRimEnds` / `glassRimMiddle`。实色或原生模糊降级使用 1 dp 上下渐变高光，再叠同一外缘。两种路径不能同时叠加两份 Kyant 高光。

突出按钮始终使用不透明主色，现有 1 dp 顶部高光是独立路径；浅色「允许」按钮的完整灰色立体边缘尚待参考截图对齐。不要靠目测替换颜色，也不要改 iOS 系统染色。

按住玻璃控件时 X/Y 使用同一缩放系数，按长边最多增加 10 dp（比例上限 24%）；阻尼回弹参数为 `dampingRatio=0.55`、`stiffness=450`。普通菜单行仍只变暗。开关滑块的轨道和按压参数见 TOKENS.md。

## 对比度

只调颜色，不改字号、字重、行高，也不加文字底衬。要求（WCAG AA）：文字 4.5:1；大字（≥ 18 sp，或 ≥ 14 sp 粗体）、图标、控件边界 3:1；深浅色都要满足。模糊玻璃的背景会变，按最坏情况算：玻璃着色叠在纯白、纯黑、线程里最亮和最暗的内容（代码块、用户气泡、图片）上，相当于模糊把下层抹成一种颜色。

`python3 -I v3poc/android/tools/contrast.py <out.md>` 按 `tokens.json` 计算这些组合，并给出全部达标所需的最低模糊着色不透明度。历史结果（`.local-dev/v3poc/android/contrast.md`）验证的是旧的固定着色路径，不能据此宣称新透镜路径、全部滑块档位或嵌套玻璃已通过。原来的调整包括：

- 新增 `controlSecondaryLabel`（浅 `#3C3C43E0`、深 `#EBEBF5BF`）：玻璃控件上的次要文字（顶栏副标题、输入框占位符、审批区命令和计数）。iOS 的 `secondaryLabel`（60%）叠在白色上只有约 3.5:1。
- 新增 `glassTintBlur`（浅 `#FFFFFFBF`、深 `#262628CC`）：只在真正模糊时使用；达标所需的最低不透明度浅色 0.74、深色 0.80。
- `glassTintOpaque` 深色改为 `#202022`（对齐 iOS 截图里的颜色），`glassButtonTint` 改为不透明。

线程里的颜色（例如「等待你确认」的黄色）由渲染包决定，不在这里。

## 截图对照

`.local-dev/v3poc/android/compare/`（不提交）：同一逻辑宽度（2 px / pt 或 dp）下 iOS 和 Android 左右并排，`tools/compare.sh` 生成。
