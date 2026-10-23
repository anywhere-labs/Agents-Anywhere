# 鸿蒙 vs 安卓 功能对齐状态（2026-10-23 第二十四轮更新）

调查对象：本仓库 `android/`（Kotlin 参考端）与 `harmony/`（ArkTS，API 26）。
本文档为**当前状态快照**：此前多轮差距清单中的项目已按批次实现并逐批通过 `devecocli build` 验证。每批实现均以安卓源码与 Server 契约（`server/agent_server/api/`）逐字段核对。
2026-10-19 第二轮：完成 8 页面逐元素代码级对比审查，随后按 B1–B5 五批修复全部审查差距（文件页/终端/会话详情/新建会话/首页/Profile）。
2026-10-19 第三轮（视觉对齐 V1/V2）：发现并修复设计令牌级偏差——鸿蒙 LightColors 此前是历史硬编码的 Tailwind 蓝灰系，与安卓暖纸色系完全不同。V1 重写 ColorTokens（明暗逐 token 对齐安卓 Theme.kt：canvas #FDFCFB、primaryAction 黑 #0A0A0B、border #E7E5E0、暗色 border=Transparent 等），新增 TypeTokens/SpacingTokens/RadiusTokens/IconSizeTokens；V2a/V2b 并行逐页清扫字号/字重/行高/间距/圆角/颜色（对照安卓同位置确切值），消除残留硬编码色。已部署验证：背景像素实测 #FDFBFA ≈ #FDFCFB。
2026-10-19 第四轮（品牌字）：安卓 AAWordmark 用 Caveat 手写体（caveat_wght.ttf），鸿蒙此前是系统默认字体。修复：字体复制到 rawfile，Index.aboutToAppear 用 UIContext.getFont().registerFont($rawfile) 注册（注意：EntryAbility.onCreate 里用字符串路径注册不生效；registerFont 为异步接口，需在页面渲染前注册），登录页 42sp/首页顶栏 31sp wordmark 应用 `.fontFamily('Caveat')`（首页顶栏同时从"Sessions"文案改为安卓同款 wordmark）。截图已验证草书字形生效。
2026-10-19 第五轮（首页布局重构 B6）：整体布局结构逐元素对齐安卓 HomeContent/HomeHeader/QuickEntries/QuickEntryCard/FloatingHomeButton（HomeScreen.kt 458–906）+ HomeProjectComponents/HomeProjectSessionRow/HomeLists。已部署截图验证：顶栏（左 42dp 圆形头像钮 + 居中 Caveat wordmark 31sp/40 + 右透明搜索钮）、QuickEntries 三卡（设备/终端/文件，76dp、r18、图标 22 + 14 Bold 标题）、Active/Archived 胶囊 tab（34dp，安卓 HomeTabPill 样式）、分组头（56dp、folder 21 + 16 Bold）、会话行（44dp、robot 16 + 15 Medium 标题 + 状态 pill/未读点）、右下 54dp 黑色 FAB（新建会话入口，替代原 navAction 行）全部就位。
2026-10-20 第六轮（B7 首页项目树 + Profile 抽屉，响应用户反馈"安卓只有项目/不该有全部标已读/项目格式与 Profile 页不对"）：
- **B7a 首页列表重构**：核实安卓首页为纯项目树模式（HomeProjectList，无 tab、无 mark-all-read 行）后，删除 Active/Archived 双 tab、"全部标已读/筛选/选择"按钮行与批量选择 footer；改为"已固定/项目"两个可折叠分区（分区头 44：label 13.2 ExtraBold faint + chevron 16 旋转；"项目"头带过滤 chevron_left + 新建项目 plus）；项目行 56（folder/folder_fill 21 + 16 Bold + more/square_and_pencil 38/19，长按或省略号弹 252×168 r22 操作卡：编辑/置顶/归档）；展开子项（错误重试/18 加载环/"暂无会话"）；会话行 44（agent 图标 16 + 15 Medium + 指示器：等待批准 pill/旋转弧 Circle+strokeDashArray/未读点）；编辑项目 sheet（r28、409 冲突自动改名）、归档确认弹窗（r26）；新建项目页 NewProjectPage（设备/名称/路径 → POST /projects）；锚定过滤菜单 + auth/HomeProjectPreferenceStore 偏好持久化；数据层改 listProjects() 真实项目列表 + per-(project,archived) 30s 会话缓存
- **B7b Profile 抽屉化**：核实安卓为 ProfileSettingsDrawer 左滑入抽屉而非路由页后，删除 pages/ProfilePage.ets 与 `profile` 路由；新增 components/ProfileDrawerOverlay.ets（Header 64 返回+居中标题；IdentityCard 头像/昵称/官方云标签 → Account 详情；外观卡 Moon+下拉三选；语言卡；版本卡+检查更新红点；归档会话卡；SignOutCard 红字；Account/Language/Updates 抽屉内详情子页；昵称/邮箱/改密/退出弹窗 r26 风格；TransitionEffect.move(START) 240ms）；新增 pages/ArchivedSessionsPage.ets（路由 `archived_sessions`，项目选择器 + 分组归档列表 + 单条/整项目恢复，对齐 ArchivedSessionsScreen）
- 修复编译坑：ArkUI 无 `Arc` 组件（用 Circle+strokeDashArray 画 100° 弧）、`FontWeight.ExtraBold` 不存在（用 800）、SymbolGlyph 无 `.textAlign`
- 部署截图验证：首页无 tab/无标已读行、"项目"分区头+过滤/加号、项目树行、FAB 就位；Profile 抽屉（返回+设置标题、身份卡 Bob/官方服务、外观/语言/版本 v2.1.0/检查更新/已归档会话/红色退出）全部生效
2026-10-20 第七轮（会话 agent 图标 + 折叠空态修复，响应用户反馈）：
- **会话 agent 品牌图标**：移植安卓 `ic_session_agent_{codex,claude,deepseek}.xml`（单 path 矢量）为 `resources/base/media/session_agent_*.svg`（viewport 100/125/50，`Image.fillColor` 着色 faint，仅对 SVG 生效）；新增 `components/SessionAgentIcon.ets`（`sessionAgentIconKind()` 复刻安卓 SessionAgentIcon 匹配：strip 空白/_/- 后 codex→Codex、claude/claudecode→Claude、dsh/deepseek/deepseekharness→DeepSeek，否则 sys.symbol robot 兜底；16vp；注意 V1 @Component 禁 getter，改为 build 内直接调函数）；首页会话行替换原统一 robot 图标。当前账号连接器仅 DSH runtime，全部会话显示 DeepSeek 鲸鱼图标，与安卓一致
- **修复折叠"项目"分区误显空态**（用户报告：点击项目按钮列表变空；安卓正确行为为收拢项目行、分区头保留）：根因 `treeHasContent()` 只认 project/session 行，折叠后 treeRows 仅剩 projects_header → 误判走"还没有活跃项目"空态。修复：对齐安卓 `HomeProjectList` 空态条件 `projects.isEmpty() && pinnedSessions.isEmpty()`（与折叠状态无关），`rebuildProjectTree()` 计算 `@State treeHasAnyContent`（visibleProjects 或过滤后 pinnedSessions 非空），折叠时仅隐藏分区内容、分区头照常渲染
- 验证：模拟器部署实测折叠（只剩"项目 >"头，无空态误显）↔ 展开（Mihu/Agents-Anywhere/11 三项目 + 会话行 + 鲸鱼图标）往返正常
- **修复折叠后分区头掉到屏幕底部**（用户报告：点击"项目"后项目跑到下面）：根因列表区宿主 `Stack({ alignContent: BottomEnd })`（FAB 定位用）内的 Refresh/List/加载/错误/空态分支用了 `layoutWeight(1)`——`layoutWeight` 仅在 Row/Column/Flex 内生效，Stack 内被忽略 → 子组件按内容高、短内容被 Stack 底部对齐推到屏幕底。修复：各分支改 `height('100%')`（Stack 内百分比有效）；ErrorState/EmptyState 包一层 `Column().height('100%').justifyContent(Center)`（`.justifyContent` 非通用属性，不能链在自定义组件上，编译报错实测）；折叠时"项目 >"头保持在快速入口下方（y≈703），不再掉底
- 沉淀规则：**Stack 子组件禁用 `layoutWeight`**（静默失效），需要撑满用 `height('100%')`；自定义组件只能链通用属性，布局属性（justifyContent 等）须由外层容器承担
2026-10-20 第八轮（外观菜单修复 + 侧边栏显示）：
- **修复 Profile 抽屉"外观"点击无反应**（用户报告：点击外观行无任何反应）：根因是单位混用——`getComponentUtils().getRectangleById()` 返回 **px**（约等于绝对屏幕坐标），而菜单 `position()` 按 **vp** 解释，未换算导致菜单弹到屏幕外底部（dumpLayout origBounds [237,2754][1238,3320]，仅 78px 露出屏底）。修复：`ProfileDrawerOverlay.openAppearanceMenu`、`HomePage.anchorFromRect`、`ArchivedSessionsPage.openPicker` 三处全部经 `getUIContext().px2vp()` 换算，并保留 fallback 锚点 + hilog.warn 兜底
- **第二个坑（坐标基准不一致）**：page-root 级 id（home_root）的测量返回 (0,0) 基准，而页内组件返回绝对屏幕坐标，直接相减恒差 137px（状态栏高）。修复：首页/归档页根 Stack 内加零尺寸 origin marker（`home_anchor_origin`/`archived_anchor_origin`，必须 `.position({x:0,y:0})` 钉原点，否则 Stack 默认 alignContent Center 会居中到 (640,1435)），锚点计算改为 marker 基准
- **侧边栏显示（B8，对齐安卓 HomeSidebarViewMode/SidebarViewPopup/HomeList）**：Profile 抽屉语言卡后新增"侧边栏显示"卡（list_bullet 图标 + trailing 当前视图 + 下拉弹层：项目视图 folder/会话视图 list_bullet，286 宽弹层锚定行下方含 px2vp 换算）；新增 `auth/SidebarViewModeStore.ets` 全局持久化（AppStorage `appSidebarViewMode` + preferences，normalize 仿安卓，EntryAbility 初始化）；首页消费：Project 模式维持项目树，Session 模式渲染平铺会话列表（置顶/最近可折叠分区 + 分区空文案 + 66 高会话行：agent 品牌图标 + 16 Bold 标题 + 11.2 "设备 · 项目"上下文标签 + 状态指示器，对齐安卓 HomeSessionRow/sidebarContextLabel；保持服务器顺序仅按 pinned 拆分）；会话视图空态改 home_no_sessions + 新建会话按钮；模式切换经 `@StorageProp + @Watch` 即时重渲染
- 验证：模拟器实测外观菜单锚定正确（三选项紧随行下）+ 深色/浅色切换生效；侧边栏弹层（菜单 y 1360 = 行底 1346 + 4vp）；会话视图分区渲染（"工作笔记本 · Mihu"上下文标签）、置顶分区折叠/展开往返、重启后偏好保持、切回项目视图恢复项目树
- 沉淀规则：**`getRectangleById` 返回 px、`position()` 接收 vp，必须 px2vp 换算**；**page-root 级 id 与页内组件坐标基准不一致，锚点测量须用页内零尺寸 marker 校准**；应用 JS hilog 不进 `hilog -x` 捕获缓冲（连 EntryAbility testTag 都不在），日志排查无效，测量类调试优先"界面 debug Text + dumpLayout origBounds"
2026-10-20 第九轮（会话详情页气泡格式对齐安卓）：
- **用户气泡颜色修正**：backgroundColor 从 `primaryAction`（黑/白按钮色，导致黑底白字反色气泡）改为 `sessionMessageBubble`（亮 #F1F0ED / 暗 #2A2A2A，对齐安卓 SessionMessages user bubble 色）；文字/md 链接/行内代码色从 `onPrimaryAction/mdLinkOnPrimary/mdInlineOnPrimary/mdCodeOnPrimary`（白底对比色）改为 `sessionMessageText/mdLinkOnPrimary/mdInlineOnSurface/mdCodeOnSurface`（浅纸底对比色）
- **助手消息移除气泡卡片**：原实现套 borderRadius(12)+backgroundColor 卡片包装，对齐安卓 AgentMessageContent 裸 markdown（无背景卡片，仅 padding(horizontal=4.dp)）；移除 borderRadius/backgroundColor，padding 12,8→4 left/right only
- **消息列表间距**：List space 4→16vp（对齐安卓 verticalSpacing=16dp）；水平 padding 8→20vp（对齐安卓 horizontalPadding=20dp）
- **Notice 卡片严重级别着色**：原实现固定 warningSurface/warningBorder，对齐安卓按 severity 动态着色——error 用 errorSurface/errorBorder、success 用 successSurface/successBorder、warning 保留 warningSurface/warningBorder；新增 ColorTokens `successBorder`（亮 #5216A34A / 暗 #5222C55E，32% alpha 成功强调色边框，对齐安卓边框 alpha 模式）
2026-10-20 第十轮（输入区重构，响应用户反馈"输入框位置、下面两个按钮"）：
- **Composer 卡片化（对齐安卓 MessageComposer/ComposerActions）**：删除散落的 ＋ 按钮/独立 TextArea/全宽接管开关行/底部"Agent files"+"Share"按钮行；改为单张圆角卡片（r22，亮 #F2FFFFFF/暗 raisedSurface 底 + 亮 #EFEDE9/暗 border 边框，padding 16/16/16/12，水平 margin 14）：内含待发附件 chips → 透明 TextArea（16sp/500，minHeight 28/maxHeight 92，placeholder muted）→ 34 高操作行（SpaceBetween：左 [＋30 圆钮 + 接管胶囊(自定义 30×18 开关 + 12sp 标签，点击弹确认)]，右 [34 圆形主操作钮——发送态黑底 arrow_up（有内容才点亮 #2B2B2B/#FAFAFA，空态 #E2E0DC/#3F3F46）/中断态红底 #EF4444 白方块/busy LoadingProgress]）
- **附件来源菜单弹层**：＋ 按钮改为弹 270 宽菜单（相机/照片/文件/链接上传四行，42 圆图标钮 + 16sp SemiBold 标签，对齐安卓 AttachmentSourceMenu）；"链接上传"展开卡片内 URL 输入行（TextInput + Add + ✕ 关闭）
- **Agent files / Share 移入标题栏**：删除底部双按钮行，改 NavDestination `.menus()` 自定义 Builder（folder → session_agent_files 路由、share → shareSession），功能不丢失
- 新增 12 个 composer 配色辅助方法（themeIsDark 分支取安卓 SessionComposer.kt 逐值）；三份 string.json 补 session_attachment_photos/file/url
- 注意坑：`.alignSelf()` 参数是 `ItemAlign` 而非 `HorizontalAlign`（Column/Flex 子组件对齐）
- **修复输入框无法输入（能力集解析 bug）**：`GET /sessions/{id}/runtime/capabilities` 返回 `ProtocolCapabilitiesResponse = {connectorId, capabilitySet: {revision, capabilities}, serverTime}`，安卓先解包 `capabilitySet` 再解析；鸿蒙原实现把顶层响应直接喂给 `parseRemoteRuntimeCapabilitySet`（在顶层找 `capabilities` 数组→恒空）→ 解析出**空能力集**（非 null）→ `sendInputAllowed()` 恒 false → 输入框被禁用且 ＋/接管等能力门控全部失效。修复：SessionsApi 先 `objGetRecord(response, 'capabilitySet')` 解包再解析（SessionsApi.ets）。模拟器实测：TextArea enabled:true → 点击聚焦键盘弹出 → `uitest uiInput inputText` 输入 "HelloTest123" 成功出现在输入框
2026-10-20 第十二轮（接管门控对齐，响应用户反馈"我还是点不动"）：
- **根因**：服务端 `allowed = runtime_allowed and session.takeover`（effective_capabilities.py platform_scoped_session_capability）——会话未开"接管"时 `session.send_message.allowed=false`，输入框禁用是**设计行为**；但鸿蒙缺安卓的只读引导，用户以为坏了。注：用户此前"点不动"的另一会话实为接管未开（区别于第十一轮的能力解析 bug，那个会话用户曾开过接管）
- **只读输入框双击引导（对齐安卓 handleReadOnlyComposerClick）**：输入被禁用时连点两下 composer 卡片（卡片 `.onClick` + disabled TextArea 点击穿透父级）：连接器离线 → 弹"设备已离线"单按钮弹窗（ConfirmDialog 新增 `showCancel: false` 单按钮模式）；在线且未开接管 → 直接弹"开启接管"确认框；`takeoverBusy` 防重入、`readOnlyComposerTapCount` 计数器与安卓一致
- **输入门控补齐安卓 sessionComposerEnabled 语义**：`sendInputAllowed()` 由"能力 usable 即可"改为 `takeoverOn && capabilities !== null && (send/commands/execute usable)`——修复进入页面时能力未加载（null→放行）导致的"先可用后禁用"竞态；`syncSessionMeta` 同步 `takeoverOn`（原来只在 loadRuntimeState/setTakeover 同步）
- **接管切换后显式刷新能力**：鸿蒙无安卓 `applyCapabilitiesObservation` 实时能力推送通道，`setTakeover` 成功后追加 `loadRuntimeState()` 重取能力，否则开启接管后输入框仍禁用
- 新增字符串：common_ok / session_device_offline_title / session_device_offline_body（中/英）
- 模拟器全流程实测：胶囊关闭接管 → 输入框 0.4s 内禁用 → 双击禁用输入区 → 弹"开启接管" → 确认 → 输入框恢复 enabled → `uitest uiInput inputText` 注入 "FinalCheck456" 成功
2026-10-20 第十三轮（system 项样式 + 气泡宽度逃逸修复，响应用户反馈"system是什么哦"+"我发的消息气泡没有包住"）：
- **system/marker/error/diagnostic 项对齐安卓 ToolPlaceholder**（SessionMessages.kt 2200）：原来非消息项渲染成卡片 + 裸 `type` 文字 chip（用户看到"system"不知何物）；现改为无卡片行样式：16vp Clock/CircleAlert 图标（destructive=status failed/cancelled/interrupted 或 type=error 时用 exclamationmark_circle + errorIcon 色）+ 13sp Bold displayText（`text.ifBlank{type}`，muted 色）+ status 胶囊（仅 marker/error/system 显示：11sp Bold、minWidth 40/高 20、r10，中性 sessionStatusNeutralSurface/Text 或 destructive errorSurface/errorText）；diagnostic 不显示胶囊（对齐安卓 kind 集合）
- **用户消息气泡文字溢出修复**：根因——气泡 `constraintSize({maxWidth:'78%'})` 的百分比会污染后代百分比解析基准，内部 markdown `width('100%')` 按 0.78×窗口（1280px）而非行内容（986px）解析 → 段落 Text 单行 822px 不换行、溢出气泡右缘（实测"你检查一下我现在的会话历史有多少"文本 [458,1454][1280,1602] 顶到屏幕边缘）。修复策略（绝对值化）：`aboutToAppear` 用 `display.getDefaultDisplaySync()`（px/densityPixels 换算 vp）计算 `userBubbleMaxVp=floor((winVp-84)*0.78)`、`userContentMaxVp=bubble-34`、`assistantBubbleMaxVp=floor((winVp-84)*0.85)`、`assistantContentMaxVp=bubble-8`（84=列表 40 + 行 padding 44）；气泡 constraintSize 改绝对 vp
- **AgentMarkdownView/MdCodePanelView/DiffCodeView 全链宽度钳制**：新增 `@Prop contentMaxWidthVp: number = -1` + `contentWidthCap()`（>0 用之，否则 100000 no-op，未传 cap 的调用点零回归）；hug 节点（段落/heading/根 Column）以 `constraintSize({maxWidth: cap})` 替换 `width('100%')`（短消息仍 hug，无百分号即无逃逸）；stretch 节点（quote/table/tableRow/Divider/listItem Row/代码面板根与内层）保留 `width('100%')` + 追加绝对 constraintSize cap；嵌套 AgentMarkdownView/MdCodePanelView/DiffCodeView 逐层透传 cap
- 已知残留：compact 分隔符（安卓 CompactTimelineSeparator，"Compacting context"等文案）未实现——鸿蒙 RemoteTimelineItem DTO 无 contentKind/title/rawContent 字段，服务端有但未解析，待后续补 DTO
- 模拟器实测：同一消息文本 [473,1252][1109,1400]（636px 两行）完整包在气泡 [414,1207][1168,1445] 内，右缘留白 59px=17vp 精确；5 个 system 项全部渲染为 Clock+文字+"done"胶囊行（胶囊 #FFE4E2DD/149×70px），无裸 type chip；助手 markdown（列表/粗体/行内代码）全部在 85% cap=837px 内
2026-10-20 第十四轮（设备列表/详情双页重构，响应用户反馈"设备详情页面还是没和安卓对齐"）：
- **根因**：鸿蒙此前根本没有独立设备详情页——DevicesPage 列表卡片内嵌展开式详情（expandedId），而安卓是列表行点击 → `DeviceDetailScreen` 独立路由（1305 行）。逐行对齐安卓 DevicesScreen/DeviceDetailScreen/DeviceActionsSheet/DeviceConfirmDialog/DeviceDetailControls/DeviceRuntimeState/DeviceAgentPreviewState/SessionMappers 后重写双页：
- **DevicesPage 重写为纯列表页**（对齐 DevicesScreen.kt）：AddDeviceRow（60vp r15 卡片、42×42 r12 图标盒 + plus + chevron → pairing 路由）+ DeviceRow（60vp 卡片：42×42 图标盒按 deviceOs 取 sys.symbol desktop/computer/pc、名称 17sp 600、在线状态标签 checkmark_circle/circle 16 + 13sp Medium 文案、agent 预览 meta 13sp、chevron_right → device_detail 路由）；排序 online desc → createdAt asc → name asc（sortedForDevicesPage）；在线设备 agent 预览计数 = `listDeviceRuntimes` 中 configured+active+status==running 的数量（onlineAgentCount），Loaded 保留/失败 Unavailable/默认 Loading 三态（DeviceAgentPreviewState），plural one/other 区分；列表 loading 保持 LoadingProgress（鸿蒙无 shimmer 惯例）；onShown + shownOnce 守卫静默刷新
- **新增 pages/DeviceDetailPage.ets（路由 device_detail，参数 deviceId）**（对齐 DeviceDetailScreen）：自定义 `.title()` 双行头（设备名 25sp/800 + checkmark_circle/circle + 在线状态色标签）+ `.menus()` 38vp 圆钮；底部 actionsSheetOverlay（r28 面板：handle/标题+关闭、Rename 内联 TextInput+错误+SheetTextButton 44dp r22、Revoke 仅在线显示、Delete 危险色）——对齐 DeviceActionsSheet；AgentsSection（加载环/错误+Retry/配置行：pendingRuntimeId spinner 或 8vp 彩点指示器 + 主次标签（runtimeInstanceLabels 逻辑）+ 10 种 RuntimeStatus 全量本地化 + 自定义 32×20 WebRuntimeSwitch + trash + divider + 桌面端配置提示）；SessionsSection（Select/Cancel + Archive all/Unarchive all MiniTextAction、Active/Archived/All 筛选 tag 34dp r17、SessionBulkBar 全选圈+monospace 计数+主操作、52vp 会话行 + relativeTimeLabel 相对时间 now/Xm/Xh/Yest./Xd/Xw/Xy + divider）；四种确认弹窗（删设备/撤销令牌/删 runtime 配置(含运行中变体文案)/归档全部(按 archived+scope 变体)）复用单 CustomDialogController、open 时按 confirmAction 计算 title/message/label；bulkArchiveSelected/unarchive（archiveSessions/unarchiveSessions + notFound 提示 + toast）、requestArchiveAll（scope active/archived/all）、runConfirmAction（删设备→pop 返回列表）
- **字符串**：三份 string.json 新增 ~64 个 key（devices_add_new/online/offline/agent_status_*、home_tab_active/archived、device_runtime_* 状态标签全套、device_detail_* 区块/批量/toast、device_actions_*、device_confirm_* 四种确认）
- **移除鸿蒙独有内嵌功能**：列表卡片展开、discover/add-runtime/configure/rename/archive-all 内嵌操作全部移除；安卓 UI 本就无 discover/configure 入口（discoverDeviceRuntimes 与 DeviceRuntimeConfigureSheet 在安卓 UI 无调用点、系死代码），strict 对齐后鸿蒙 UI 不再引用（API 与 RuntimeConfigureSheetOverlay 组件保留未删）
- **新坑（实测发现）**：`resourceManager.getStringSync(resource)` **不代入 `$r('app.string.x', args)` 的格式化参数**——预览文案渲染出字面 "%d 个 Agent 在线"（Text/promptAction 渲染 Resource 会正常格式化，仅 getStringSync 路径不格式化）。修复：DevicesPage/DeviceDetailPage 各加 `localizedWithCount()`（模板 `replace('%d', count)`），共修 5 处（agents_online one/other、selected_count、sessions_not_found ×2）
- **图标坑**：`sys.symbol.more` 在鸿蒙是 2×2 四点网格（非安卓 Lucide.Ellipsis 三点省略号），详情页 more 钮改为手绘 Row+3×Circle(4vp, space 3.5) 三点，与安卓视觉一致；`sys.symbol.checkmark_circle` 实测渲染正常（此前未在仓库出现过，风险解除）
- **记录偏差**：确认弹窗为"确认即关 + 异步执行 + 失败 toast/actionError 横幅"（安卓为弹窗内 busy/inline error + 重试），沿用鸿蒙既有 ConfirmDialog 静态弹窗模式；会话相对时间标签（now/m/h/Yest./d/w/y）与安卓一致硬编码不本地化
- 模拟器实测（官方云账号）：设备列表（"1 个 Agent 在线" 预览、离线行"离线"、checkmark_circle/circle 渲染）→ 详情页（AGENT 区 DeepSeek Harness 行 + 运行中 + 开关 + trash、桌面提示、会话区筛选 tag、按筛选变化空文案）→ more 三点钮 → actions sheet（重命名/撤销/删除，删除红字）→ Rename 内联（重命名设备标题/输入框/取消保存）→ 撤销确认（%s 设备名格式化正确）→ 删除确认 → 删 runtime 配置确认（active 变体文案正确）逐项通过；未实测（无数据）：会话行渲染/批量选择/批量归档/全部归档确认（当前账号两台设备均无会话）、runtime 开关切换与实际删除（避免改动用户真实数据）

2026-10-20 第十五轮（详情页头部重构 + 会话空数据修复，响应用户反馈"详情页的UI高度太低了，而且活跃会话没有数据"）：
- **会话空数据根因**：`DEVICE_SESSIONS_LIMIT=200` 超出 Server `/api/v2/sessions` 的 `limit le=100` 校验上限 → 请求返回 422 → catch 静默吞掉 → 活跃会话永远空。修复为 100（与安卓/首页一致，安卓 SessionsController 亦用 limit=100）
- **头部"太挤/太低"根因**：此前用系统 NavDestination 标题栏（`.title()` 双行自定义 builder + `.menus()`），25sp 标题顶到状态栏下缘（y=137 与安全区零间距）、内容在 56vp 系统标题栏内顶部对齐，视觉拥挤——与安卓结构不同。安卓是**内容区内自绘 64dp DeviceDetailHeader**（ScreenScaffold > Column > Header Row + LazyColumn weight(1f)），标题与在线状态**同行**（weight(1f, fill=false) + spacedBy(9)）、38dp RoundIconAction 圆钮（back/more）、垂直居中
- **重构**（`DeviceDetailPage.ets`）：`.hideTitleBar(true)` 弃用系统标题栏；新增 `detailHeader()` builder——Row(64vp, padding h24, space 8, 垂直居中)：38vp 圆钮 chevron_left（`navPathStack.pop()`）+ 标题 25sp/800（`flexShrink(1)` 对齐安卓 weight(1f, fill=false) 收缩省略）与状态标签同行 space 9 + 38vp 圆钮手绘三点 more（开 sheet）；build() 结构改为 Stack > Column{ header; Scroll(layoutWeight(1)) } + sheet overlay
- 模拟器实测：标题块垂直居中（y=197，与状态栏 60px 间距）、标题+状态同行、back 圆钮 pop 返回列表 ✓、more 圆钮（中心约 1130,249）开 sheet（重命名/撤销/删除）✓、活跃会话 8 条渲染（5h 相对时间、divider）✓；未实测：长设备名收缩省略、runtime 开关切换与删除执行（避免改动真实数据）

2026-10-20 第十六轮（会话区按钮全量修复，响应用户反馈"点击已归档页面会下移、选择和全部归档没有效果"）：
- **下移根因**（官方 FAQ faqs-arkui-725）：`Scroll` 设 `layoutWeight` 后内容短于视口时**内容默认居中**（实测 606/606px 对称留白、AGENT 区下移 173vp），点击"已归档"列表塌缩触发。修复：Scroll 加 `.align(Alignment.Top)`
- **按钮失效根因**（ArkUI V1 按值传参冻结）：`@Builder` 按值传入的参数在**首次执行时求值后不再响应状态变化**——选择/全部归档按钮的 `enabled` 参数在 sessions 加载完成前（visibleSessions 为空）被求值为 false 冻结，加载完成后按钮仍 opacity 0.45 且 onClick 被 `if (enabled)` 拦截（实测点击无任何效果）；filterTag 的 `selected` 参数同理冻结（切换筛选高亮不动，"全部"点了看不出效果）。修复：把 miniTextAction/filterTag/selectionCircle 三个带状态派生参数的通用 builder 拆为按用途的专用 builder（selectModeButton/archiveAllButton/bulkActionButton/allSelectionCircle/rowSelectionCircle + filterTag(label, filter)），**状态派生值全部改为 builder 体内直接读取**（直接读取是响应式的，仅参数传递会冻结）；传参只留常量（filter 枚举、行 id）
- 模拟器逐项实测通过：已归档切换（无下移、空文案）✓、全部（合并列表+tag 高亮 #FFECECE9 跟随）✓、活跃 tag 高亮 ✓、选择→批量栏（取消标签/全选圈/已选择 N 个/归档所选）✓、全选→已选择 9 个 ✓、单行点选/取消（圈 #FF181816+勾、计数增减）✓、归档所选→9 条批量归档执行（活跃清空）✓、全部取消归档→确认弹窗（archived scope 文案）→确认执行（已归档清空、9 条恢复活跃，数据已还原）✓、取消退出选择模式 ✓；未实测：长设备名收缩省略、runtime 开关切换与删除执行（避免改动真实数据）

2026-10-21 第十七轮（文件页进入默认态重构，对齐安卓 FilesScreen/DeviceFilesContent）：
- **差距**：鸿蒙文件页为系统标题栏 + Select 设备下拉 + Home(~)/\/Custom 根路径按钮 + Up/刷新行 + Refresh 下拉刷新 + 带副标题行样式，与安卓结构完全不同（安卓：FilesHeader 64dp 自绘头 + 设备胶囊 44dp r14 + DevicePickerMenu 锚定下拉仅在线设备；PathBar 路径胶囊 + 复制钮；LazyColumn 60dp 行 + ".." 行；无根按钮/Up/刷新/下拉刷新）
- **FilesPage.ets 整体重写**：`.hideTitleBar(true)` + 自绘 filesHeader（back 40vp 圆钮 + 常显设备触发器 44vp r14：16sp/600 设备名 + chevron_down 19）；锚定设备下拉（ArchivedSessionsPage 同款 getRectangleById + px2vp 模式，宽 min(286, anchor.width)、maxHeight 328、r18、仅在线设备、checkmark 选中、透明遮罩点击关闭，对齐 AADropdownMenu 无阴影无 scrim）；空态分支：无设备→EmptyState(🖥️ + files_pair_first + home_pair_new_device 钮)/加载中→LoadingProgress/全部离线→files_all_devices_offline 居中；browserContent：pathBar（displayedPath 15sp/800（反斜杠→正斜杠显示，对齐安卓 displayRemotePath；空路径显示 files_windows_drives"这台电脑"）+ 复制钮 52×52→check 1100ms）+ List space 1（loading/error/空目录消息行 13sp/600、".." 行、目录/文件行 60vp：40vp 中性色图标盒 + 15sp/600 名称 + 目录 chevron_right + 按压 flash/shadow onTouch）；移除 Select/StringInputDialog/root 按钮/Up/Refresh
- **进入默认态对齐安卓 initialRemoteFilePath**（响应用户反馈"点击文件应显示所有盘符，而不是用户目录"）：Windows 设备进入路径为 `''`（盘符概览"这台电脑"，connector read_dir 对 win32+path='' 返回 A-Z 存在盘符），非 Windows 为 `'.'`（家目录）；盘符概览无 ".." 行（canGoUp('')=false），点盘符进盘根（路径条显示 `C:/`），盘根 ".." 回概览（isWindowsDriveRootPath→loadDirectory('')），与安卓 remoteParentPath/windowsParentPath(allowDriveOverview) 语义一致；`FileViewSupport` 新增 `isWindowsDeviceOs`/`initialRemoteFilePath`
- **FilesApi.listFiles path 解析 bug 修复**：`objGetOptString` 把空串当 null（要求 `value.length>0`），connector 盘符概览返回的 `path: ""` 被回退成 root（'~'）→ 路径条误显 `~` 且出现多余 ".." 行；改为 `objGetString(resultRecord, 'path', root)` 保真传递显式空串（其余消费方 SessionAgentFilesPage/NewProjectPage/HomePage 均有 `.length>0` 回退守卫，无回归）
- **resolvedRoot 语义**：'~' 起步；Windows 加载后取 `windowsDriveRootOf(currentPath)`（概览 path='' 时不覆盖，保持 '~' 兜底，对齐安卓 windowsDriveRoot('')→null→fallback '~'）；非 Windows 首载（root=='~' 且 path 非空）解析为家目录绝对路径，后续 ".." 可越出 home，与安卓一致
- **图标坑（构建失败）**：`sys.symbol.doc_on_doc` 不存在（restool: Unknown resource name）。合法 symbol 权威清单在 `D:\ProgramFiles\DevEco Studio\sdk\default\openharmony\toolchains\id_defined.json`（record 嵌套数组需展平，`type=='symbol'` 过滤，共 4042 个）。复制图标改用 `doc_text_on_doc_text`
- StateViews.EmptyState 加可选 `actionSymbol` 参数（默认 sys.symbol.plus，不破坏现有调用）；三份 string.json 补 `devices_no_online`（No online devices/暂无在线设备）
- 模拟器实测：进入默认态（自绘头 + 设备胶囊"工作笔记本" + PathBar"这台电脑" + C:/D:/E: 盘符行，**无 ".." 行**——Windows 盘符概览）✓；点 C: → `C:/` 盘根列表 ✓；盘根 ".." → 返回盘符概览 ✓；设备下拉打开（胶囊下方左对齐、单在线设备 + checkmark）→ 点击外部关闭 ✓；点 .claude → 路径/列表更新 ✓；".." 返回上级 ✓；头部 back 圆钮 pop 回首页 ✓
- 未实测：复制按钮 check 切换（模式与详情页复制钮一致，低风险）、长按菜单（FileRowMenuOverlay 本轮保留原样）、非 Windows 设备进入态（当前账号仅 Windows 设备在线；代码路径与安卓一致：initialRemoteFilePath→'.'）

2026-10-21 第十八轮（首页 Agent 门控空态，响应用户反馈"没有连接 agent 时，首页进来还是显示了数据"，**产品决策：有意偏离安卓**）：
- **决策**：用户经确认选择"0 agent 在线显示引导空态"——设备在线但无 Agent 运行时（或全部设备离线）时，首页列表区显示设置引导而非服务端会话树。**安卓行为不同**：HomeProjectModeList（HomeScreen.kt:595）仅在 `devices.isEmpty()` 时显示配对空态，会话树不因 Agent 离线而隐藏；本改动为鸿蒙侧产品决策，**安卓待同步**（跨端差异需产品侧确认后跟进）
- **实现**（`HomePage.ets`）：新增 `@State agentGateState`（checking/ready/no_devices/devices_offline/no_agents）+ `loadAgentGate()`（listDevices → 全离线 → `devices_offline`；在线设备逐个 `listDeviceRuntimes`，`runnableRuntimes`（configured+active+running）计数 0 → `no_agents`；否则 `ready`；seq 防竞态、失败 fail-open 成 `ready` 不阻塞首页）；列表区分支链插入门控分支（loading → error → **gate** → pairPrompt → treeEmpty → tree），checking 期间并入 loading spinner（首进不闪会话树）；`agentGateContent()` builder：🤖/🔌 + 标题 + 描述（复用 new_session_setup_agent / new_session_devices_offline 字符串，**无操作按钮**——用户决策"重新检查按钮没有必要"，刷新依赖下拉刷新/重进/快照联动），头部/QuickEntries/FAB 保留
- **刷新联动**（响应用户反馈"配置了 agent 后页面无法刷新"：门控空态原无任何刷新手段——无按钮、Refresh 只包项目树分支）：aboutToAppear/retryInitialLoad/Refresh.onRefreshing 均重查门控；**门控空态分支本身包进 Refresh**（与 tree 分支同款 `$$this.refreshing` + onRefreshing，下拉即可重查 gate 并在 agent 恢复后切回项目树）；dashboard 快照在**在线设备 id 集合变化**时自动重查（连接器上线/掉线即时响应；Agent runtime 启停不触发快照设备变化，需下拉刷新）
- 遗留规则：`.alignSelf()` 参数是 `ItemAlign` 非 `HorizontalAlign`（build 报错实测）
- 模拟器实测（官方云账号，工作笔记本在线 0 Agent）：首页显示 🤖 + "先配置一个 Agent" + 描述（无项目树/会话数据泄漏，**无重新检查按钮**）✓；头部/三卡/FAB 保留 ✓；FAB → 新建会话面板（内嵌同款引导）开/✕ 关 ✓；设备快捷入口正常跳转 ✓；后台/前台往返门控保持 ✓；**门控空态下拉刷新实测**（用户配置 agent 期间）：下拉触发 onRefreshing → gate 重查（截图捕获"空态+Refresh 指示器"同屏）→ agent 恢复后经快照联动/下拉刷新切回项目树 ✓
- 未实测：`devices_offline` 分支渲染（需将在线设备下线，代码路径与 no_agents 同构）、Agent 恢复在线后树恢复（需真实启动 Agent runtime）；**安卓侧待产品确认后同步**

2026-10-21 第十九轮（FAB 新建会话面板"选项卡无法操作"修复，响应用户反馈）：
- **症状**：新建会话面板中模型/推理/权限 chips 点击后选中态毫无变化（截图字节级相同），用户感知"无法操作"；设备/Agent chips 正常
- **修复 A（重新检查永久卡死）**：`loadNewSessionDevices()`（onRetrySetup 回调）设 `setupState='checking'` 后调 `autoSelectDevice()`，其守卫 `selectedDeviceId.length > 0` 直接 return → 无人把状态从 checking 转出 → 永久卡"正在检查设备"。修复：retry 入口先清空 selectedDeviceId/selectedRuntimeType/selectedRuntimeId/runtimes、runtimesLoading=false、`newSessionRuntimeRequestSeq++`（防在途 catalog 请求回写）。实测：点离线设备 → no_runtimes 引导 → 点"重新检查" → 5 秒内回 ready 设备列表
- **修复 B（模型行点击无效，@Builder 按值参数冻结）**：UI debug 埋点（界面 debug Text，已验证的排查手段——JS hilog 不进捕获缓冲）实测 trace `T[ok:...]M[新模型]` 证明点击链路全通、`newSessionSelectedModelId` 已更新、@Prop catalog 同步正常，但 chips 不重渲染。根因：`optionRow(options, onSelected)` 为**按值传参的 @Builder**，其内部 ForEach 数据源被冻结在首次执行的旧数组——选中态变化后 ForEach 永不 re-diff，chips 视觉死寂。修复：删除 optionRow 中间层，Flex+ForEach 直接内联进 catalogSection（param-less @Builder 读 `this.catalog`，随 @Prop 同步 re-render；key `${id}:${selected}` 变化触发 item 重建），模型/推理/权限三行同修
- 沉淀规则（升级既有冻结规则）：**按值 @Builder 参数冻结不只影响"状态派生值"——数组型参数会连带冻结 ForEach 数据源**；含 ForEach 的行渲染必须内联到读取 @Prop/@State 的 param-less builder 中，禁止"传数组进子 @Builder"的中间层模式
- 模拟器实测（官方云账号，DSH runtime 全模型目录）：Gemma 3 4B IT 点击 → 黑底选中 + Gemma 3 12B IT 变灰 ✓；再点 Kimi K3 → 选中转移 ✓（其间误点 Muse Glimmer 30B 亦正确切换并验证多次切换稳定）；"重新检查"修复复验 ✓；关闭面板无副作用 ✓
- 未实测：推理 effort 行与权限行点击（修复模式与模型行同构，当前账号模型无 reasoningItems）；Android 侧对应行为为标准 Compose 状态渲染，无此坑

2026-10-21 第二十轮（新建会话目录浏览器从盘符起步 + 两处文件视图隐藏项过滤，响应用户反馈）：
- **需求**：① FAB 新建会话"选择目录"浏览器在 Windows 设备上应从盘符概览起步（原固定 root '~' + path '.' 家目录起步，看不到盘符）；② 浏览器与首页文件页均不显示隐藏文件夹（用户产品决策）
- **隐藏过滤为鸿蒙侧首创**（`FileViewSupport.isHiddenFileEntryName`）：connector `read_dir` 返回全部条目（payload 无 hidden 标志），Android/web/desktop 均无隐藏过滤先例。规则：`.` 前缀全平台恒隐藏；`$` 前缀与 Windows 黑名单（appdata/system volume information/pagefile.sys/desktop.ini/recovery 等 22 项小写匹配）仅 Windows 设备生效（避免误伤 mac/linux 合法目录如 recovery/recent/templates）
- **浏览器 Windows 起步**（`HomePage.ets`）：`newSessionBrowserRoot` 字段 + OS 感知起始路径（`initialRemoteFilePath(deviceOs)`：Windows→'' 盘符概览，其他→'.' 家目录）；`loadNewSessionBrowserDirectory` 对齐 FilesPage 第十七轮语义（drive-style path 补 `\\` + `windowsDriveRootOf` 作 requestRoot，成功后回写 root）；`goNewSessionBrowserUp` 加 Windows 分支（drive root→`load('')` 回概览、drive-style→`windowsParentPath`）；canGoUp 对 drive-style 恒 true、空路径恒 false；retry 改重载 `lastRequestPath`（新字段，请求时记录——概览重试不再错去家目录）；resetNewSessionBrowserState 重置 root/lastRequestPath
- **浏览器 UI**（`NewSessionSheetOverlay.ets`）：空路径标题显示"这台电脑"（复用 files_windows_drives）；"使用此目录"按钮 enabled 加 `path.length > 0`（盘符概览可浏览不可选用，现有 useDirectory 空路径守卫的 UI 侧补全）；路径 Text 三元混用 string/Resource 编译通过
- **文件页过滤**（`FilesPage.ets`）：`filterHiddenEntries` + `selectedDeviceIsWindows`（遍历 devices 匹配 deviceId），`loadDirectory` 改 `sortEntries(filterHiddenEntries(...))`
- 浏览器列表 List 懒加载：dump 只含可视区条目（220 高度约束约 3 行），与文件页数据源一致性需按排序前缀比对（a1cc/acc8/inetpub/PerfLogs/... 顺序两处一致）
- 模拟器实测（官方云账号，工作笔记本在线）：FAB → 选择目录 → "这台电脑"+C:/D:/E: ✓；概览态"向上"禁用 ✓、"使用此目录"禁用 ✓；进 C:\ 路径显示 `C:\`、无隐藏项 ✓；C:\ 下"使用此目录"启用 → 点击 cwd 写入 `C:\` 且浏览器关闭 ✓；"向上"C:\→盘符概览 ✓；文件页 C:\ 完整列表无 $RECYCLE.BIN/System Volume Information（connector 端无过滤 → 客户端过滤实证生效）、PerfLogs/Program Files/Users 等正常目录无误伤 ✓
- 未实测：D:/E: 盘内容、非 Windows 设备浏览器起步（当前账号仅 Windows 设备在线，代码路径 '.' 与原行为一致）、Windows 黑名单逐项（实测环境仅触发 $RECYCLE.BIN/System Volume Information 缺席这一强证据）；**Android 侧隐藏过滤待产品确认后同步**

2026-10-21 第二十一轮（会话时间线工具行重设计，对齐 web 端手机版 session-detail）：
- **基准**：`web-next/src/components/session-detail.tsx`（groupTimelineItems/ToolRunGroup/运行指示）+ `session/session-tool-cards.tsx`（timelineToolTitle/ToolDetailPanel/CodePanel）+ `messages/en.json`/`zh-CN.json` 工具文案模板；鸿蒙侧数据层扩展 `RemoteTimelineItem` 9 字段（command/output/toolName/targetPath/query/description/action/changes 等，均 `string|null` 或 `RemoteTimelineFileChange[]`）+ 解析助手
- **弱化单行 + 人性化摘要**（`common/TimelineSummaries.ets` 纯函数层）：timelineToolRowTitle 按 kind 套模板（command→"执行了 %1$s"、file_change/artifact→"创建了/修改了 文件名"、web_search→"搜索了 %1$s"、reasoning→"推理"），output 在有 changes 时折叠（对齐 web ToolCard displayOutput）；fileChangeActionOf 归一 created/deleted/renamed/modified/changed；displayPathFor 剥 cwd 前缀；组件层 `TimelineToolEntry.ets`（Row：hasDetail 才显 chevron 旋转 -90/0、kind 图标映射 keyboard/doc_text/magnifyingglass/lightbulb/gearshape、failed 红字 + exclamationmark_circle、running LoadingProgress(12)）+ `TimelineToolPanel.ets`（命令/输出双面板 canvas 底 r12、复制钮 pasteboard+toast、输出 Scroll maxHeight 260、diff Scroll maxHeight 300 复用 DiffCodeView、fileChangeRow 行内 builder）
- **连续归组**（`TimelineToolGroupEntry.ets` + SessionDetailPage rebuildEntries）：连续 toolRun ≥2 归组，组行 line_3_horizontal 图标 + 摘要（"推理了 N 次, 执行了 M 次工具"）+ running spinner，点击原地展开成员 ForEach→TimelineToolEntry（key=member.rowKey）；SessionSection 架构（kind/entry/entryKey/toolRow/group 三分支渲染）替换原 entries 数组；组 key 不含 revision（成员 revision 变化仅重建行、组壳稳定）
- **配套**：notices 从 List 移到 composer 上方钉住（首条全卡 + "还有 N 个待处理通知" pill）；建议浮层与附件面板补 `.shadow()`；interrupt 按钮 borderRadius 17→12（红色圆角方块）；canInterrupt 时列表底部"正在运行…"行；三份 string.json 补 23 个 session_tool_* key（中英双语，手动 `.replace('%1$s', x)` 格式代入）
- **新坑（实测发现）**：`Text.copyOption(CopyOptions.LocalDevice)` 会**吞掉点击事件**——父级 Row 的 onClick 在点击文本区域时不触发（点 chevron/图标正常，点标题文字无效，dump 无变化无报错）。TimelineToolEntry 标题移除 copyOption 后整行可点（展开面板内保留复制按钮兜底）；沉淀规则：**可点击行内的 Text 禁用 copyOption**
- **消息宽度修复（响应用户反馈"右边没有对好，有一块留白"）**：第十三轮引入的 `assistantBubbleMaxVp = rowContentVp * 0.85` 是鸿蒙侧臆造上限——安卓 AgentMarkdownText 是 `fillMaxWidth` 无分数上限，实测助手内容右缘被钳在 935px（列表内容右缘 1210px），右侧留出 ~275px 空白块。修复：宽度基准改为 `listContentVp = winVp - 40`（仅列表 20vp×2 padding，对齐安卓 LazyColumn horizontal=20dp），助手气泡上限 = 全列表内容宽（安卓 fillMaxWidth 语义），用户气泡 = 78%×listContentVp（安卓 BoxWithConstraints maxWidth×0.78f 语义）；消息行移除额外 left 12/right 32 行内边距（安卓行无额外水平 padding）。实测：助手内容 [84..1194]（原 [126..935]）、用户气泡右缘 1210px = 列表内容右缘（原 1168），与安卓一致
- 模拟器实测（官方云账号，历史 DSH 会话，设备离线）：组摘要行（"推理了 2 次, 执行了 3 次工具"）✓、无 type 徽章 ✓、组点击原地展开成员弱行 ✓、工具行点击标题文字原地展开 TimelineToolPanel（命令/输出面板 + 复制钮 + "已复制" toast）✓、reasoning 行展开全文 ✓、附件面板浮层（多模态确认：白色圆角卡片 + 轻微阴影覆盖内容之上）✓
- 未实测（需活跃运行/待审批数据，当前设备离线）：running spinner、"正在运行…"行、审批 notice 钉 composer、建议浮层（takeover 确认框拦截输入未触发）、红色圆角方块停止按钮（需 canInterrupt）；以上均为代码完成 + 构建验证状态

2026-10-21 第二十二轮（上游 50 轮版本对比后选择性移植：工具链 / 即时重连 / 草稿持久化）：
- **背景**：与 `Agents-Anywhere-main`（上游另一条 50 轮演化的鸿蒙实现，工程位于 harmony/ 根，API 12+ 兼容）逐项对比。经代码级核实，我方功能完整度不落下风（WebSocket 实时通道、ScanKit 扫码登录、原生终端渲染、深色跟随系统等此前误判为缺失的能力均已在库），仅四项值得吸收：质量门禁工具链、网络恢复即时重连、composer 草稿持久化、实测坑位方法论。深色模式跟随系统经核实已实现（AppearanceSettings + APP_MODE_KEY 三态 + onConfigurationUpdate），未重复开发
- **1. 质量门禁工具链**（`tools/`，自上游移植并适配）：`verify-resource-usage.mjs`（全部 `$r('app.*')` 引用对 base/en/zh_CN 三表校验，比上游多校验 en 表以匹配本工程三语同步约定；实测抓出 LanguageSettings 注释中示例引用误报 1 处后改注释措辞）；`verify-encoding.mjs`（BOM/替换符/mojibake 扫描，exitCode 化）；`verify-reachability.mjs`（升级版：sourceMaps 编译集 + 相对 import 图 BFS 双信号，纯类型模块不再误报；实测抓出真孤儿 `components/RuntimeConfigureSheetOverlay.ets`（仅自引用，初始导入遗留）已删除，注释示例 `$r('app.string.xxx')` 同步修复）；`device-smoke.ps1`（hdc 冒烟助手：Get-Ui/Find-Ui/Click-Row/Shot，适配本机模拟器与 hdc 路径）。三门禁当前全绿：81 ETS / 542 资源引用 / 97 文本文件
- **2. 网络恢复即时重连**（`common/NetworkMonitor.ets`）：NetConnection `netAvailable` 事件监听（module.json5 新增 `ohos.permission.GET_NETWORK_INFO`），接入三个实时页面——SessionDetailPage（取消退避计时器 + realtimeRetries 归零 + 立即 connectRealtime）、HomePage（dashboard 同策略）、TerminalPage（exited/connected 守卫 + connectStream）；各页面 aboutToDisappear 停止监听防泄漏
- **3. Composer 草稿持久化**（`feature/ComposerDraftStore.ets`，对齐安卓 SessionComposerDraftStore 语义）：preferences 落盘，按 sessionId 存 JSON（text + 已上传 attachments，复用 parseRemoteUploadedAttachment 校验解码）；onChange/附件增删/发送失败恢复时保存，发送或命令执行成功后清除，onReady 进入会话时恢复——杀进程或离开会话不丢未发送内容
- **4. 坑位方法论留档**（上游 handoff-48/49/50 提炼，见下节"实测坑位方法论"）
- 未移植（有意）：API 12+ 兼容降级（需逐 API 审计，工作量大，单独立项）、上游 xterm.js 终端方案（我方原生渲染更轻）、上游 764 keys 文案表（范围不同）、OAuth deep link（已有扫码轮询）

2026-10-21 第二十三轮（老版本适配 review + 修复：motion 静态导入崩溃 / DETECT_GESTURE 安装风险）：
- **背景**：用户自行完成 API 12+ 适配（compatibleSdkVersion 26.0.0 → 5.0.0(12)，PATCH 降级 POST + `X-HTTP-Method-Override`（Server 中间件 `http_method_override.py` 配套），AGENTS/HANDOFF 文档同步），本轮对改动做代码 review + 独立复核
- **复核通过**：clean 全量构建（33 任务 59s）SUCCESSFUL；ApiClient.patchJson 运行时探测实现正确（无 as、union 类型 + undefined 判断，降级才发 override 头）；独立解析全部 @since>12 编译告警与审计结论一致——`fill`/`stroke` 确为 `Circle().fill(ResourceColor)` 类旧重载误报（API 7 即有）、PATCH 已处理；Server 中间件 ASGI 模式正确（仅 POST 可改写、白名单 PATCH/PUT/DELETE），本机 uv git 依赖网络失败 pytest 未跑仅代码走查；其余声明权限（INTERNET/GET_NETWORK_INFO/KEEP_BACKGROUND_RUNNING/VIBRATE）均 @since 7-9 安全
- **审计漏洞 1（已修复）**：`@ohos.multimodalAwareness.motion` 模块整体 **@since 15**，HomePage 静态 `import { motion } from '@kit.MultimodalAwarenessKit'` 在 API 12 上页面模块加载即崩（requireNapi 失败，canIUse 守卫来不及执行）——原审计"canIUse 守卫自动禁用"结论仅对**调用**成立，对 **import 本身**不成立
- **审计漏洞 2（已修复）**：`ohos.permission.DETECT_GESTURE` **@since 20**（permissions.d.ts 证实），API 12 设备不认识该权限，安装高概率报 "install failed due to grant request permissions failed"；权限声明无法按设备条件声明，单 HAP 无解。上游 API 12+ 版本无此权限/功能，无"可装"先例
- **修复方案（用户选定共存方案）**：HomePage 智感握姿改订阅 `operatingHandChanged`（@since 15，语义"操作手"，对 FAB 靠近拇指更贴切），权限换 `ohos.permission.ACTIVITY_MOTION`（**@since 7**，API 12 完全认识；user_grant → aboutToAppear 内 `abilityAccessCtrl.requestPermissionsFromUser` 运行时弹窗，拒绝/不支持则 FAB 保持右侧静默降级），motion 改 canIUse 守卫内**动态 `await import('@kit.MultimodalAwarenessKit')`**（API 12 永不加载该模块）；`gesture_detection_reason` key 三语表更名 `operating_hand_reason`。附带收益：功能覆盖从 API 20+ 扩到 15+
- **验证**：arkts_check HomePage 0 错；devecocli build SUCCESSFUL（HomePage 全部 motion @since 15/20 告警消失，动态 import 编译器接受）；三门禁全绿（81 ETS / 542 引用 / 97 文件）。**未实测**：模拟器离线，ACTIVITY_MOTION 弹窗与 FAB 跟手行为待设备在线冒烟；API 12 真机未验证（无设备）
- **模拟器在线后实测追记**（Mate 80 127.0.0.1:5555，API 26）：① ACTIVITY_MOTION 弹窗正常弹出并授权（ATM 日志 result: [0]）✓；② **抓到运行时 bug：`await import('@kit.MultimodalAwarenessKit')` 编译通过但运行时解析为空模块**（kit 是编译期 shim 无运行时实体），`kit.motion` 为 undefined → 改 `await import('@ohos.multimodalAwareness.motion')` + `.default` 链式访问（命名空间赋中间变量会触发 arkts-no-ns-as-obj 编译错，须直接链式）；③ 修复后模拟器上 `motion.on('operatingHandChanged')` 返回 801（"The device does not support this API"，模拟器无多模态感知服务）→ catch 接住、FAB 保持右侧，**降级路径实测符合设计**；④ 复盘 6 小时前用户手测留下的 jscrash 发现**另一个真 bug**：模拟器无摄像头时 `cameraPicker.pick` 返回 undefined（syscap stub）而非 Promise，`.then` 崩页——已加 `Promise | undefined` 守卫（同 PATCH 模式），无新增 jscrash；⑤ FAB 跟手 happy path 需真机（有感知服务+摄像头）才能全验

2026-10-23 第二十四轮（三门禁工具全模块化修复，修复"门禁只扫 entry"盲区）：
- **盲区**：第二十二轮从上游移植的三门禁沿用了上游单模块工程的硬编码路径——`verify-resource-usage.mjs`/`verify-reachability.mjs` 只扫 `entry/src/main`，`verify-encoding.mjs` 只扫 entry/AppScope/tools。实测覆盖仅 8/81 ETS、134/548 资源引用、24/128 文本文件，session（40 ETS/378 引用）等五个模块完全不受门禁保护，形成虚假保障
- **修复**（三工具均改为六模块感知）：① `verify-resource-usage.mjs` 逐模块扫描 `$r('app.*')` 并按模块类型解析——HAP/HSP（entry/session/terminal/files）校验本模块资源表，HAR（common/network，静态合并进消费方）校验全模块并集；② `verify-encoding.mjs` 根目录扩为六模块 src/main + 模块根 Index.ets + AppScope/docs/tools/hvigor + 根级构建文件，缺失路径（如 entry 无根 Index.ets）跳过不报错；③ `verify-reachability.mjs` 改为跨模块可达性——源 id `<module>:<相对模块根路径>`，`from 'bare-module'` 边解析到模块根 Index.ets（useNormalizedOHMUrl 语义），roots 取全部模块 loader_out sourceMaps.map 并集（HAR 代码出现在消费方 HSP/HAP 的 map 中，common/network 无自己的 map 也被覆盖），无构建时回退 main_pages.json + router_map.json + 模块根 Index
- **注意坑（map 路径基准）**：sourceMaps.map 中的路径是 `src/main/ets` 相对（如 `entry/components/X`），而源 id 以模块根为基准（`entry:src/main/ets/components/X`）——直接拼接会错位，导致 entry 全部 8 文件误报 unreachable；roots 须补 `src/main/ets/` 前缀
- **验证**：三门禁全绿（548 引用/81 ETS、128 文本文件、86 ETS roots=87 unreachable=0，86=81 src + 5 模块根 Index）；**负向实测**：植入临时孤儿文件 + 未声明资源引用 → reachability 与 resource-usage 均正确报告且 exitCode=1，移除后恢复全绿；`devecocli build` BUILD SUCCESSFUL 无回归。当前全模块恰好无真实违例（盲区未造成实际损害），但后续 session 等模块改动已纳入兜底

### 实测坑位方法论（源自上游 handoff-48/49/50，与本轮实测经验合并）

1. **`uitest dumpLayout` 不可靠地包含 bindMenu/Sheet 弹出的浮层内容**（浮层在独立窗口）——dump 里找不到菜单项 ≠ 菜单没开，浮层判断要看截图
2. **息屏 = 应用冻结 = 伪影**：测"随时间发生的事"（重连、轮询）前先 `power-shell timeout -o 1800000` 顶掉息屏超时 + `power-shell wakeup`，否则 26 秒后应用冻结、日志消失，会被误判为疯狂重连；收尾用 `timeout -r` 还原
3. **不要用 `uitest uiInput keyEvent Back`**：根页面上返回交给平台会直接退出应用
4. **dumpLayout 中文乱码**：用 Latin 锚点找节点（`Agents-Anywhere`、`jerry`、`DESKTOP-xxx`）
5. **不要用估算坐标**：布局随数据到达整页重排，坐标必须来自最新 dump 的节点 bounds 中点；抽屉打开时内容卡片右移，dump 坐标带偏移，先确认抽屉状态
6. **看颜色要取像素，别靠眼睛**：JPEG 预览会骗人（#FDFCFB vs #FFFFFF 只差 2~4 级），用 System.Drawing.GetPixel 取值比对
7. **`hilog -x` 不能与 `-z` 等选项组合**（CODE: -31）；本工程 JS hilog 不进 `-x` 捕获缓冲时，优先"界面 debug Text + dumpLayout origBounds"测量法
8. **测试产物不要放 %TEMP% 裸目录**（Windows 临时清理会连工具带产物一起删），放 worktree 或结构化临时目录

---


## 一、已对齐（DONE）

### 认证 / 登录
- Web PKCE S256 登录 + 自托管服务器地址输入 + 健康检查（`LoginPage.ets`、`AuthApi.ets`）
- **扫码登录**：ScanKit 系统扫码 → `requestMobileLogin` → 轮询 `mobileLoginStatus` → `exchangeMobileLogin`（`auth/MobileLoginQrPayload.ets`、`common/AppConfig.ets`）
- **官方云一键登录**：`OFFICIAL_SERVER_URL = 'https://web.agents-anywhere.com'`（对齐安卓 `AppConfig.kt`）
- 登录页两选项结构对齐安卓 `AuthScreens.kt`（扫码主路径 / 账号密码次路径 + 官方云/自建选择）
- 会话持久化（`auth/AuthSessionStore.ets` EncryptedStore）+ 401 统一清栈（`authSessionExpiredTick`）

### 会话与首页
- 项目分组首页、Active/Archived tab、批量归档、标记已读、会话分享、重命名/置顶/归档（`HomePage.ets`）
- **按项目全部归档**：`POST /projects/{id}/sessions/archive-all` + 确认弹窗（批次 T2）
- **设备全部归档**：`archiveAllDeviceSessions` UI 接入（设备展开操作区，批次 T2）
- dashboard 实时 WS 刷新 + 指数退避
- 新建会话：设备/runtime 自动选择（在线设备 + running 激活 runtime）、cwd、首条消息（`NewSessionSheetOverlay.ets`）
- **新建会话 selections + 内联附件**：内联 base64 附件（≤10 个 / 单个 ≤25MiB，SHA256 作 fileId，对齐安卓 `toInlineAttachmentRef`）；runtimeId/selections 字段逐字段对齐 Server `SessionCreateAndStartRequest`（批次 T6）

### 会话详情 / 审批
- timeline 渲染、user/assistant 气泡、历史分页、乐观消息
- notice 审批卡片 + respond；**notice input 表单**（`input.schema`/`uiSchema`/`inputRequest` 问答，`feature/NoticeInputForm.ets`）
- **takeover 开关**：`POST/DELETE /sessions/{id}/takeover` 专用端点（修复了此前走 PATCH meta 被服务端忽略的功能性 bug，批次 T1）
- **实时事件批窗**：100ms 窗口聚合（上限 128 条，对齐安卓 MAX_WIRE_EVENT_BATCH_SIZE），一次重建/一次滚动/一次刷新（批次 T1）
- **`session.refetch_required` / `runtime.refetch_required` 事件处理**（批次 T1）
- **能力驱动门控**：`session.send_message`/`session.interrupt`/`session.interaction.approval`/`session.commands`/`session.command.execute`/`runtime.attachment` 六能力，capabilities 缺失时不门控（对齐安卓语义，批次 T1）
- **乐观消息跨页持久化**：`common/OptimisticMessageStore.ets` 内存单例（对齐安卓 `SessionOptimisticMessageStore`，同为进程内 Store 无磁盘持久化），发送/进页/确认/失败四点对账（批次 T8）
- slash-command 解析 + 前缀建议 + 执行；附件 URL 拉取上传

### 终端
- terminals-v2 复用/创建、WS 流式输出、重连、实时 resize（本地网格 + resize 帧）、断线输入队列 + replay（此前批次）
- **快捷键工具条**：17 键（ESC/`/`/`-`/HOME/↑/END/PGUP/TAB/CTRL/ALT/←/↓/→/PGDN + `^C`/`^D`/`^L`），CTRL/ALT 粘滞锁定，修饰键组合转义序列对齐安卓 KeyHandler（批次 T3）
- **终端模拟器渲染升级**：完整 SGR（16 色 Termux/xterm 表、256 色、RGB 真彩、加粗/反色）、scrollback 渲染（LazyForEach + 缓存 + sticky bottom + "回到底部"）、可视块光标、DECSET 25 光标可见性、IL/DL/DCH/ICH/ECH、`CSI 3J`（批次 T3，`common/TerminalEmulator.ets` + `common/TerminalRender.ets`）
- **后台保活**：`backgroundTaskManager.startBackgroundRunning(BackgroundMode.DATA_TRANSFER)` + `KEEP_BACKGROUND_RUNNING` 权限 + `backgroundModes: ["dataTransfer"]`，失败静默降级（批次 T3）

### 设备 / 配对
- **设备列表页（第十四轮重构，对齐 DevicesScreen）**：AddDeviceRow（→ pairing）+ DeviceRow（图标按 deviceOs desktop/computer/pc、在线状态标签、在线 agent 预览计数、chevron → device_detail 路由）；排序 online desc→createdAt asc→name asc；下拉刷新 + onShown 静默刷新
- **设备详情页（第十四轮新增、第十五轮头部重构 `pages/DeviceDetailPage.ets`，对齐 DeviceDetailScreen）**：内容区自绘 64vp DeviceDetailHeader（38vp 圆钮 back/more、标题 25sp/800 flexShrink 收缩 + 在线状态同行，`.hideTitleBar(true)`）→ actions sheet（Rename 内联/Revoke 仅在线/Delete 危险色）；AGENT 区（加载/错误重试/10 种 RuntimeStatus 全量本地化/32×20 开关/删除配置确认含 active 变体）；SESSIONS 区（Select/Archive all、Active/Archived/All 筛选、批量栏、相对时间会话行、bulk 归档/取消归档 + notFound 提示、按 scope 全部归档/取消归档确认，limit=100 对齐安卓）；删设备/撤销令牌确认
- 设备 CRUD API（列表/重命名/删除/revoke）
- 完整配对流程：create + token 展示 + pair-code claim + 上线轮询（`feature/DevicePairingFlow.ets`、`pages/DevicePairingPage.ets`）
- **runtime 配置 API**：`POST /connectors/{id}/runtimes/discover`、`PUT .../runtimes/{rid}/config`、`PUT .../active`、`DELETE .../config` 四端点 + 配置底部弹层组件保留（`components/RuntimeConfigureSheetOverlay.ets`）；第十四轮 strict 对齐后 UI 不再引用 discover/configure 入口（安卓 UI 亦无此入口，系鸿蒙独有遗留能力，API 保留备用）
- runtime 设激活/停用、删除（含运行中危险确认文案区分）

### 文件 / 附件
- 设备文件页（根路径切换、目录导航、文本查看、binary/truncated 提示）
- **会话内 agent 文件页**：复用 `fs/list`/`fs/readText`/`fs/read` 端点（`connectorId` + `root=session.cwd`，对齐安卓 `SessionAgentFilesScreen` 复用设备文件端点的方式），目录浏览 + 文本预览 + 保存到本机（`pages/SessionAgentFilesPage.ets`，路由表 `session_agent_files`，批次 T5b）
- 本地附件上传：相册 PhotoViewPicker + 文件 DocumentViewPicker.select + **相机拍摄**（`cameraPicker.pick`，免权限系统相机，批次 T5a）
- **非图片附件下载/保存**：带认证 base64 下载 → `DocumentViewPicker.save` → `fileIo` 写入（免权限，批次 T5a）
- 图片附件预览（base64 → PixelMap 缓存）

### Markdown / 富文本
- 完整 markdown 解析 + 表格 + 任务列表 + 自动链接 + diff 预览（`common/Markdown.ets`、`components/DiffCodeView.ets`）

### 新建会话（B3 重构，对齐安卓 NewSessionScreen）
- **配置卡**：Device/Runtime chips + Model/Reasoning(Effort)/Permission 三 catalog 选择（`GET /connectors/{id}/runtimes/{rid}/capabilities|catalogs/model|catalogs/permission`，逐字段对齐 `connector_runtimes.py` 契约），loading/失败/重试态，提交 payload 带 selections（`NewSessionSheetOverlay.ets` + `DevicesApi.ets` catalog DTOs）
- **权限本地化**：`common/RuntimePermissionLocalization.ets`（移植安卓 `SessionRuntimeState.kt` localizeRuntimePermission，22 条 label/desc 文案）
- **偏好记忆**：`auth/NewSessionPreferenceStore.ets`（preferences `last-selection-v2`，持久化 connector/runtime/model/permission/effort）
- **Workspace 目录浏览器**：fs/list 远程目录浏览（进入/上级/选定 cwd/loading/空/错误重试）
- **Setup 引导面板**：checking/devices-unavailable/no-devices/connect-device/offline/agents-unavailable/setup-agent/no-runtimes 全状态机（对齐安卓 NewSessionSetupPanel），检查重试 + "去设备页"
- 可编辑标题 + 保留鸿蒙独有的首条消息/附件能力；全量 i18n + 主题化（消除硬编码颜色/英文）

### 文件页（B1 + 第十七轮重构，对齐安卓 FilesScreen/DeviceFilesContent）
- **布局结构（第十七轮）**：自绘 filesHeader（back 40vp 圆钮 + 设备胶囊 44vp r14 + chevron_down）；锚定设备下拉（仅在线设备、checkmark 选中、点击外部关闭）；PathBar（路径胶囊 15sp/800 + 52×52 复制钮 Copy/Check 1100ms 切换）；列表 60vp 行（40vp 中性色图标盒 + 15sp/600 名称 + 目录 chevron_right + 按压 flash/shadow）；".." 行上级导航；空态三分支（未配对 EmptyState + 配对按钮 / 加载中 / 全部离线）
- **resolvedRoot / 初始路径语义（第十七轮）**：进入路径对齐安卓 `initialRemoteFilePath`——Windows 设备 `''`（盘符概览"这台电脑"，无 ".." 行），非 Windows `'.'`（家目录）；'~' 起步，Windows 加载后取盘符根、非 Windows 首载解析为家目录绝对路径，后续 ".." 可越出 home，与安卓 RemoteFileNavigation 一致；路径显示反斜杠→正斜杠（对齐 displayRemotePath）
- 长按文件/目录 → 菜单复制路径（`components/FileRowMenuOverlay.ets`）
- 文件预览：文件内搜索（大小写不敏感、↑↓ 导航、当前/总数计数、行高亮定位）+ 复制内容
- Windows 盘符概览（`''` 路径 = "这台电脑"，`common/FileViewSupport.ets` 盘符/上级目录工具）
- 语义文件图标（文件夹/代码/文本/普通）；会话 agent 文件页同步以上能力
- 保留鸿蒙领先项：25MB 保存到本机

### 会话详情（B2 对齐）
- **takeover 确认弹窗**：开关/关闭均弹确认（对齐安卓 session_enable/disable_takeover 文案，DSH 专属正文），确认才调 API，失败回弹，busy 防重入
- **附件全屏预览**：`components/AttachmentPreviewOverlay.ets`（Swiper 翻页 + 底部缩略图条 + 双指缩放 1–4x + LoadingProgress 占位 + 失败文件名 fallback + 远程附件下载/保存）；`loadAttachmentPixelMap` 缓存与并发去重（`AttachmentImageView.ets` 抽出共用）
- **消息气泡格式对齐**：用户气泡 sessionMessageBubble 色（非 primaryAction 反色）+ 浅纸底文字色；助手裸 markdown（无卡片包装）；消息间距 16vp + 水平 padding 20vp；Notice 卡片按 error/warning/success 严重级别着色（第九轮）

### 终端
- **清屏按钮**：状态行垃圾桶按钮，本地清屏（清屏幕+scrollback+光标归零，`TerminalEmulator.clearScreen()`；安卓为重启 shell，语义差异见下）

### 首页（B4 + B6 布局重构对齐）
- **项目过滤器**：status/device/agent 三维过滤 + Clear（`components/HomeProjectFilterOverlay.ets`，对齐安卓 HomeProjectMenus/SidebarSelectors 谓词）；安卓顶栏搜索按钮实为"敬请期待"占位 toast（HomeScreen.kt:221），鸿蒙对齐为同语义占位
- **公告/更新弹层整改**：`AnnouncementGateOverlay`/`AppUpdatePromptOverlay` 全量 i18n（中/英）+ getColors 主题化（支持暗色），挂载移至 `Index.ets` 根部（对齐安卓 App 级挂载，登录页同样被公告覆盖）
- **布局结构（B6）**：顶栏 46dp（头像圆钮 42/人形图标 21 + wordmark 31sp/40 + 搜索钮 42/图标 24，间距 12）；QuickEntries 三卡 76dp（r18、padding 12/13、图标 22 灰 + 标题 14 Bold/17，间距 10）替代原四胶囊 navAction 行；Active/Archived tab 改为安卓 HomeTabPill 样式（pill 34/r17、选中底 亮#ECECE9/暗#27272A、14sp 选中 Bold/未选 600）；分组头 56dp（folder 21 + 16 Bold + more/square_and_pencil 38/19）；会话行 44dp（robot 16 + 15 Medium + 状态指示 pill 12.5/h18 + busy 20 + 未读点 9）；右下 FAB 54dp 黑底白 plus 24（margin 18/32，打开新建会话 sheet）；外层 Column padding 18/18/6、子项间距 15；空态对齐 AppEmptyState（消息 16 Medium + 药丸按钮 44/r22）
- **侧边栏显示（B8）**：Profile 抽屉"侧边栏显示"卡 + 项目视图/会话视图下拉弹层（`auth/SidebarViewModeStore.ets` 全局持久化）；Session 模式首页渲染置顶/最近平铺会话列表（66 行高 + agent 品牌图标 + "设备 · 项目"上下文标签 + 状态指示器）；模式切换即时重渲染、重启保持

### 设置 / 多语言
- displayName、修改密码、**邮箱绑定**、**头像上传/清除**（`PUT/DELETE /auth/me/avatar`，256px PNG data URL 对齐安卓压缩策略，批次 T7）
- **多语言**：中/英三份 string.json（base/en/zh_CN）全量维护
- **外观模式**：Follow system/Light/Dark 三选 + 持久化（`designsystem/AppearanceSettings.ets`，getColors 强制色板 + 全页响应，B5 对齐安卓 AppearancePopup）
- **版本/更新检查行**：当前版本号 + 静默检查 + 新版本红点 + 手动检查更新（对齐安卓 ProfileRow，复用 AppUpdateIgnoreStore/openLink 流程，B5）

### 公告
- 公告 gate + 已读（`AnnouncementGateOverlay.ets`，Index 根挂载）

---

## 二、部分对齐（PARTIAL）

| 功能点 | 安卓现状 | 鸿蒙现状 | 说明 |
| --- | --- | --- | --- |
| 终端选区复制 | Termux emulator 选区 + 复制 | 无选区交互 | 需自定义手势 + 命中测试，建议独立批次 |
| 终端备用屏幕缓冲区 | CSI ?1049 完整支持 | 私有序列安全吞掉，不污染 scrollback，但全屏应用仍画主屏 | 已知偏差 |
| 终端清屏语义 | 清屏按钮实为重启 shell | 本地清屏（保留 shell 连接） | B1 采用本地清屏，语义更温和；如需对齐安卓改重启 |
| 终端多实例池 | `RemoteTerminalPool` 多页共享 | 每页单实例 | 鸿蒙页面栈结构不同，影响有限 |
| 确认弹窗内联错误 | 弹窗内 busy/inline error + 重试 | 确认即关 + 异步执行 + 失败 toast + actionError 横幅 | 第十四轮记录偏差，沿用鸿蒙静态 ConfirmDialog 模式 |
| 发送中按钮状态跨页恢复 | `sending = hasPendingOptimisticSend()` | 仅恢复消息气泡，按钮不跨页（旧实例 Promise 无法通知新实例） | T8 未尽事项 |
| 发送失败草稿跨页 | 失败草稿持久化 | 离页后失败草稿丢失 | T8 未尽事项 |
| notice 草稿/状态机 | `RuntimeNoticeDraftStore` + 状态合并 | `respondingNoticeId` 单条锁，无草稿 | 现有实现可用，缺草稿续填 |
| model/permission catalog 预览 | runtime 配置 sheet 内预览 | API 字段已解析（`schemaRecord` 等），UI 未做预览区；新建会话流程已消费三 catalog（B3） | T4 未尽事项 |
| 代码高亮 | TextMate 语法高亮（消息代码块 + Sora 文件预览） | 纯代码块 + diff 预览；文件预览为纯文本（B1 已加文件内搜索/复制） | 中期增强 |
| 文件路径点击跳转 | `parseFileRef` + onOpenFile | 缺失 | P2 |
| 文件重命名/上传 | 安卓亦未实现 | 未实现 | 两端共同缺口，随 Server fs 能力评估 |
| 附件预览聚合范围 | 全会话图片合并翻页 | 当前消息附件内翻页 | B2 未尽事项 |
| 首页 agentLabel 副标题 | 过滤激活时项目行显示 agent 副标题（行高 64） | 未实现（恒 56） | B7a 未尽事项 |
| 首页折叠指示 | FolderOpen/Folder 双图标变体 | folder/folder_fill 代替（sys.symbol 无 folder_open） | B7a 已知视觉偏差 |
| 首页归档访问 | Profile 侧栏 → ArchivedSessionsScreen | 项目过滤选"已归档"或 Profile 抽屉 → 归档会话页 | B7 对齐 |
| 抽屉内弹窗返回键 | 弹窗单独拦截返回 | 系统返回会整个关闭抽屉 | B7b 已知行为偏差 |
| Profile 更新详情页 | 版本行进入更新详情页（下载进度等） | toast + 复用更新弹层（打开下载页） | B5 最小一致方案；应用内下载两端同为占位 |
| 会话视图行尾时间 | SessionList 行尾 updatedAt 相对时间 | 未显示（仅状态指示器） | B8 会话视图行未实现时间标签；sortKey 为原始 ISO 串，需相对时间格式化，后续批次补 |

---

## 三、未对齐 / 平台差异（KNOWN GAP）

| 功能点 | 状态 | 说明 |
| --- | --- | --- |
| 应用内更新下载安装 | 平台差异 | 安卓 `UPDATE_DOWNLOAD_URL` 仍为占位 `.invalid`（发布前需替换）；鸿蒙更新入口已指向官网下载页 `https://agents-anywhere.com/download`（`AppUpdatePromptOverlay` openLink 打开下载页，HAP 安装需 AppGallery/签名分发，无法复刻安卓 APK 直装），待 AppGallery 上架后替换为固定包地址 |
| 终端后台保活的推送级保活 | 平台差异 | 安卓前台服务 vs 鸿蒙 continuousTask，机制不同已按各平台最佳实践实现 |

---

## 四、验证状态与遗留风险

- 每批次均通过 `arkts_check`（0 错误）与 `devecocli build`（BUILD SUCCESSFUL）。
- **未做运行时验证**：所有端点调用链（takeover、runtime discover/configure、catalog 三端点、相机拍摄、附件保存、agent 文件保存、头像上传、内联附件创建、终端渲染、后台保活、目录浏览器、文件内搜索）仅静态与构建验证，未在真机/模拟器实测。
- 已知遗留：`LoginPage.ets`/`WebLoginModels.ets` 存量弃用 API 警告（各批次未触碰）；`SessionActionMenuOverlay` 等早期组件存量硬编码文案待后续批次 i18n 化。
