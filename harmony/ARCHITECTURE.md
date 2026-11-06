# HarmonyOS 架构分层规则

这个工程采用与 `android/ARCHITECTURE.md` 相同的分层结构，目的是让鸿蒙客户端与 Android
客户端可以逐文件对照阅读。规则不要搞复杂，重点是让每个目录的职责稳定、可预期。

## 目录职责

```text
com.agentsanywhere.app.api
com.agentsanywhere.app.feature
com.agentsanywhere.app.model
com.agentsanywhere.app.ui
com.agentsanywhere.app.navigation
com.agentsanywhere.app.app
com.agentsanywhere.app.storage
com.agentsanywhere.app.common
```

### `api`

负责网络请求和后端数据结构。

适合放这里：

- HTTP / WebSocket 传输封装
- 跟后端 JSON 对应的 DTO 与解析函数
- API 相关异常
- URL 规范化、`/api/v2` 命名空间与 legacy 回退规则

按产品概念拆文件，与 Android 保持一致：

- `AuthApi` / `AuthDtos`：登录、账号、移动端 QR 登录
- `SessionsApi` / `SessionsDtos`：session 列表、创建、timeline、approval、附件、runtime settings
- `DevicesApi` / `DevicesDtos`：设备列表、重命名、删除、pairing、runtime capabilities
- `TerminalApi` / `TerminalDtos`：打开、关闭、stream URL
- `FilesApi` / `FilesDtos`：目录列表、文本文件读取
- `RealtimeApi` / `RealtimeDtos`：ws-ticket、dashboard / session 事件

不应该放这里：

- 任何 ArkUI 代码
- 页面状态
- 面向用户展示的文案，除非是 API 错误兜底文案
- 把数据组合成页面展示内容的业务规则

### `feature`

负责功能层逻辑，也就是"不画 UI，但决定功能怎么运行"的代码。

适合放这里：

- Controller / use case
- 页面状态模型
- 状态更新和 patch helper
- 筛选、排序、分组、派生状态
- 远端 DTO 到 app 内部模型的转换

不应该放这里：

- 任何 `@Component` / `@Builder` / ArkUI 类型
- 颜色、间距、字体、动画
- 按钮、弹窗、列表行、toast 等 UI 组件

### `model`

负责 app 内部共享的数据模型。

适合放这里：

- 多个 feature 都会用到的数据类
- 稳定的 app 概念，比如 session、device、project、auth payload、runtime metadata

不应该放这里：

- 只服务某个 API 的 DTO
- 只服务某个 UI 的临时状态
- ArkUI 相关类型

### `ui`

负责 ArkUI 界面和视觉交互。

适合放这里：

- screen、row、button、sheet、dialog、toast、loading state、empty state
- 只影响视觉表现的 UI 状态，比如某个 section 是否展开
- 颜色、间距、动画、glyph、design system 组件

不应该放这里：

- 网络请求
- 本地持久化
- 应该脱离 UI 测试的筛选、排序、业务规则
- 后端 DTO 解析

### `navigation`

负责路由和目的地定义。

这个目录应该保持很小，只有 `AppDestination` 一个枚举，不应该知道 API client、controller
或 UI 实现细节。

### `storage`

负责本地持久化。与 Android 的 `SharedPreferences` 一一对应，store 名称与 key 保持字节一致，
方便跨客户端排查问题。

### `app`

负责应用级组装。

适合放这里：

- 根组件
- 依赖组装
- 目的地切换编排
- 窗口宽度驱动的多列布局编排（`SPLIT_BREAKPOINT` 与左右两栏的组装）
- app 级副作用（导航、实时订阅、登出）

不应该在这里写具体 feature 的业务规则。

### `common`

横切的纯工具，目前只有日志封装。

## 依赖方向

推荐依赖方向：

```text
app -> ui
app -> feature
app -> api
app -> storage

ui -> feature
ui -> model
ui -> navigation
ui -> designsystem

feature -> api
feature -> model
feature -> storage

api -> model
storage -> api        // 仅为 ServerOrigin 规范化，无传输依赖
```

尽量避免这些方向：

```text
api -> feature
api -> ui
feature -> ui
model -> ui
model -> api
ui -> api             // 页面不直接发请求，一律经 feature
```

## 与 Android 的对照

| HarmonyOS | Android | 说明 |
| --- | --- | --- |
| `ui/designsystem/AAColors.ets` | `ui/designsystem/Theme.kt` | 38 个语义色 token，light / dark 两套 |
| `ui/designsystem/AAIcon.ets` | Lucide `ImageVector` + `Glyphs.kt` | 用 SVG path 描边复刻 Lucide 几何 |
| `ui/designsystem/AAIosChrome.ets` | **iOS**：`Views/Auth/AuthLayout.swift` + `Views/Components/AppGlassButton.swift` | 唯一一处不走 Android 对照的界面文件：iOS 客户端的页面 chrome（导航行 / 大标题 / 胶囊按钮 / 下划线输入），从登录页起被逐批推广到设置与其它页面（用户第 40 轮决定），配色仍取本工程的 `AAColors` |
| `navigation/AppDestination.ets` | `navigation/AppDestination.kt` | 枚举值顺序即转场方向，必须一致 |
| `storage/AuthSessionStore.ets` | `feature/auth/AuthSessionStore.kt` | 凭据读写与 401 清理 |
| `api/ServerOrigin.ets` | `api/ApiUrls.kt` 的规范化部分 | 独立成模块，避免 storage 依赖传输层 |
| `ui/designsystem/AABottomSheet.ets` | `ui/designsystem/AABottomSheet.kt` | 行组件与调色板；弹层本体由屏幕的 `bindSheet` 打开 |
| `ui/designsystem/RuntimePermissionLocalization.ets` | `ui/designsystem/RuntimePermissionLocalization.kt` | 权限模式 kind → 资源；本地化逻辑在 `feature/`，映射留在 `ui/` |
| `feature/sessiondetail/CodeLanguage.ets` | `CodeBlockPreview.kt` 的 `specFor` 一族 | 语言判定表；tokenizer 与取色因此不依赖任何外部库 |
| `feature/sessiondetail/CodeTokenizer.ets` | TextMate grammar + Sora 分析器 | 自研扫描器，产出每行的 `CodeSpan` |
| `ui/designsystem/AACodeColors.ets` | `assets/textmate/{quietlight,darcula}.json` | 主题 scope 取色与面板 chrome 色 |
| `feature/sessiondetail/SessionScrollFollow.ets` | `SessionMessages.kt` 的 `shouldAutoFollowRealtime` / `latestTimelineItemChanged` | 跟随判定是纯函数，便于直接对照原实现 |
| `feature/sessiondetail/PendingAttachment.ets` | `AttachmentImages.kt` 的 `PendingAttachment` + `formatBytes` | 附件模型、上限与格式化 |
| `feature/sessiondetail/SessionAttachmentTransfer.ets` | `SessionAttachmentTransfer.kt` | 上传校验（size + SHA-256）与失败文案 |
| `feature/sessiondetail/AttachmentPicker.ets` | `SessionDetailScreen.kt` 的选择器与 `uploadPart` | 系统选择器与文件读取；media type 由扩展名推导 |
| `ui/screens/sessiondetail/ComposerAttachments.ets` | `SessionComposer.kt` 的附件条与来源菜单 | 卡片几何逐值对齐 |
| `ui/screens/sessiondetail/AttachmentViews.ets` | `SessionMessages.kt` 的 `UserAttachmentStrip` + `AttachmentImages.kt` | 会话内附件、远端图片解码与全屏查看器 |
| `feature/devices/DeviceAgentPreviews.ets` | `feature/devices/DeviceAgentPreviewState.kt` | Agent 计数、生成号防陈旧、设备页排序 |
| `feature/devices/DeviceDetailState.ets` | `feature/devices/DeviceDetailState.kt` | 按 connectorId 过滤设备会话与工作区分组 |
| `feature/devices/DeviceRuntimeState.ets` | `feature/devices/DeviceRuntimeState.kt` | runtime 库存管理态（加载/待定/错误/排序） |
| `ui/screens/devices/DeviceDetailScreen.ets` | `ui/screens/devices/DeviceDetailScreen.kt` | AGENTS / SESSIONS 两段与行组件 |
| `ui/screens/devices/DeviceConfirmDialog.ets` | `ui/screens/devices/DeviceConfirmDialog.kt` | 五种确认共用一张卡；Android 用模态 `Dialog`，这里在 scrim 覆盖层里画同一张卡 |
| `ui/screens/devices/DeviceActionsSheet.ets` | `ui/screens/devices/DeviceActionsSheet.kt` | 操作 sheet；Revoke 行进入配对向导的 token 步骤 |
| `feature/devices/DevicePairingFlow.ets` | `feature/devices/DevicePairingFlow.kt` | 步骤导航、命令与引号规则、随机设备名 |
| `feature/devices/DevicePairingMonitor.ets` | `feature/devices/DevicePairingMonitor.kt` | 配对等待状态与轮询决策表（轮询循环在 app 中） |
| `ui/screens/devices/AddDeviceScreen.ets` | `ui/screens/devices/AddDeviceScreen.kt` + `DevicePairingSteps/Components.kt` | 七步向导页面 |
| `feature/files/RemoteFileNavigation.ets` | `feature/files/RemoteFileNavigation.kt` | POSIX/Windows 路径规则，纯函数便于直接对照 |
| `feature/files/FilesController.ets` | `feature/files/FilesController.kt` | 目录/文本读取与行过滤排序 |
| `ui/screens/files/FilesScreen.ets` | `ui/screens/files/FilesScreen.kt` + `SessionAgentFilesScreen.kt` | 设备浏览与会话 pager 两种形态；会话模式下第二个标签页挂 `TerminalContent` |
| `ui/designsystem/AACodeLines.ets` | `configureReadOnlyCodeEditor` 的行号/文本部分 | 会话代码围栏与文件预览共用 |
| `api/TerminalApi.ets` + `TerminalDtos.ets` | `api/TerminalApi.kt` + `TerminalDtos.kt` | `terminals-v2` 的建/列/关与流地址；`label` 的 `ifBlank` 语义单独实现 |
| `feature/terminal/RemoteTerminalOutputBuffer.ets` | `feature/terminal/RemoteTerminalOutputBuffer.kt` | 64 KiB 分批与 generation 失效，逐条件对照 |
| `feature/terminal/TerminalController.ets` | `feature/terminal/TerminalController.kt` | 打开/复用/关闭；`uniqueTerminalLabel` 复刻 Java `hashCode` |
| `feature/terminal/RemoteTerminalController.ets` | `feature/terminal/RemoteTerminalController.kt` | 帧协议、重连、输入闩锁；渲染改为写入 `TerminalScreenSink` |
| `feature/terminal/TerminalKeys.ets` | `com.termux.terminal.KeyHandler`（AAR） | 面板可达的按键转写，含应用光标模式与修饰键形式 |
| `feature/terminal/RemoteTerminalPool.ets` | `feature/terminal/RemoteTerminalPool.kt` | 按设备/会话缓存控制器 |
| `feature/sessions/NewSessionState.ets` | `feature/sessions/NewSessionState.kt` | 工作区选项、创建草稿、提交状态、断线候选反查 |
| `feature/sessions/NewSessionWorkspaces.ets` | `feature/sessions/NewSessionWorkspaces.kt` + `WorkspaceProjects.kt` 的 `workspacePathKey` | 最近工作区排序与路径键 |
| `feature/sessions/NewSessionRuntimeInventory.ets` | `feature/sessions/NewSessionRuntimeInventory.kt` | 可用的 runtime 与库存是否稳定 |
| `feature/sessions/NewSessionRuntimeSelectionState.ets` | `feature/sessions/NewSessionRuntimeSelectionState.kt` | 能力集/模型/权限三段加载与选中态；复用 `api/` 的 catalog 类型 |
| `feature/sessions/NewSessionPreferenceStore.ets` | `feature/sessions/NewSessionPreferenceStore.kt` | 上次的目标与按 runtime 记忆的选择 |
| `feature/sessions/NewSessionDraft.ets` | `feature/sessions/NewSessionDraft.kt` | 本地草稿会话与首条消息请求 |
| `ui/screens/home/NewSessionScreen.ets` | `ui/screens/home/NewSessionScreen.kt` | 页面状态机（两个触发器替代十余个 `LaunchedEffect`）与布局；含 `projectOnly`/`creatingProject` 两态 |
| `ui/screens/home/NewProjectScreen.ets` | `ui/screens/home/NewProjectScreen.kt` | 项目编辑器：设备字段 + 54dp 名称框 + 目录浏览器槽位（`@BuilderParam`）|
| `ui/screens/home/NewSessionComponents.ets` | `NewSessionCommonComponents.kt` + 两个 Section 的行组件 + `WorkspaceMarqueeText.kt` | 药丸/小钮/主按钮/工作区行/路径行/跑马灯 |
| `ui/screens/home/NewSessionHeader.ets` | `ui/screens/home/NewSessionHeader.kt` | 标题与内联编辑框 |
| `ui/screens/home/NewSessionConfigurationCard.ets` | `ui/screens/home/NewSessionConfigurationCard.kt` | 五个选择器与菜单 |
| `ui/screens/home/NewSessionPathSection.ets` | `ui/screens/home/NewSessionPathSection.kt` | 当前目录条与目录列表 |
| `ui/screens/home/NewSessionWorkspaceSection.ets` | `ui/screens/home/NewSessionWorkspaceSection.kt` | 工作区/项目两种模式的列表 |
| `ui/screens/home/NewSessionSetupState.ets` | `ui/screens/home/NewSessionSetupState.kt` | 九种前置原因（纯函数） |
| `ui/screens/home/NewSessionSetupPanel.ets` | `ui/screens/home/NewSessionSetupPanel.kt` | 前置条件面板 |
| `feature/sessions/NewSessionRuntimeInventoryLoader.ets` | `ui/screens/home/NewSessionRuntimeInventory.kt` 的加载器部分 | 轮询到库存稳定、版本号丢弃过期响应 |
| `ui/designsystem/AADropdownMenu.ets` | `ui/designsystem/AADropdownMenu.kt` | 菜单内容由 `bindMenu` 承载；行组件自带按压态 |
| `api/DevicesApi.ets` 的三个 catalog 方法 | `api/DevicesApi.kt` 的 `getDeviceRuntime*` | 连接器级能力集与两个 catalog；信封形状逐字段对齐 |
| `feature/sessions/WorkspaceProjectResolver.ets` | `feature/sessions/WorkspaceProjectResolver.kt` | 工作区所属项目的查找/创建与名称冲突重试 |
| `api/RuntimeIdentity.ets` | `api/RuntimeIdentity.kt` | runtime 类型与 `rti_…` 实例 id 的正则 |
| `api/SessionsApi.ets` 的 `createAndStartSession` | `api/SessionsApi.kt` 同名方法 | 创建并发送首条消息；75s 读超时、按需写字段 |
| `app/AgentsAnywhereApp.ets` 的草稿会话分支 | `SessionDetailScreen.kt` 的 `preparedSession` 分支 | 草稿预览会话 + 首条消息创建 + 失败回填 composer |
| `ui/screens/profile/ProfileSettingsDrawer.ets` | `ui/screens/profile/ProfileSettingsDrawer.kt` | 索引页与语言子页；账号页、更新页待做 |
| `ui/screens/profile/ProfileSettingsComponents.ets` | `ProfileSettingsComponents.kt` | 头部、行、图标盒、分隔线、退出登录卡 |
| `ui/screens/profile/ProfileSettingsSupport.ets` | `ProfileSettingsSupport.kt` | 标签映射、本页专属表面色、头像 data URL |
| `ui/screens/profile/ProfileAccountPage.ets` | `ProfileSettingsDetails.kt` 的 `AccountDetailPage` | 头像、信息卡、操作卡、退出卡 |
| `ui/screens/profile/ProfileDialogs.ets` | `ProfileSettingsDialogs.kt` + `ProfileIdentityDialogs.kt` | 对话框基座（`@BuilderParam` 槽位）与四个身份对话框 |
| `feature/sessiondetail/PendingAttachment.ets` 的 `localDraftAttachment` | `SessionDetailScreen.kt` 的 `UploadFilePart.toLocalTimelineAttachment` | 草稿附件的本地行：SHA-256 作 fileId，不上传；字节随首条消息按 inline part 发送 |
| `feature/files/FileSearch.ets` | `CodeBlockPreview.kt` 的 `SoraFileSearchController` + `EditorSearcher` | 文件内搜索：字面量、大小写不敏感、逐行非重叠、循环跳转；并把 token span 与空隙合成渲染段 |
| `ui/screens/files/FilesScreen.ets` 的 `InlineFileSearchBar`/`SearchStepButton` | `SessionAgentFilesScreen.kt` 的 `InlineFileSearchControls`/`SearchStepButton` | 46dp 搜索条、34dp 输入框、`当前/总数` 计数器与两个 30dp 圆形步进按钮 |
| `feature/sessiondetail/AgentReplyActions.ets` | `SessionMessages.kt` 的 `buildAgentActionsByTurnEnd` + `AgentReplyAction` | 逐轮分组决定页脚落点、复制文本（空行连接）与"本回复"的 item id 集合 |
| `ui/screens/sessiondetail/SessionReplyActions.ets` | `SessionMessages.kt` 的 `AgentReplyActions` 三个组件 | 1dp 分隔线 + 30dp 圆形复制（Android 位图）/分享（lucide `square-arrow-out-up-right`）按钮 |
| `ui/screens/sessiondetail/SessionShareDialog.ets` | `SessionDetailScreen.kt` 的 `SessionShareDialog`/`SessionShareOption` | 26dp 圆角卡片、两个作用域行（选中态 subtle + ink@0.28）、取消/创建按钮 |
| `api/SessionsApi.ets` 的 `createSessionShare` + `AppServices` 的分享链路 | `SessionsApi.kt` 的 `createSessionShare` + `AgentsAnywhereApp.kt` 的 `createShare` | `POST /sessions/{id}/shares`；作用域 `message`/`session`；`@kit.ShareKit` 的系统分享面板 |
| `feature/sessiondetail/RuntimeCommandsState.ets` | `SessionRuntimeState.kt` 的 `RuntimeCommand`/`RuntimeCommands` + `SessionDetailScreen.kt` 的 `/cmd args` 解析 | 命令匹配（id/标题/别名/描述四段子串）、六行上限、加载状态机的请求键守卫 |
| `ui/screens/sessiondetail/RuntimeCommandSuggestions.ets` | `SessionRuntimeControls.kt` 的 `RuntimeCommandSuggestions` | 18dp 圆角面板、四种状态、每行 `/<id>  <title>` 与描述/禁用原因 |
| `feature/sessiondetail/ComposerDraftStore.ets` | `ui/screens/sessiondetail/SessionComposerDraftStore.kt` | 按账号/会话保存 composer 文本与附件；解析容忍缺字段；"上传中"恢复为失败 |
| `storage/AAPreferences.ets` 的 `composerDrafts` | Android 的 `session-composer-drafts-<hash>` 文件名 | 沿用 Java `String.hashCode()` 计算后缀，便于跨端对照调试 |
| `api/UpdateVersion.ets` | `api/UpdateVersion.kt` | 版本比较；用数字串比较代替 `BigInteger` |
| `api/AppUpdatesApi.ets` | `api/AppUpdates.kt` | `/health` 版本检查 |
| `feature/update/AppUpdateController.ets` | `feature/update/AppUpdateViewModel.kt` 的决策部分 | 检查/提示/忽略版本；下载安装按差异表去掉 |
| `ui/screens/terminal/TerminalContent.ets` | `SessionAgentFilesScreen.kt` 的 `TerminalContent` | ArkWeb 宿主 + 桥（`TerminalWebSink`）、状态区、清屏钮、快捷键面板 |
| `ui/screens/terminal/TerminalScreen.ets` | `ui/screens/terminal/TerminalScreen.kt` | 设备选择头部与三种主体状态 |
| `feature/sessions/SessionsController.ets` 的 `loadProjects`/`createProject` | `feature/sessions/SessionsController.kt` 同名方法 | 项目列表刷新与手动创建（`manuallyCreated = true`，目录先展开）|
| `app/AgentsAnywhereApp.ets` 的 `reloadProjects`/`createProject` | `AgentsAnywhereApp.kt` 的同名 lambda | `projectsRequestVersion` 守卫 + `withPatchedProject` 合并权威行 |
| `entry/src/main/resources/rawfile/terminal/` | Termux `TerminalEmulator` + `RemoteTerminalView` | xterm.js 宿主页与三个 JS 资源（xterm.js、fit、serialize），无网络依赖 |

## 素材

`entry/src/main/resources/base/media/` 下的位图**直接取自** Android 的
`android/app/src/main/res/drawable-nodpi/`，文件名与内容都不改写，`$r('app.media.<原名>')`
即可引用；因此图标不需要「复刻」，只需把原文件搬过来。当前已搬运第一批（设备图、
附件来源、复制按钮、空状态插图、会话操作），第二批随对应页面一起搬。会话详情改成 iOS
的导航栏后，它的两个图标位改用 `AAIcons` 里的矢量，`ic_session_runtime_settings_*`
与 `ic_session_agent_button_*` 四张位图已无引用，随之删除。
Android 自带的 Lucide 矢量（`ic_user_key.xml` 等）不能直接使用，其 `pathData` 抄进
`ui/designsystem/AAIcons.ets`，由 `AAIcon` 以同样的 24×24 视图框、2dp 描边绘制。

应用图标（桌面分层图标 + 启动图）是唯一一处**派生**出来的素材，不直接搬文件、也不重画：
`tools/generate-app-icons.mjs` 以 Android 的 `drawable-nodpi/ic_launcher_foreground.png`
为唯一来源，零依赖地生成 `AppScope/resources/base/media/{background,foreground}.png` 与
`entry/src/main/resources/base/media/{background,foreground,startIcon}.png`——白色底
（对应 Android 自适应图标的 `@android:color/white`）加逐字节复制的原字形，启动图是同一
字形的 144² 圆角瓦片。要改图标就重跑这个脚本，不要手改 PNG。

`entry/src/main/resources/rawfile/` 存放**网页侧资源**：目前只有终端页
（`terminal/index.html` 与 xterm.js 5.5.0、`@xterm/addon-fit` 0.10.0、
`@xterm/addon-serialize` 0.13.0，均为 MIT）。它们随 HAP 一起打包，页面用
`$rawfile('terminal/index.html')` 打开，相对路径加载同目录的 JS/CSS，运行期不访问网络。
宿主页与 ArkTS 之间只通过两条通道通信：ArkTS 用 `runJavaScript` 调页面的 `window.__aa*` 函数，
页面用 `javaScriptProxy` 注册的 `aaBridge` 回调 `onData/onResize/onModes/onKeyboard/onReady`。

## 写代码时怎么判断放哪

可以用下面几个问题判断：

- 这段代码是在画界面，或者处理视觉交互吗？放 `ui`。
- 这段代码在决定哪些数据应该展示、怎么筛选、怎么排序吗？放 `feature`。
- 这段代码在请求后端或解析后端 JSON 吗？放 `api`。
- 这是多个功能都会用到的稳定 app 概念吗？放 `model`。
- 这段代码在读写本地存储吗？放 `storage`。
- 这段代码只是把 screen、controller、api 组装起来吗？放 `app`。
