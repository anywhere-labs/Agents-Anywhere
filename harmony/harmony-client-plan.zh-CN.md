# Agents Anywhere 鸿蒙客户端实现计划

> 说明：本文件在第 30 轮被 PowerShell 的 `Get-Content`/`Set-Content` 往返破坏了编码（只有本文件受损，所有源码与其它文档经检查完好）。原始文件里逐轮的详细记录已无法恢复，以下内容按当前代码与仓库事实重建：结构、阶段状态与差异条目都经过与代码比对，但不再包含丢失的逐轮流水账。
>
> **教训**：`.md`/`.ets` 等文本文件一律用文件工具读写，绝不经 PowerShell 字符串往返。

## 目标

在 `harmony/` 下实现一个原生 HarmonyOS NEXT（ArkTS + ArkUI，Stage 模型）客户端，作为现有 Android 客户端（`android/`）与 iOS 客户端的对等实现：页面、功能、文案、设计系统逐项对齐；Android 是功能超集，对齐 Android 即同时满足 iOS。

## 已确认的技术决策

- `bundleName = com.agentsanywhere.app`，`compatibleSdkVersion = 5.0.0(12)`，`targetSdkVersion = 6.1.0(23)`。
- 零第三方 ohpm 依赖：Markdown、代码高亮、diff 渲染都在仓库内自己实现，保证离线可构建、可验证。
- 终端是唯一例外：xterm.js（MIT）+ fit / serialize 插件打包进 `entry/src/main/resources/rawfile/terminal/`，由 ArkWeb 承载，运行期不访问网络。
- 传输层用 `@kit.RemoteCommunicationKit`（rcp）而不是 `@ohos.net.http`，因为 API 需要 PATCH。
- 静态门槛是 `hvigorw assembleHap`（含 ArkTS 类型检查与 lint）+ 仓库内两个校验脚本；DevEco 的 Code Linter 只能在本机 IDE 内跑，`code-linter.json5` 已提交。

## 工程结构

```text
harmony/
├─ AppScope/                 应用级清单与图标
├─ entry/src/main/
│  ├─ module.json5           能力、权限、OAuth deep link
│  ├─ resources/
│  │  ├─ base/ zh_CN/        764 条 Android 来源字符串 + 3 条 iOS 来源 + plural + 颜色 + 媒体（Android 位图原样搬运）
│  │  └─ rawfile/terminal/   xterm.js 宿主页与 JS/CSS
│  └─ ets/
│     ├─ api/                HTTP/WS 传输、URL 规则、DTO 解析
│     ├─ feature/            控制器与页面状态（不含 UI）
│     ├─ model/              共享模型
│     ├─ navigation/         AppDestination
│     ├─ ui/designsystem/    颜色 token、度量、图标、共享组件
│     ├─ ui/screens/         每个屏幕族一个目录
│     ├─ app/                组装根与依赖装配
│     └─ pages/Index.ets     入口能力加载的唯一页面
└─ tools/                    资源转换与校验脚本
```

## 与 Android 的机制对齐清单

- **导航**：Android 是一个 `AnimatedContent` + `AppDestination` 枚举，没有返回栈；本移植同样是"设置当前目的地"，枚举顺序即转场方向，系统返回由 `EntryAbility.onBackPressed` + `AppStorage` 路由到各屏自己的 `onBack`。
- **控制器形态**：`feature/` 的控制器接收当前状态并返回新状态（Kotlin 的 `copy()` → ArkTS 的 `Patch` 接口 + `readonly` 字段 + `copy(patch)`），屏幕持有 `@State`。
- **ArkUI 没有 `LaunchedEffect`**：需要"随状态变化重跑"的地方用 `@Prop @Watch` 的签名/版本号触发（新建会话页的 `devicesSignature`、详情页的 `forceLatestRequest` 等），这是本移植最主要的机制替换。
- **ArkUI 没有普通组件插槽**：需要 slot 的容器用 `@BuilderParam` + 尾随闭包（身份对话框已验证可用），其余情况把容器外壳在使用处展开。
- **资源**：764 条字符串由 `tools/convert-android-strings.mjs` 从 `android/.../values*` 生成，位置占位符重排为出现顺序；`tools/verify-resource-usage.mjs` 兜住编译器不查的 `$r(...)` 引用；位图从 `drawable-nodpi` 原样搬运，不重画。
- **实时通道**：dashboard 与 session 两条 WS 各有 ticket 获取、退避表与可中断等待，客户端 id 前缀为 `harmony-<uuid>`。

## 阶段划分与状态

### Phase 1 — 骨架与基础设施（已完成）

工程、清单、资源表、设计系统 token/图标/组件、`api/` 传输与 URL 规则、`storage/` 偏好、导航与组装根、两个校验脚本。

### Phase 2 — 首页与会话列表（基本完成）

已完成：`model/`、`api/Sessions*`、`SessionMappers`、`SessionsState`、`SessionsController`（加载/刷新/分页/重命名/固定/归档/批量）、`DashboardRealtimeController`、`HomeScreen`（46dp 头部、三个快捷入口卡、FAB、项目/会话两视图、空状态、下拉刷新、触底分页）、`HomeSessionActions`、`ArchivedSessionsScreen`、`ProjectSessionLoader`（30s TTL、3 并发、翻页去重）、`ProjectSessionsState`、`HomeProjectActions`、`ProjectSidebarPreferences`。

原"待做"里的新建会话状态层也已完成：`feature/sessions/NewSession{State,Workspaces,RuntimeInventory,RuntimeInventoryLoader,RuntimeSelectionState,PreferenceStore,Draft}`、`api/RuntimeIdentity`、`WorkspaceProjectResolver`、`SessionsController.createAndStartSession`（目录解析、项目解析/创建、75s 超时创建请求、断线后 `newCreateCandidates` 对账）。

待做：会话有效性在 `ON_START` 的复检、断网恢复时两个实时通道的立即重连。

### Phase 3 — 会话详情（基本完成）

已完成：`TimelineDtos`、`SessionDetailState/Reducer/Controller`、`SessionTimelineProjection`、`MarkdownParser` + `AgentMarkdownText`、`CodeLanguage` / `CodeTokenizer` / `AACodeColors` / `AACodeLines`（自研高亮，取色来自 Android 的 quietlight/darcula）、`DiffPreview`、`CodeBlockPanel`（复制按钮用 Android 位图）、`SessionScrollFollow`（正向列表 + 四条件跟随 + 400ms 自滚窗口 + 预挂载锚定）、附件全链路（选择器、上传校验 size+SHA-256、会话内附件条、远端图片、全屏 `Swiper` 查看器、未发送图片的独立查看器）、`SessionRuntimeSettingsSheet`、`SessionRuntimeControls`（通知与输入表单）、草稿会话（`local:new-session:<uuid>` 预览 + 首条消息创建 + 失败回填 composer）。

待做：
- 消息内文件路径点击（Android `onReferencedFile` 跳文件页并打开该文件）。行内文本用 `Span` 拼装，`Span.onClick` 不在 ArkUI 文档支持列表内，可靠做法是改用 `MutableStyledString` + `GestureStyle` 并重排行内装配，单列一轮。
- 相机：Android 是自绘拍照页，当前用系统照片选择器的拍照入口代替。
- 附件"用其它应用打开"。
- 轮末复制/分享页脚与分享链接对话框已完成：`buildAgentReplyActions` 逐轮分组（用户行开轮、工具行可作轮末、流式中不给动作、旧页从轮中开始也能开轮），页脚是 1dp 分隔线 + 30dp 圆形复制（Android 位图）/分享（lucide `square-arrow-out-up-right`）按钮；分享对话框两个作用域（本回复/整段会话）走 `POST /sessions/{id}/shares`，成功后交给系统分享面板。
- 斜杠命令与建议面板已完成：面板是 canvas@0.98 底、18dp 圆角、1dp 描边、10dp 内边距、行间距 4dp，四种状态（加载 / 错误+重试 / 无匹配 / 最多六行），每行 `/<id>  <title>` 加上描述（禁用时换成禁用原因）；`RuntimeCommands` 的 begin/apply/fail 用请求键丢弃过期答复，进入命令模式时惰性加载（`stale` 时复载），按 id 或别名大小写不敏感查表，`/cmd args` 解析后走 `POST /sessions/{id}/runtime/commands`，只有成功才清空 composer；命令模式下附件入口关闭。
- composer 草稿持久化已完成：按账号（`session-composer-drafts-<userId hash>`，与 Android 同名）按会话保存文本与附件；离开会话、重启应用后回来仍在；进程死亡时"上传中"的附件恢复为失败并给出提示（Android 的 `restore(uploadCancelledMessage)` 行为），恢复后立刻回写；发送成功清空，失败时文本与附件一起留存。
- 归档页骨架闪烁（Android shimmer，ArkUI 无对应组件，目前静态）。
- 字重复核：Android `SemiBold` 应统一为 `fontWeight(600)`，已改的用 600，其余页面待一次统一扫。

### Phase 4 — 设备 · 文件 · 终端（基本完成）

已完成：设备列表、设备详情（AGENTS/SESSIONS 两段、runtime 开关与删除、批量归档）、配对向导七步与轮询、设备操作 sheet 与五种确认对话框、文件浏览（路径栏、复制路径菜单、文本预览）、会话内文件/终端 pager（58dp 头部 + Files/Terminal 切换器 + 工作区为根的文件浏览 + 该会话的终端）、终端全链路（`terminals-v2` 建/列/关、WS 帧协议与 `seq` 去重、`fromSeq` 续传、重连与静默宽限、resize 防抖、CTRL/ALT 闩锁、Windows 丢弃私有设备属性应答、快捷键面板、屏幕快照回放）、新建会话页（五段配置卡 + 工作区选择 + 目录浏览 + setup 面板 + 首条消息创建链路）、新建项目与项目编辑器（`AppDestination.NewProject` → `projectOnly`；首页两处"新建项目"入口走项目编辑器而非会话选择器）。

顺带对齐的一处旧偏差：`choosePath` 打开目录浏览器时，Android 用 `effectiveWorkspacePath = if (choosePath) currentPath else selectedWorkspacePath` 作为启动目标（因此浏览器里"不点确认也能启动"），此前本移植 `canStart()` 允许但 `startSession()` 仍读旧的 `selectedWorkspacePath`，会出现"按钮可点却报未选工作区"；现已按 Android 取值。

待做：
- 文件内搜索已完成：46dp 搜索条（34dp 输入框 + 14dp 放大镜 + `当前/总数` 计数器 + 两个 30dp 圆形上/下按钮）、大小写不敏感的字面量扫描、命中高亮（普通命中与当前命中两色）、跳转循环、切换文件清空查询。**顺带修掉一个老 bug**：自研扫描器的 token span 不含 token 之间的空白，而渲染器只按 span 取子串，所以代码块与文件预览此前会丢掉所有空格（`constvalue=call(other);`）；现在按"span + 空隙"逐段渲染，不再丢字符。注意 Android 这里并不是正则搜索（`SearchOptions(caseInsensitive = true, useRegex = false)`），旧计划里写的"正则搜索"是记错了。
- 草稿会话的附件已完成：草稿期附件只读本地字节（`localDraftAttachment` 用 SHA-256 作 fileId，不上传），首条消息把字节按 inline part 随创建请求发送，失败时文本与附件一起回填 composer；入口开关取 `NewSessionDraft.attachmentsEnabled`。
- 消息的乐观更新未移植：Android 用 `addOptimisticMessage`/`markOptimisticMessage`/`bindOptimisticSession` 先把用户气泡画出来再对齐服务端；本移植发送后统一重新拉取时间线（见差异表）。
- 终端面板震动反馈（Android 每次按键触发 `LongPress`）。

### Phase 5 — 设置与收尾（进行中）

已完成：设置抽屉索引页（身份卡、外观、语言、侧栏显示、版本、检查更新、归档会话、退出登录）、账号子页与四个身份对话框（昵称 / 邮箱绑定含验证码 / 头像 256px data URL / 改密码）、语言经 `i18n.System.setAppPreferredLanguage` 应用、更新检查的决策层与 UI（`/health` 版本比较、按服务器记忆忽略版本、提示对话框、Updates 页、下载按差异表改为"打开下载页"）。

待做：
- 全量字符串复核已完成（有据可查）：Android 三份字符串文件（`strings.xml` 696 + `archive_strings.xml` 17 + `device_pairing_strings.xml` 52 = 765 个唯一名）与本工程 764 条的唯一差异是 `app_name`——它在鸿蒙只声明在 `AppScope`（见差异表）；`base` 与 `zh_CN` 两张表逐名对齐（764/764，无重名、无空值）。**第 40 轮追加 3 条 iOS 来源条目**（`ios_strings.json`，见第 11 条），因此现在是 764 条 Android 来源 + 3 条 iOS 来源。
- 无障碍标注已完成第一轮：把 Android 有 `contentDescription` 的图标按钮逐一对上（`BackIconButton`/`common_back`、首页 FAB/`home_new_session`、项目行新建会话/`home_new_session_in_project`、会话页复制与分享、命令面板、文件预览的搜索与复制、终端清屏、新建会话页的确认与目录折叠、设备详情的返回/操作/移除 agent、附件查看器的保存与关闭、设置页的更新红点、代码块复制）。共 13 处 `accessibilityText`（此前仅 2 处）。Android 留空（`null`）的装饰性图标保持不标注；代码块复制沿用了 Android 硬编码的英文 `Copy code`/`Copy command`。
- 无障碍标注第二轮已完成：配对向导的关闭按钮（`device_setup_close_content_description`）、附件查看器的缩略图按文件名标注。设备列表/归档页里 Android 用参数传入 `description` 的按钮，其标注文字与可见文本重复，按 Android 的做法不重复标注。
- 仓库文档挂接已完成：根 `README.md`/`README.zh-CN.md`/`README.en.md` 的"原生移动客户端"行都加上 HarmonyOS，`docs/README.md` 增加"鸿蒙构建"一行；`harmony/README.md` 补齐了构建产物、静态检查与验证习惯（可达性、Node 用例、文本文件编码规则），并**纠正了签名一节**——本机 `build-profile.json5` 带有 DevEco 生成的签名配置。
- `@kit.AssetStoreKit` 加固：把 access / refresh token 从 preferences 迁到加密存储。
- 抽屉进场动画：Android 从左侧滑入覆盖当前页，本移植是 Shell 内换页 + 淡入。
- 素材搬运（后续）：设置抽屉与拍照页用到的 `ic_profile_*`、`ic_devices_*`、`ic_sessions_*`、`ic_flip_camera_white` 随对应页面搬运。
- 仓库文档挂接：根 README 客户端表格、docs 索引。

## 已知差异与理由

| 项目 | Android | HarmonyOS | 理由 |
| --- | --- | --- | --- |
| HTTP 客户端 | OkHttp | `@kit.RemoteCommunicationKit`（rcp） | `@ohos.net.http` 的 `RequestMethod` 没有 PATCH，而 Server 的 session / project / connector 更新全用 PATCH；rcp 还支持单请求超时与自定义 multipart boundary |
| QR 扫码界面 | 自绘 CameraX 预览（286dp 取景框 + 四角括号 + 扫描线） | iOS 版式：380 高 / 32 圆角预览 + 白色 2pt 方框（宽 68%、圆角 24），相机画面由 `@kit.ScanKit` `customScan` 画进 `XComponent` 表面 | 用户在第 40 轮要求登录页改用 iOS 客户端的版式（见下一条）；取景框几何按 `QRCodeScannerView` 的 `addOverlay` 复刻。重复码限流沿用 Android 的 1200ms 窗口，payload 校验与 1600ms 轮询状态机不变；能力缺失或权限被拒时框内显示不可用，点按退回系统扫码器 |
| 登录页版式 | 32dp 边距 + 距顶 74/104dp 的 `返回` 药丸，标题在页面里，按钮是 56dp 圆角矩形 | iOS 版式：44vp 导航行（贴状态栏的返回字形）+ 34sp 大标题 + 22vp 内边距的滚动内容，按钮是 50vp 胶囊，输入是下划线式 | 用户在第 40 轮明确要求"布局改成 iOS 客户端的那种"，并选择了"连内部一起照 iOS 重做"；四个登录页（登录方式、选择登录服务、内嵌网页、扫码/等待）全部改用 iOS chrome（第 12 条起移到 `ui/designsystem/AAIosChrome.ets`），行为、状态机、回调与文案保持不变 |
| 终端实现 | Termux 原生 VT 模拟器 + 画布视图 | 内嵌 xterm.js + ArkWeb | 鸿蒙无等价组件；xterm.js（MIT）打包进 rawfile，离线可用。协议层完全一致 |
| 终端配色 | `applyTerminalColors` 覆盖背景/前景/光标，其余取 Termux 默认表 | 同一套取值写进宿主页主题 | 16 色 + 背景/前景/光标一致；xterm 的 216 色立方与灰阶与 Termux 同源，光标反白用 `cursorAccent = 背景色` 近似 |
| 终端字号/字体 | `setTextSize(12sp)` + `Typeface.MONOSPACE` | xterm `fontSize: 12` + CSS `monospace` | 字号一致；等宽字形由系统字体决定（鸿蒙无 Droid Sans Mono），字宽差异会让列数略有不同 |
| 应用光标/键盘模式 | 控制器直接读模拟器状态 | 宿主页在解析输出后比较 `term.modes` 并上报 | 模式只由输出流驱动，等价且不增加桥调用 |
| 快捷键序列 | 引用 Termux `KeyHandler`（AAR 内） | 按 v0.118.3 源码转写面板可达部分 | 只转写面板用到的 8 个键；翻页键忽略修饰键、带修饰键的 Home/End/方向键用 `ESC[1;n x` 等怪癖一并保留 |
| 终端文本选择 | Termux 自绘选择手柄 | xterm 自带选择与长按菜单 | 鸿蒙无等价自绘层；原实现的复制/粘贴回调本就是空实现 |
| 终端键盘可见性 | `WindowInsets.ime` | 宿主页 textarea 的 focus/blur 上报 | 页面输入元素的焦点就是 IME 的实际来源；面板 88dp 与 24dp 间距按原样排列 |
| 终端 401 | 同时检查握手 401 与关闭码 4401 | 只能观察关闭码 4401 | `@ohos.net.webSocket` 不暴露握手失败的 HTTP 状态码；4401 路径完整保留，其余按默认分支重连 3 次后 Closed |
| 终端二进制帧 | 监听器未实现二进制重载，静默丢弃 | 解码 UTF-8 后送同一解析器 | 不改变任何合法帧的行为，只是把原先静默丢掉的帧变成"能解析就处理" |
| URL 百分号编码 | `URLEncoder.encode` + `+`→`%20` | `encodeURIComponent` | 两者经服务端解码后等价，仅抓包可见差异；为全局一致未修改 |
| 实时 client id 前缀 | `android-<uuid>` | `harmony-<uuid>` | 服务端不校验前缀，保留平台可辨识性 |
| 应用内更新 | 下载 APK + `PackageInstaller` | 版本比较/忽略版本/提示保留，安装改为打开下载页 | 鸿蒙无 APK 安装流程；`UPDATE_DOWNLOAD_URL` 仍是占位地址，此时对话框报 `update_download_unavailable` |
| 凭据存储 | `SharedPreferences` | 暂用 preferences，Phase 5 迁移到 AssetStore | 保持 `hasAuthSession()` 同步语义，避免首版引入异步读失败面 |
| 代码高亮 | Sora Editor + TextMate + oniguruma | 自研轻量 tokenizer | 鸿蒙无等价库、零依赖优先；取色仍来自 Android 的两套 TextMate 主题，语言判定表逐条复刻 |
| Markdown 围栏 | `text.html.markdown` grammar | 不染色（仍按语言表注册） | 手写扫描器无法可靠复刻该 grammar，宁可不染也不染错 |
| 文件内搜索 | Sora `EditorSearcher`（`caseInsensitive`、非正则、循环跳转）+ 库内高亮色 | 自研扫描（`findFileMatches`/`cycleFileMatch`）+ 自绘高亮 | 语义逐条对齐：大小写不敏感、非重叠、逐行、循环、`当前/总数`；差异只在两处：高亮取本工程暖色而非 Sora 内置的品红默认值；跳转用"每行固定 15dp"的算术定位而不是 Sora 的 `ensureSelectionVisible()` |
| 代码行渲染 | Sora 按 span 绘制，空白由编辑器自身处理 | 逐段渲染"token span + 空隙" | 自研扫描器不产出空白 span，早期版本只取 span 子串会丢掉所有空格（`constvalue=call(other);`）；现在空隙作为 Plain 段补回，搜索命中跨空隙时也连成一段高亮 |
| 草稿会话附件 | 首条消息携带 inline bytes | 同左：草稿期只读本地字节（SHA-256 作 fileId，不上传），发送时转 inline part | 上一版"草稿期关闭附件入口"的记录作废；`attachmentsEnabled` 开关、读取校验、失败回填都与 Android 一致，只是"远端行"由本地字节拼出 |
| `app_name` 字符串 | `strings.xml` | 只在 `AppScope` 声明 | 模块级重复声明会被 restool 报名称冲突，两处取值相同 |
| 设置 sheet 数据来源 | 屏幕算好选项再传入 | sheet 直接读 `RuntimeSettingsState` 并在内部本地化 | ArkTS 无法把 `Resource` 塞进选项类型而不放宽类型约束；行为一致 |
| 两段式副标题 | `listOfNotNull(a,b).joinToString(" · ")` | 同一个 `Text` 内用 `Span` 拼 | `getStringSync(Resource)` 自 API 20 起废弃；分隔符与字号一致 |
| 设置行的乐观选中 | 点击即更新本地选中再发 PATCH | 只应用 Server 回显 | 少一次失败回滚路径 |
| 会话头返回键 | 无返回键（依赖系统返回） | 返回键 + 设置键同排 | 鸿蒙系统返回会退出应用而非回退该页 |
| 会话列表方向 | `LazyColumn(reverseLayout = true)` | 正向 `List` + `Scroller` | ArkUI 无反向布局；跟随语义逐条对齐，正向列表带来两处补偿（首个快照跳到末尾、加载上一页后重新锚定） |
| 自身滚动 vs 用户滚动 | `NestedScrollConnection` 只看 `UserInput` | 400ms 时间窗 | ArkUI 的 `onDidScroll` 不区分来源，布尔闩会在"位置未变不触发 onScrollStop"时卡死 |
| 附件 media type / 大小 | `ContentResolver` 查真实 MIME 与 `OpenableColumns.SIZE` | 按扩展名推导（40 项映射）+ `fileIo.statSync` | 选中的 URI 没有等价的类型查询接口；服务端校验照跑 |
| 拍照 | 自绘 CameraX 拍照页 | 系统照片选择器的拍照入口 | 鸿蒙无 CameraX 等价物；自绘拍照页列为保真项 |
| 远端图片加载 | Coil + Authorization + 缓存 | `HttpTransport.getBytes` → ImageKit `PixelMap` | 鸿蒙无 Coil；字节按需拉取，不做磁盘缓存 |
| 附件保存 | MediaStore 写相册 | 系统"另存为"对话框 | 鸿蒙没有免权限的相册写入 |
| 查看器容器 | `Dialog` + `HorizontalPager` | `bindContentCover` + `Swiper` | 语义等价；安全区内缩按原值 |
| 会话内文件/终端入口 | 会话详情页内 `HorizontalPager` | 独立 `AppDestination.Files`（传 `session` 时变成 pager 形态） | 只有一处 `AnimatedContent` 的导航模型，没有页内 pager；页面本体一致 |
| 消息内文件路径点击 | 行内路径可点 | 未接线 | `Span.onClick` 不在 ArkUI 文档支持列表内；需改用 `MutableStyledString` + `GestureStyle` 并重排行内装配 |
| 新建会话的 catalog 类型 | `feature/` 里另有一套 `NewSession*` 类型 + 映射 | 直接用 `api/` 的 `RuntimeModelCatalog` 等与 `findRuntimeCapability` | 字段集与语义完全一致，少一层纯转接；行为口径（fresh/stale、选择 id 优先级、能力可用性）逐条对齐 |
| 运行时配置 sheet | `DeviceRuntimeConfigureSheet` + `configureAndStartDeviceRuntime` 已定义但全仓库无调用点（死代码） | 未移植 | 忠实移植以"用户可见行为"为准；搬运不被调用的代码只会增加维护面。`DeviceRuntimeState.kt` 的草稿/校验部分同理未搬到 `feature/devices/` |
| 项目编辑器的目录槽位 | Compose 的 `@Composable ColumnScope.() -> Unit` 参数 | `@BuilderParam directoryContent` 尾随闭包 | ArkUI 的等价物就是这个装饰器；`.layoutWeight(1)` 由槽位内容自带，和 Android 在调用点加 `weight(1f)` 一致 |
| 项目名冲突对话框 | Material `AlertDialog` | `ProfileDialogFrame` + 两个 `ProfileDialogButton` | 与身份对话框同一基座（遮罩 + 20dp 圆角卡片），文案、按钮顺序与语义一致 |
| 新建项目 | `NewProjectScreen` + `projectOnly` | 已接线 | 上一版"未接线"的记录作废：`AppDestination.NewProject`、首页两处"新建项目"入口与项目名推导/冲突对话框均按 Android 实现 |
| 消息乐观更新 | `addOptimisticMessage` + `markOptimisticMessage` + `bindOptimisticSession`，用户气泡立刻出现 | 发送后重新拉取时间线，气泡在服务端写入后才出现 | 乐观行必须与随后的一致性读取对齐，否则会漂移；本移植选择"只信服务端"，代价是一次往返的可见延迟 |
| 草稿文档的字段 | `text`/`attachments`/`clientMessageId`/`retryAction` | 只写 `text`/`attachments` | 后两个字段只服务于乐观重试（见上一行）；读入时对缺字段的容忍与 Android 一致，所以两边互写的文档都能读 |
| 分享链接的落地方式 | `Intent.ACTION_SEND` + `createChooser` | `@kit.ShareKit` 的 `systemShare` 面板（`general.plain-text` 记录） | 鸿蒙没有 `ACTION_SEND`；系统分享面板是等价物。链接本身、作用域取值（`message`/`session`）、失败提示都一致 |
| 分享对话框的宿主 | 会话屏幕内的 `Dialog` | 应用根部 `Stack` 的覆盖层（与更新提示同一层） | 链接要跨重渲染存活，所以状态放应用；离开会话目的地时清除，等效于 Android 的"对话框随屏幕消失" |
| 命令目录的归属 | 存在屏幕 `state.commands` 里（会话切换即重建） | 存在屏幕的本地 `@State`，并用 `commandsSessionId` 记住归属会话 | 本移植的屏幕实例跨会话存活，所以用"归属 id 不符即视为空目录"来达到同样的效果 |
| 草稿会话里的命令模式 | `commandMode` 可能为真（能力集为空 → 面板显示不可用），但发送走普通消息分支 | 草稿会话不进入命令模式 | Android 的发送分支对 prepared session 直接跳过命令执行，展示面板只会导向一个发不出去的消息；本移植选择不展示 |
| 设置抽屉进场 | 左侧滑入覆盖当前页 | Shell 内换页 + 180ms 淡入 | 与"会话 pager → 独立目的地"同一取舍 |
| 身份对话框容器 | Material `Dialog` | 遮罩 + 卡片（`@BuilderParam` 槽位承载子内容） | ArkUI 无普通组件插槽；几何（20dp 圆角、18dp 内边距、14dp 间距）一致。注意：尾随闭包之后不能再链式 `.onClick` |
| 版本比较 | `BigInteger` 逐段比较 | 数字串比较（去前导零 → 比长度 → 字典序） | 对非负整数等价，不需要大数类型；`1.2.0rc1` 与 `1.2.0-rc1` 不相等、混合 token 按文本比较等怪癖一并保留 |
| 归档/更新页闪烁动画 | shimmer | 静态骨架 | ArkUI 无 shimmer 组件 |

## 验证方式

```powershell
$env:DEVECO_SDK_HOME = "C:\Program Files\Huawei\DevEco Studio\sdk"
node "C:\Program Files\Huawei\DevEco Studio\tools\hvigor\bin\hvigorw.js" `
  assembleHap --mode module -p product=default --no-daemon
```

`assembleHap` 执行完整的 ArkTS 类型检查与 lint，零错误即通过；产物为
`entry/build/default/outputs/default/entry-default-unsigned.hap`。运行期行为需要在 DevEco Studio 里用真机或模拟器验证（本仓库没有鸿蒙设备）。

每轮还必须通过两个仓库内脚本：

```powershell
node tools/verify-resource-usage.mjs   # $r(...) 引用在中英资源表中都存在
node tools/verify-encoding.mjs         # 无 BOM / 替换字符 / 乱码
```

构建之后还要跑第三个脚本，它兜住"写了但没接线"的文件：

```powershell
node tools/verify-reachability.mjs     # 每个 .ets 都能从 pages/Index 可达
```

它把源码树与 `sourceMaps.map` 对比：第 39 轮首次运行就找出 `AAWordmark.ets` 是孤文件（两个页面各自内联了同样的 `Text`，组件从未被引用，因此从未被类型检查），改为让两处调用该组件后可达性归零。

以及 `git status --porcelain -uall -- harmony` 中不含 `build/`、`*.hap`、`oh_modules/`。

补充经验：
- `clean` 之后立即 `assembleHap` 偶发 `es2abc` 读缓存失败（`Failed to read file to buffer: .../cache/.../pages/Index.ts`），原样重跑一次即成功。
- hvigor 只编译从 `pages/Index` **可达**的文件；新写的文件在接线前不会被类型检查，`entry/build/default/intermediates/loader_out/default/ets/sourceMaps.map` 可确认某个文件是否真的进了编译产物。
- 纯逻辑（tokenizer、scroll follow、路径规则、新建会话状态机、附件本地化、文件内搜索与渲染分段、轮末分享分组、命令匹配与解析、草稿编解码、终端帧处理、版本比较等）用 Node 用例跑真实 `.ets` 源码（`%TEMP%\aa-tok\prepare-*.mjs` + `check-*.mjs`）；十二个 `check-*.mjs` 合计约 615 条断言（`check-newsession` 202 条、`check-files` 84 条、`check-commands` 52 条、`check-composer` 39 条、`check-reply` 22 条），另加 markdown/tokenizer 用例。
- 用例的覆盖面有边界：只有"不依赖 UI 装饰器与平台模块"的模块能被这样加载，页面组件（`NewSessionScreen`、`NewProjectScreen`）里的状态机由上文的 ArkTS 类型检查 + lint + `sourceMaps.map` 可达性确认兜住，其依赖的纯函数（`availableProjectName`、`workspacePathKey`、`workspaceProject`、`resolveWorkspaceProject`）在 `check-newsession.mjs` 里逐条断言。
- **文本文件一律用文件工具读写**，不要经 PowerShell 的 `Get-Content`/`Set-Content` 往返：本文件第 30 轮就是这样被双重编码破坏的（GBK 解码丢字节 → 不可逆）。第 37 轮又犯了一次（`FilesScreen.ets` 的 5 个破折号变成替换字符、并混入一个 CRLF），用 Node 以显式 UTF-8 读写修复；源码与其它文档经检查未受影响。教训：批量改写源码只能用编辑工具或显式 UTF-8 的 Node 脚本，改完立刻跑替换字符扫描。

## 最终核对（第 39 轮）

从 `clean` 开始的完整构建与全部检查都通过，约束逐条核对如下：

| 约束 | 证据 |
| --- | --- |
| `bundleName = com.agentsanywhere.app` | `AppScope/app.json5`，并与 Android 的 applicationId 一致 |
| `compatibleSdkVersion = 5.0.0(12)` | `build-profile.json5` 的 products 段（`targetSdkVersion 6.1.0(23)`） |
| 零第三方依赖 | 两个 `oh-package.json5` 的 `dependencies`/`devDependencies` 均为空，无 `oh_modules` |
| 终端用内嵌 xterm.js + ArkWeb | `rawfile/terminal/` 五个文件（xterm.js 289KB + fit + serialize + css + 宿主页），页面与 JS 中无任何 `http(s)://` 请求 |
| 每阶段通过 `assembleHap` | `clean` 后全量构建 0 error / 0 warning；产出 `entry-default-unsigned.hap` 与 `entry-default-signed.hap` |
| codelinter | 本机 DevEco 无 headless CLI，规则集在 `code-linter.json5`，只在 IDE 内运行（见 `README.md`） |
| 资源与编码 | 三个脚本：611 处资源引用、170 个文本文件无 BOM/替换字符/乱码、152 个 ETS 文件可达性为 0 孤文件 |
| 与 Android 的文本对齐 | 字符串表 764 条（Android 来源），与 Android 三份资源的唯一差异是 `app_name`（只在 AppScope）；另有 3 条 iOS 来源条目（`ios_strings.json`，见第 11 条） |
| 设计 token 对齐 | 逐字节比对 `Theme.kt`/`Glyphs.kt` 的 52 个颜色字面量与 `AAColors.ets`：差异全部有解释——`#A1A1AA`（本工程 24 处内联）、`#ECECEA`（3 处）、`#18181B`（本工程写作带 alpha 的 `#1018181B`）、`#000000`（同）、`#F0EFEB` 是 Android 的 `UserBubble` 常量，Android 自己已不再使用（气泡实际读 `sessionMessageBubble`，与本工程一致） |
| 逻辑验证 | 十三个 Node 用例共 615 条断言（跑真实 `.ets` 源码） |

仍与 Android 不同、且已在差异表中逐条记录的功能：消息内文件路径点击、消息乐观更新、自绘拍照页、`clientMessageId`/`retryAction` 随草稿持久化；另有安全加固项（token 迁到 AssetStore）作为改进而非对齐项保留。

## 设备实测修正（第 40 轮）

真机跑通登录链路后修掉的三处偏差。

### 1. 内嵌登录页误报"加载失败"（`ui/screens/auth/ServerSetupScreen.ets`）

- **现象**：进入内嵌登录页后，服务端页面本身渲染正常（账号选择、授权确认都出来了），但页面顶部同时挂着一条红色 "Could not load the web login page."。
- **根因一**：`WebLoginPage.aboutToAppear()` 里手动调了 `controller.loadUrl()`。`WebviewController` 要等 `Web` 组件构建时才完成绑定，在 `aboutToAppear` 阶段调用会抛错，被 `catch` 写成了"加载失败"——而真正把页面拉起来的是声明式 `src`。现在 `src` 是唯一加载入口，`aboutToAppear` 整个删掉。
- **根因二**：`onErrorReceive` 没有像 Android 的 `SecureLoginWebViewClient.onReceivedError` 那样过滤 `request.isForMainFrame`，子资源（favicon、埋点、被拦截的信标）失败也会被判成整页失败。现在只有主框架失败才算失败。
- **顺带补齐的三处行为对齐**（原先都缺）：
  - 新增 `onSslErrorEventReceive`（该回调本身只针对主框架）→ `handleCancel()` 并报 "The server certificate could not be verified."，对应 Android 的 `onReceivedSslError`；绝不越过未通过校验的证书。
  - 失败不再在页内显示提示条，而是回到"选择登录服务"页并带出原因，对应 `WebLoginViewModel.reportWebError`（它只在 `WebLogin` 状态下生效，进入 `Exchanging` 后忽略）。
  - 拦截到 `agents-anywhere://oauth/callback` 后置 `callbackHandled`：这次拦截会中止正在进行的主框架导航，随之而来的中止错误不是加载失败。

### 2. 所有矢量图标小了约一个屏幕密度（`ui/designsystem/AAIcon.ets`）

- **现象**：登录页两个按钮的图标成了 ~6 vp 的小黑块，`返回` 药丸里的箭头、标题旁的 info 圆点同样只有应有尺寸的三分之一左右。
- **根因**：ArkUI 把 `Path.commands` 的坐标当作 **px**，不是 vp——`PathLayoutAlgorithm::MeasureContent` 直接用 `RSPath::GetBounds()` 当节点尺寸（`rect.GetRight()/GetBottom()`），`PathPainter` 也在同一坐标系里描边；`Shape` 的 `viewPort` 才是唯一的放大手段，而 `ShapeContainerPattern::ViewPortTransform` 用的比例是 `shapeContentSize / viewPort`（两边都是 px）。
  原来写的 `viewPort({ width: 24, height: 24 })` 是无单位数字，引擎按 **vp** 读，于是 `portPx = 24 * density`，比例塌成 `iconSize / 24`，24 px 的字形没有变回 vp——比应得尺寸小了整整一个 density。
- **判据（真机截图逐像素量取，density 由 56 vp 按钮实测 195 px 反推为 3.482 px/vp）**：渲染宽度 = `路径单位 × iconSize/24 + stroke × iconSize/24`。箭头（14 单位 / 16 vp）预测 13.97 px、实测 14 px；`qr-code`（18 单位 / 22 vp）预测 22.9 px、实测 ~23 px；`user-key`（19 单位 / 22 vp）预测 23.8 px、实测 23 px。三者同时吻合，模型确定。
- **修法**：把 viewport 用 **px** 声明（`'24px'`），比例就成了 `vp2px(iconSize) / 24`，24 px 的字形正好长到 `iconSize` vp；stroke 也改成同一坐标系的 px（`${strokeWidth}px`），于是两者一起被放大，屏幕上落回 Android 的 `strokeWidth × iconSize / 24`（22 vp 图标即 1.83 vp，与 Android 把 24 viewport 的矢量渲染到 22dp 完全一致）。**全程不需要读 density，它在比例里约掉了。**
- **排查范围**：全仓只有 `AAIcon` 用了 `Shape`/`Path`；扫码页的取景框用的是 `CanvasRenderingContext2D`（默认单位就是 vp）和 `Rect()`（几何来自 `width`/`height` 而非 commands），两者不受影响，已逐一确认。

### 3. 网页授权回调没人接（`ui/screens/auth/ServerSetupScreen.ets`）

- **现象**：在内嵌登录页点"授权"后什么也不发生；真机日志显示 `OnLoadIntercept result:1`，随后 `DidFinishNavigation has_committed=0 net_error=-3`、`OnLoadError ERR_ABORTED(-3)`，再没有任何 RCP 请求——授权码回来了，但没人去换 token。
- **根因**：`WebLoginPage.onLoadIntercept` 拦下 `agents-anywhere://oauth/callback` 后只把 URI 写进 `AppStorage`，唯一的消费者是根 `Column` 上的 `.onAreaChange(...)`。**拦截重定向不会改变任何布局**，`onAreaChange` 永不触发，回调就烂在存储槽里。（`ERR_ABORTED(-3)` 只是这次拦截中止了主框架导航，不是加载失败。）
- **修法**：改成 Android `WebLoginScreen` 的同一形状——子→父回调。`onLoadIntercept` 直接调 `this.onCallback(target)`；`ServerSetupScreen` 收到后先清空存储槽，再按 `WebLoginViewModel.handleCallback` 的语义处理：只在 `WebLogin` 状态且 `session !== null` 时继续换 token。`@StorageProp('oauthCallbackUri')` 保留并补上 `@Watch`，承接 Ability 冷启动与 `onNewIntent` 投递的深链（对应 Android 的 `onOAuthCallbackConsumed`），启动时也清掉残留值。

### 4. 桌面图标仍是 DevEco 模板（`tools/generate-app-icons.mjs`）

- **现象**：装出来的应用图标是模板的"蓝底 + 四个白色圆角方块"，不是 Agents Anywhere 的标。
- **根因**：三份图标素材全是模板原样——`foreground.png` 是不透明像素仅 16.2% 的四方块字形（456×456 @(284,284)），`background.png` 是模板蓝渐变 `#2C79F4`→`#0A59F7`，`entry/.../startIcon.png` 与模板逐字节相同（sha256 `567C7C0C…`）。分层图标一直"能装能显示"，只是显示的是模板。
- **修法**：新增零依赖的 `tools/generate-app-icons.mjs`（自带 PNG 解码/编码），以 Android 的 `drawable-nodpi/ic_launcher_foreground.png` 为唯一素材：`background.png` = 1024² 纯 `#FFFFFF`（对应 Android 自适应图标的 `@android:color/white`），`foreground.png` = 该位图**逐字节复制**（摘要 `5ebd783a2be1d699`，Android/AppScope/entry 三处一致，没有重画任何一笔），`startIcon.png` = 144² 圆角 36 的白底瓦片 + 面积平均缩到 96² 的字形（与 DevEco 模板的 144/半径 36 同规格）。Android 的字形占画布 49.9%，介于 DevEco 自己的 44.5% 与 iOS 的 ~67% 之间，所以"整幅"与"出血裁切"两种遮罩约定下都读得正；`start_window_background` 是 `#FFFFFF`，白瓦片在启动页上与 Android 的白色自适应底一致。

### 5. 扫码登录页取景框是个空盒子（`ui/screens/auth/QrAuthScreens.ets`、`module.json5`）

- **现象**：点"扫码登录"后只有一个大圆角空框，没有相机画面、没有角标、也没有扫描线。
- **根因（三条叠加）**：取景框底色是 `raisedSurface`（白），白色角标在白底上本就不可见；旧实现把手势交给系统扫码器，框内没有任何画面；扫描线在 `aboutToAppear` 里用 `animateTo` 改状态——那是首次布局**之前**，值被当成终值直接应用，线一出生就落到框外，何况 `translate` 是叠加在 Stack 居中位置上的，坐标也对不上。
- **修法**：按用户选择改为内嵌取景框，逐项对齐 Android：
  - `module.json5` 声明 `ohos.permission.CAMERA`（`reason` 复用既有 `qr_camera_access_needed` 文案，`usedScene` 指向 `EntryAbility`），对应 Android 清单里的 `android.permission.CAMERA`；运行时 `requestPermissionsFromUser` 申请，拒绝时按 Android 显示 `qr_camera_permission_required` 提示条。
  - `customScan` 把相机画面直接画进 286 vp 的 `XComponent({ type: XComponentType.SURFACE })`；`viewControl` 用 px（`vp2px(286)`）。用的是 **callback 重载**：连续扫码的官方做法是 `customScan.rescan()`，而华为 FAQ 明确写着它只在 `start(viewControl, callback)` 的回调里有效、Promise 方式无效。于是每次回调结束（包括拿到但不提交的码）都 `rescan()` 重新武装，等价于 Android 常开的 image analyzer；同一码用 Android `QrEmissionGate` 的 1200 ms 窗口限流，避免旧码空转登录接口。
  - 角标另起 `Canvas`（inset 26、臂长 22、线宽 2.3、白色，端点与 Android 的 8 条 `drawLine` 等价）；扫描线改成 `Stack({ alignContent: TopStart })` 里的 `Rect`，`translate({ x: 24%, y })` 从 y=26 扫到 y=260，颜色 `#4F7BFF`、粗细 1.6，动画改到 `onAppear` 里启动（`iterations: -1` 循环）。
  - 一并纠正的 Android 细节：取景框去掉自造的 1 vp 描边（Android 只有底色 + 22dp 圆角裁切）、框内提示内边距 24→28、帮助列间距 12→6、错误提示条移进帮助列并加 `padding(top: 8)`、帮助标题字重 Bold→`600`（Android 是 SemiBold）。
  - 系统扫码器降级为**点按取景框**时的兜底（无 ScanKit 能力 / 权限被拒 / 表面启动失败），这些设备原本只会拿到一个死框。
  - 顺带修掉等待页的监视器图标：Android 是 64×52 的盒子按 Fit 画成 52×52、颜色 `colors.ink`，原来是 64 且用了 `inkSoft`。

### 6. 所有页面被顶上留白压低了约 98 vp（`entryability/EntryAbility.ets`、`app/AgentsAnywhereApp.ets`）

- **现象**：扫码页与"选择登录服务"页的 `返回` 药丸明显偏低，不在顶部导航栏的位置。
- **量取**：从两张真机截图（1280×2832，density 3.482）逐像素找非背景行带，两个页面的药丸都在 y=[735..860] px，即中心 229 vp、顶部 211 vp。两页的顶部内边距分别是 74 vp（`AUTH_WEB_TOP`），因此药丸之上还有 137 vp 的额外偏移——正好等于状态栏高度被当成 vp 用了一次。
- **根因**：`configureWindow` 把 `getWindowAvoidArea(TYPE_SYSTEM).topRect.height`（**px**，本机 137 px ≈ 39 vp）直接写进 `AppStorage`，而消费端 `Blank().height(this.statusBarHeight)` 与各处 padding 都按 **vp** 解释。于是状态栏内边距被放大 3.482 倍（39 vp → 137 vp），`ScreenScaffold` 的等价物把每个页面都往下推了约 98 vp。Android 的 `WindowInsets.statusBars` 是 px 转 dp 后使用的，所以这是纯移植错误，不是设计差异。
- **修法**：一，在 Ability 里除以 `display.getDefaultDisplaySync().densityPixels`，把 **vp** 写进存储（所有既有消费端不改即正确，含附件查看器的 `statusBarHeight + 68` 等）；二，把 shell 的 `Blank()` 占位换成 Column 自身的 `.padding({ top })`——Compose 的 `windowInsetsPadding` 是**缩小内容框**，而占位子组件只会把 `height('100%')` 的页面推下去、并让底部被裁掉同样多。修完后药丸顶部＝39 + 74 = 113 vp，与 Android 的"状态栏＋74dp"逐像素同高。
- **顺带补齐的 `HostChoicePage` 对齐**（对着 `WebLoginScreen.kt` 的 `HostChoiceScreen`）：info 图标改到提示文字行首（Android 是 `Row(Icon, Text(padding start 9))`，原来错放在标题右侧）、标题字重 Bold→`600`、标题块内间距 8→10、药丸与标题之间补 30、标题与错误条之间补 30、错误条之后补 18（Android 的 `Spacer` 节奏）、自建服务表单改回 Android 的 24/12 两层间距并把"连接服务器"按钮放进表单列内、`OrDivider` 间距 10→12。
- **授权回调失败现在可定位**：`parseWebLoginCallback` 在 state 不匹配时按**长度**记录两侧（0 表示参数没回来，非 0 表示这一次授权对应的是另一次会话；值本身是一次性 CSRF 密钥，不入日志），`onLoadIntercept` 记录回调里是否带 `code`/`state`（不记值）。

### 7. 登录后首页"任何东西都点不动"（`ui/screens/home/HomeScreen.ets`）

- **现象**：登录成功进入首页（项目视图）后，头部、三个快捷入口、项目行全部点不动——页面能正常渲染，但像一张图。
- **根因**：ArkUI 的 `HitTestMode.Default` 语义是"自身与子节点参与命中测试，**并阻塞被它遮挡的其它节点**"（SDK `enums.d.ts` 原文：*block hit test of the other nodes which is masked by this node*）。首页根 `Stack` 的第 4 个子节点是悬浮按钮的包装容器：`Column().width('100%').height('100%')`，虽然只画了右下角一个按钮，却覆盖了整屏，于是把下面整个内容列（头部、快捷入口、`List` 里所有行）的触摸全部吃掉。之前没暴露是因为登录链路一直没通，这是第一次进到首页。
- **修法**：给该包装容器加 `.hitTestBehavior(HitTestMode.Transparent)`（自身与子节点照常响应、不阻塞被遮挡的兄弟节点，正是 `SessionDetailScreen` 的头纱已经在用的模式）；顺带把 toast 宿主也改成 `Transparent`，否则 toast 可见时会吞掉它左右两侧的点击。
- **同类排查**：写了一次性脚本扫全仓"作为 `Stack` 子节点的满屏容器"（含 `.width('100%')`/`.height('100%')` 正反序与 `size({...})` 写法），逐个核对后确认其余满屏节点要么是页面根、要么是应当吃点击的模态浮层（`ProfileSettingsDrawer` 的确认框、`AttachmentViews` 的全屏查看器、`AddDeviceScreen`/`DeviceConfirmDialog` 等），`TerminalContent` 的终端 ArkWeb 也在满屏 Column **之下**（首个 `Stack` 子节点），不受影响。脚本用完即删。

### 8. 首页与 Android 的可见差异（`HomeScreen.ets`、`HomeSessionRow.ets`、`common/AppEmptyState.ets`）

对着 `HomeScreen.kt` / `HomeProjectComponents.kt` / `HomeLists.kt` / `HomeProjectSessionRow.kt` 逐项核对并改正：

- **区块头**（`AASectionHeader` 对齐 `HomeListSectionHeader`）：原来把"新建项目"当文字按钮画在右侧、箭头在最右，且标签被强制大写。Android 是「标签 + 16dp 箭头」构成左侧可点区（13.2sp **ExtraBold**，`colors.faint`，**不大写**），右侧是两个 38dp 圆形图标按钮：`···` 打开**会话状态过滤菜单**、`+` 新建项目。
- **项目行**（对齐 `HomeProjectRow`）：间距 12→10、补 `padding(vertical 4)`；右侧两个按钮用 38dp 圆形热区包 19dp 字形（原来直接放 18dp 图标、顺序还是"铅笔在前"），而 `···` 打开的是**项目操作菜单**（原来错接成了过滤菜单），`铅笔` 才是"在该项目中新建会话"（保留 Android 的无障碍文案 `home_new_session_in_project(name)`）。
- **列表分隔线**：Android 的分隔线画在**会话行内部**（`HomeSessionRowShell`，1dp `#E9E8E5`/`#27272A`，最后一枚置顶行不画），项目行与区块头之间没有线。原来用的是 `List(...).divider(...)`，导致每个项目行下面都多了条线——现在改成行内自绘，并去掉列表级分隔线。
- **会话行**（对齐 `HomeSessionRowShell`/`SessionRowLeading`/`SessionRowTrailing`）：补 `padding(vertical 4)` 与 20dp 前导盒（忙碌转圈/未读点，否则 14dp 列表字形）；**等待审批的药丸从左侧挪到右侧**（Android 的 `SessionRowTrailing`），时间戳 10.8sp monospace SemiBold（`Bold`→`600`）；标题统一 16sp Bold + lineHeight 20（原来"最近会话"是 15sp Medium）；项目视图里置顶会话改用 `HomeProjectSessionRow(inset = false)`（44dp、指示器在右）。
- **快捷入口**（对齐 `QuickEntryCard`）：从"图标与文字居中"改为 Android 的**左上对齐**（`padding(12,13)` + 6dp 间距），图标用 Android 写死的 `#8E8E8E`/`#9A9A9A`（不是 `colors.faint`），文字色 `ink`。
- **头部与悬浮按钮**：头部两个圆形按钮的图标色改为 Android 写死的 `#1C1C1E`/`#FAFAFA`；悬浮按钮去掉自造的阴影（Android 的 `FloatingHomeButton` 没有 elevation，只有按下缩放 0.94）。
- **项目展开后的三种占位**：重试行 `top/bottom` 6→10、空会话文案改成 42dp 盒 + 38dp 缩进 + `600` 字重（对齐 `HomeProjectTreeItem` 的 48dp 转圈盒与 42dp 空态盒）。
- **仍存的已知差异**（未做，等确认）：快捷入口 0.975、悬浮按钮 0.94 的**按下缩放**反馈，以及贯穿全仓的触感反馈（`performHapticFeedback`）在鸿蒙侧尚未接入。

### 9. 设置页显示 `[object Object]`（`common/AAResources.ets` 及 12 个文件）

- **现象**：设置抽屉里"外观 / 语言 / 侧边栏显示"的右侧取值、以及外观与侧边栏的弹出菜单项，全部渲染成 `[object Object]`。
- **根因**：`$r(...)` 返回的是给 ArkUI 用的 `Resource` 描述符（`{ id, type, params, bundleName, moduleName }`），**不是字符串**；对它调 `.toString()` 得到的就是字面量 `"[object Object]"`。移植时把 `.toString()` 当成了"取出本地化文案"，全仓共 80 处这么写，覆盖设置页取值与菜单、新建会话页大量标签与错误文案、文件页/终端页的失败与状态文案、账号页与各类对话框的兜底文案、`systemShare` 标题、`NewSessionPathSection` 的描述等。
- **修法**：新增 `common/AAResources.ets`：`installResourceManager(manager)`、`resolveString(resource)`、`resolveStringWith(resource, args)`（带 `%s` 占位符的资源）与 `resolveText(value: ResourceStr)`（字符串原样返回，资源则解析）。入口 `EntryAbility.onCreate` 把 `this.context.resourceManager` 注入进去——普通函数拿不到 `getUIContext()`，而全局 `getContext()` 已废弃、会破坏"0 warning"；`resolveString` 走的是 `getStringSync(resId)` 这个未废弃的重载（带 `Resource` 参数的重载已标记 deprecated）。随后用一次性脚本把 12 个文件里的 `$r('app.string.x').toString()` 批量替换为 `resolveString($r('app.string.x'))`，两处带占位符的改成 `resolveStringWith($r(...), [args])`，四处 `ResourceStr.toString()` 改成 `resolveText(...)`，并按相对路径补上 import；脚本还顺带校验了注入的 import 不会落进多行 import 块内部（`NewSessionPathSection`、`SessionDetailScreen` 各中过一次，已修）。脚本用完即删。
- **同类甄别**：`api/HttpTransport.ets` 的 `response.toString()` **不是**这类问题——`rcp.Response.toString()` 是 SDK 的"把 body 转成 UTF-8 字符串"接口（`@hms.collaboration.rcp.d.ts` 原文：*Converts body to UTF-8 string, returns null if body is not in UTF-8 format*），已核对保留。全仓没有 `$r(...)` 参与字符串拼接或模板插值的写法，`.toString()` 是唯一的错误路径。
- **顺带**：设置抽屉的"外观"与"侧边栏显示"两行补上 Android 的 `ChevronsUpDown`（新增 `AA_ICONS.CHEVRONS_UP_DOWN` = lucide `m7 15 5 5 5-5 m7 9 5-5 5 5`）。Android 这两行是 `showChevron = false` + `trailingIcon = ChevronsUpDown`，只有"语言"行是 chevron；此前三行里只有语言带了箭头，看起来像少画了图标。

### 10. 登录相关页面改为 iOS 客户端的布局（新增 iOS chrome 组件 + 四个页面）

用户决定（第 40 轮）："返回按钮还是太低了……" → 选择"连内部一起照 iOS 重做"。于是登录链路里的这几个页面改用 iOS 客户端的版面语言，而**页面行为、状态机、回调与文案一律不变**（文案继续用本工程两张语言表，不引入 iOS 的英文原文，这样与安卓客户端的中英措辞保持一致）。

- **新增 iOS chrome 组件**（第 12 条移到 `ui/designsystem/AAIosChrome.ets` 并改名 `AAIosPage`/`AAIosPrimaryButton`/`AAIosGlassButton`/`AAIosField`），逐项对应 iOS 的 `Views/Auth/AuthLayout.swift`、`Views/Components/AppGlassButton.swift` 与 `ManualLoginView.swift` 里的 `ServerAddressView`：
  - `AuthScreen`：44vp 导航行（返回 glyph 22dp 贴在 leading、44×44 热区，整行只有字形没有药丸底色）→ 大标题（34sp bold、行高 41、左右 22vp）→ `Scroll` 内 28vp 节奏的内容列（副标题在前，左右 22vp / 顶 22vp / 底 34vp）。`scrollable: false` 给内嵌网页页用（网页不能塞进滚动容器）。
  - `AuthPrimaryButton` / `AuthGlassButton`：50vp 胶囊、17sp semibold、图标 18dp、间距 10（对应 `AppGlassButton` 的 `HStack(spacing: 10)` + `.controlSize(.large)` + `.capsule`）。prominent = `primaryAction` 底 + `onPrimaryAction` 字（即 `primaryControlBackground/Foreground` 的黑白互换）；regular = glass 材质的平面等价物，用 `AppTheme.groupedFill`（黑 4% / 白 6%）+ `secondaryControlStroke`（黑 14% / 白 22%）细边。加载态用 20dp `LoadingProgress` 顶替文案（对应 `ProgressView` overlay）。
  - `AuthUnderlinedField`：iOS 的下划线输入（`UnderlinedTextField`）——无底色无边框、20sp `title3`、上下 11dp、底部 1dp `Divider`；`@Link` 双向绑定，与 `AuthInputRow` 同款用法。
- **页面改动**：
  - `ServerSetupScreen.HostChoicePage`：大标题 + 副标题（原来的"ⓘ 提示行"按 iOS 收进副标题位），Cloud 用 prominent + 新增的 `AA_ICONS.CLOUD`（lucide `cloud`，对应 SF `cloud`），自建用 glass + `server` 图标；自建表单展开后是"iOS 副标题 + 下划线输入 + prominent 继续按钮 + 脚注"。原 Android 的 `OR` 分隔线、重复的区块标题、`AuthInputRow` 与 `AuthActionButton` 一并删除。
  - `ServerSetupScreen.WebLoginPage`：导航行（只留返回字形、无标题）+ 整屏网页。
  - `QrLoginScreen`：大标题"扫码登录" + 副标题（原帮助列），取景框改为 iOS 的 **380 高 / 32 圆角**，框内是 iOS `ScannerViewController.addOverlay` 的**白色 2pt 圆角方框（宽 68%、圆角 24）**；`customScan` 的 `viewControl` 相应改为读 `getXComponentSurfaceRect()` 的真实 px 尺寸（预览不再是正方形，旧的 `vp2px(286)` 正方形假设作废）。
  - `QrWaitingScreen`：大标题仍是原来的动态状态文案，内容是 iOS `QRWaitingStepView` 的"58dp 桌面图标 + 状态/错误行 + 大转圈"，上下各 24vp。
  - `LoginMethodsScreen`：对应 iOS `ServiceEntryView` 的欢迎版式——wordmark 锁定区居中、28dp 节奏、两个胶囊（扫码 prominent、账号密码 glass）。
- **取舍留档**：被替换掉的安卓版取景框参数是 286dp 框 / 圆角 22 / 角标 inset 26 + 臂长 22 + 线宽 2.3 白色 / 扫描线 `#4F7BFF`、1.6dp、x 24%–76%、y 26–260、1800ms `FastOutSlowIn` 无限循环；要换回安卓观感按这组数字复原即可（`harmony/` 尚未进版本库，故在此留档）。iOS 框内的"Scan Agents Anywhere QR"与底部"Point the camera at the web QR code"胶囊没有对应文案，未引入——说明改由页面副标题承载。
- **仍未做**：iOS glass 按钮的系统级按压反馈；本工程只保留了禁用态与加载态。

### 11. 设置页改为 iOS 版式（第一批）（`ui/screens/profile/ProfileSettings*.ets`）

用户第 40 轮追加要求：「把内部页面也改成跟 ios 一样」，并选择"两者都做"——先补齐登录页剩余细节，再分批改登录后的页面。这一批是设置那一组。

- **补齐登录页细节**：按 iOS `QRScanStepView` / `QRCodeScannerView` 补上取景框内的白色提示「扫描 Agents Anywhere 二维码」与底部说明胶囊「将摄像头对准 Web 上的二维码」，两条文案取自 iOS 的 `Localizable.xcstrings`（英文 + zh-Hans 原样搬入 `entry/src/main/resources/*/element/ios_strings.json`）。
- **新增 iOS 来源文案文件**：`ios_strings.json`（base + zh_CN）目前含 `qr_scan_frame_hint`、`qr_scan_caption`、`settings_section_app`（iOS 的 "App"/"应用" 分组标题）。**单独成文件**是因为 `app_strings.json` 由 `tools/convert-android-strings.mjs` 从 Android 的 XML 重新生成，手改会被覆盖；`verify-resource-usage.mjs` 会读取 `element/` 下的每一个 JSON，所以照常纳入校验。字符串表因此从"与 Android 逐名对齐的 764 条"变成 764 + 3 条 iOS 来源条目，Phase 5 那条复核结论已相应更新。
- **组件层**（`ProfileSettingsComponents.ets`，对应 iOS `Views/Settings/SettingsComponents.swift`）：
  - `ProfileHeader` 改成 iOS 的 **inline 导航栏**：44vp 高、返回字形贴 leading（44×44 热区、无圆底），标题居中 17sp/600（原来是 64vp 高 + 带边框的圆形按钮）。
  - `ProfileRow` 对齐 `SettingsRow`：**去掉 34dp 图标盒**，符号 17dp 直接贴在行首、标题 17sp regular（iOS 的 `.body`，原来是 16sp semibold）、取值 15sp 次要色、chevron 14dp、行高 48/56、左右内边距 16；新增 `destructive` 让退出登录行整行用错误色（iOS 的 `Button(role: .destructive)`）。
  - 新增 `SettingsGroup`：`List(.insetGrouped)` 的等价物——可选的大写小标题 + 12dp 圆角、无边框卡片；分隔线 `ProfileDivider` 的缩进改为 45/16（对齐到文字列）。
  - `SettingIcon`（Android 的 34dp 图标盒）与独立的 `SignOutCard` 卡壳删除，退出登录改用 `ProfileRow` 的破坏性样式。
- **抽屉索引页**（`ProfileSettingsDrawer.IndexContent`）重排为 iOS 的分组：身份头（60pt 头像 + 20sp/600 账号名 + 邮箱 + 角色，无卡片底、可点进账号页）→ `账号` 组（昵称/邮箱/更换头像/修改密码，全部沿用既有字符串与既有对话框）→ `应用` 组（外观/语言/侧边栏显示，改动只是把 `bindMenu` 直接挂在行上）→ 无标题组（已归档会话/检查更新）→ 退出登录 + 页脚 `Agents Anywhere · v…`。版本不再单独占一行（iOS 放在页脚）。
- **行为不变**：仅版面与分组；外观/侧边栏仍用原有弹出菜单、语言仍进语言页、更新行仍按"已知版本则弹提示、否则进更新页"。

### 12. 设置子页与共享 chrome（第二批）（`ui/designsystem/AAIosChrome.ets`、`profile/`、`update/`）

- **chrome 提升到设计系统**：`ui/screens/auth/AuthChrome.ets` 移到 `ui/designsystem/AAIosChrome.ets`，导出改名为与登录页无关的通用名：`AAIosPage`（原 `AuthScreen`）、`AAIosPrimaryButton`、`AAIosGlassButton`、`AAIosField`。后面的批次（首页/会话详情/设备/文件/终端）都要用同一套 iOS 导航栏与按钮，放 `ui/screens/auth/` 下会造成设置页反向依赖登录页。三个登录页的 import 与用法同步更新；移动是脚本做的，脚本顺带把文档里 `AuthScreens.kt`/`QrAuthScreens.kt` 误改成了 `AAIosPages.kt`，已改回。
- **账号页**（`ProfileAccountPage.ets`，对应 `AccountSettingsSheet` 的账号区）：删掉本地的 `AccountInfoRow`/`AccountActionRow` 两个 Android 行组件，改成「身份头（60dp 头像 + 20sp/600 账号名 + 邮箱 + 角色，可点换头像）+ `账号` 组（昵称/邮箱/角色三条 `LabeledContent` 式取值行）+ 操作组（改昵称/绑定邮箱/改密码）+ 退出登录组」。
- **语言页**：卡片换成 `SettingsGroup`，行改成 iOS 的 17sp regular + 17dp 勾选，分隔线用统一缩进（不再逐处传 `insetStart/insetEnd`）。
- **更新页**（`update/AppUpdateDetailPage.ets`）：新版本卡片改成「`SettingsGroup` 承载标题/说明/下载不可用提示 + `AAIosPrimaryButton` 立即更新」；空态改成居中的 17sp 次要色说明 + `AAIosGlassButton` 重试。
- **身份对话框**（`ProfileDialogs.ets`）：本工程保留对话框这一交互（导航不变），但内部改成 iOS 表单语言——字段由 14dp 圆角盒子改成**下划线式 plain 字段**（17sp、上下 18dp、底部 1dp 分割线），按钮改成 iOS 胶囊（50dp/25 圆角/17sp 600，主要=黑白实心、次要=glass 平面等价物），对话框卡片去掉 Android 的 1dp 描边。
- **清理**：`ProfileSettingsSupport.profileCardBorder` 在最后两个使用者移除后已无引用，删掉；`SettingIcon`、`AccountInfoRow`、`AccountActionRow` 一并删除。

### 13. 首页与会话详情改为 iOS 版式（第三批）

- **首页/会话列表**（`ui/screens/home/HomeScreen.ets`、`HomeSessionRow.ets`、`common/AppEmptyState.ets` 的 `AASectionHeader`），对照 iOS 侧栏 `ChatShell/ChatSidebarView.swift`：
  - 顶栏：iOS 的 `ChatSidebarHeaderView` 只有 wordmark（24sp、leading、44dp 行）；本工程保留搜索入口，但把它和账号入口从 Android 的描边圆形按钮改成**裸字形 44dp 热区**（`ChatSidebarIconControlStyle`）。
  - 快捷入口：结构保留（iOS 把设备放在自己的侧栏段里，没有卡片），外观改用 iOS 卡片语言——12dp 圆角、无描边、标题 15sp/600。
  - 区块标题（`AASectionHeader`）：13.2sp ExtraBold 大写 → iOS 的 **15sp semibold 次要色、不大写**，箭头 16→12dp，右侧图标按钮 38dp 圆 → 44dp 方（`ChatSidebarIconControlStyle`）。
  - 会话行（`HomeSessionRow`）：去掉 Android 的前导 20dp 指示盒、行高 52/66→42/56、标题 16 Bold→**17sp regular**、副标题 11.2 Medium→12 次要色；状态指示改成 iOS 的 `ChatSidebarSessionIndicator`——等待批准是 **11sp 薄荷色胶囊**（原来是白底药丸）、运行中是 14dp 迷你转圈、未读是 **8dp 绿点**；行分隔线全部去掉，改为 `List({ space: 6 })` 的 iOS 间距（iOS 的侧栏用间距而不是线）。
  - 项目行（`ProjectTreeItem`）：行高 56→44、文件夹字形 21→18dp 且用 ink、名称 16 Bold→17 regular、右侧只保留 **44dp 的新建会话按钮**（iOS 的项目行没有 `···`，项目操作走长按上下文菜单 = 本工程的长按浮层）。
  - 底部控件：Android 的 54dp 圆形 FAB + 顶栏账号按钮 → iOS 的 `ChatSidebarBottomControls`——左侧 **prominent 胶囊「新建会话」**（图标 + 文案），右侧 **38dp 圆形账号按钮**（iOS 放头像，本工程 shell 里没有头像，用账号字形代替）；列表底部留白按 iOS 的 82dp。
- **会话详情**（`ui/screens/sessiondetail/SessionDetailScreen.ets`），对照 iOS `Chat/ChatPageToolbar.swift`：
  - 头部从"浮在时间线之上的 58dp 药丸 + 两个圆形位图按钮 + 88dp 渐变头纱"改成 iOS 的 **inline 导航栏**：44dp 行、返回字形贴 leading、中间是 17sp/600 标题 + 12sp 次要色状态行（运行时 · 工作区，运行中带迷你转圈）、右侧两个裸字形按钮（模型配置、文件/终端）。iOS 原文明确 "no header view sits in the timeline"，所以头纱删除、时间线从栏下方开始，Android 的 74dp 顶部占位也一并去掉。
  - 顺带删掉两处死代码：`SettingsButton`（旧头部第二个入口）与四张已无引用的位图 `ic_session_runtime_settings_{light,dark}.png`、`ic_session_agent_button_{light,dark}.png`（`ARCHITECTURE.md` 的素材一节已记录）。
  - **仍待做**：时间线本身的行样式、气泡与 composer（iOS `Views/Chat/*`）——留到下一批，与设备/文件/终端一起。

### 14. 设备 · 文件 · 终端改为 iOS 版式（第四批）

iOS 把这三个界面都做成 **sheet**，其 chrome 是 `.navigationBarTitleDisplayMode(.inline)`（居中 17sp/600 标题）+ inset-grouped 内容。新增共享组件 `AAIosInlineBar`（`ui/designsystem/AAIosChrome.ets`）承载这套 inline 导航栏：leading 是裸返回字形（44dp 热区）、中间是标题 + 可选 `navigationSubtitle`（12sp 次要色）、trailing 由调用方通过 `@BuilderParam` 填充（`trailingSlots` 让标题保持居中）。

- **设备列表**（`devices/DevicesScreen.ets`）：Android 的 40dp 描边圆形返回 + 左对齐粗体标题（64dp 行）→ `AAIosInlineBar`。
- **设备详情**（`devices/DeviceDetailScreen.ets`）：25sp/800 的设备名 + 在线状态标签 + 两个圆形按钮 → inline 导航栏，标题是设备名、`navigationSubtitle` 是 `devices_online`/`devices_offline`、trailing 只留操作菜单字形。顺带删掉因此无引用的 `RoundIconAction` 组件。
- **配对向导**（`devices/AddDeviceScreen.ets`）：本来已接近 inline（返回 + 居中标题），改成同一组件，关闭字形统一 20dp/ink。
- **终端**（`terminal/TerminalScreen.ets`）：带边框的设备选择胶囊 → inline 导航栏（标题 = 当前设备名）+ trailing 的 chevron 字形，菜单与"无在线设备"规则不变。
- **文件**（`files/FilesScreen.ets`）：
  - 会话模式头部：36dp"返回"药丸 → inline 导航栏（标题跟随当前页签：文件/终端）；
  - `PushSwitcher` 从 Android 的 196×42 双页签胶囊（带图标与滑动指示块）改成 **iOS 分段控件**：`#7676801F` 轨道 + 白色选中块（28dp 高、7dp 圆角、3dp 阴影），文字 13sp/600、无图标，占满宽度、左右 16dp 内边距；
  - 设备选择头部：带边框胶囊 → inline 导航栏 + trailing chevron 字形。
- **验证脚本引用数**从 618 升到 622（新增的 `AAIosInlineBar` 里 4 处资源引用）。

### 15. 已归档会话 · 新建项目 · 新建会话头部（第五批）

- **已归档会话**（`home/ArchivedSessionsScreen.ets`，对照 iOS `ArchivedSessionsSheet`）：64dp 头部（返回按钮 + 居中 17sp/600）→ `AAIosInlineBar`；项目筛选行从带描边胶囊改成 iOS 列表行（裸 18dp 图标、17sp 取值、`ChevronsUpDown` 14dp 标记可弹出）；会话行从"标题 + 灰色时间 + 白字深底『恢复』药丸"改成 iOS 的"17sp 标题 + 12sp 次要行 + trailing 44dp 裸恢复字形"（恢复中显示 16dp 转圈），行高 60→56。
- **新建项目**（`home/NewProjectScreen.ets`，对照 iOS `ProjectEditorSheet`）：58dp 头部（40dp 返回 + 20sp/800 标题）→ `AAIosInlineBar`；项目名字段从 54dp 圆角盒子改成 **iOS 表单式**（按键区上方 13sp 大写小标题 + 12dp 圆角卡片内的无边框 17sp 输入 + 底部 1dp 分割线）；底部动作从 Android 的 `StartChatButton` 换成 `AAIosPrimaryButton`（胶囊、加载时显示转圈）。设备字段仍是共享的 `NewSessionConfigurationCard`，留到新建会话那一批一起改。
- **新建会话头部**（`home/NewSessionHeader.ets`，对照 iOS `ChatPageToolbar`）：58dp 头部（40dp 返回 + 20sp/800 标题 + 40dp 编辑钮）→ 44dp inline 导航栏（返回字形 22dp、标题 17sp/600、编辑钮 44dp 热区）；编辑态的内联输入从 20sp/142×1.5dp 下划线改成 17sp + 全宽 1dp `Divider`，字段 id 与聚焦时序未动。
- 顺带删掉 `NewProjectScreen` 里因此无引用的 `fieldBorderColor()`。

### 16. 新建会话的配置与工作区选择（第六批）

对照 iOS 的 composer 选项表与工作区选择表（`Views/Chat/Composer/ComposerOptionsSheet.swift` 的 `optionRow`、`Views/Chat/ProjectSelectionSheet.swift`）：

- **配置卡片**（`home/NewSessionConfigurationCard.ets`）：Android 是"48dp 单行、左侧 13sp 标签 + 右侧 14sp 取值 + 下落箭头、18dp 圆角卡、分隔线左缩进 16"。改成 iOS 的 `optionRow`：**23dp 图标位 + 17sp 字段名 + 其下 15sp 次要色取值 + 14dp chevron**、卡片圆角 12、分隔线左缩进 **52**（对应 iOS 的 `.padding(.leading, 52)`）、上下内边距 16。每个选择器补了 iOS 风格的图标（设备 `MONITOR`、Agent `TERMINAL`、模型 `BRACES`、思考强度 `SLIDERS_HORIZONTAL`、权限 `CIRCLE_CHECK`；Lucide 里没有 iOS 用的 `sparkles`/`checkmark.shield`，取语义最近者）。加载态仍是占位条（iOS 是 spinner，ArkUI 无 shimmer）。
- **工作区选择行**（`NewSessionComponents.ets` 的 `WorkspaceOptionRow`）：14sp/600 标题 + 选中有描边与底色的 16dp 圆角块 → iOS 选择行：**不在行上画卡片**（卡片由外层 section 提供）、文件夹 20dp、标题 17sp、路径 12sp 等宽（对应 iOS 的 `.system(.footnote, design: .monospaced)`，`WorkspaceMarqueeText` 因此加了 `monospace` 开关）、选中用 `CHECK` 17dp、上下内边距 8。
- **动作行**（`WorkspaceActionRow`）：14sp/600 + 按压阴影 → iOS 的 `Label(title, symbol)` 按钮行（17sp、无 chevron、默认无底色，`raised` 时才给 12dp 圆角卡片），删掉已无用的 `pressed` 状态与阴影。
- **目录行与目录条**（`PathRow`、`NewSessionPathSection.CurrentDirectoryBar`）：58dp 行 → 44dp（17sp 名称、14dp chevron、左右 16dp）；目录条 56dp/18dp 圆角/灰色底 + 描边 → **48dp/12dp 圆角/白底无描边**、标题 15sp/800 → 17sp；`directoryBorderColor` 因此无引用，连同两个调用点的参数一并删除。

### 17. 会话详情的内容层：composer 与用户气泡（第七批）

对照 iOS 的 `Views/Chat/Composer/ChatComposer.swift`（+ `ChatControlMetrics` / `ComposerLayout`）与 `Views/Chat/SessionTimelineRow.swift`：

- **Composer 外壳**（`sessiondetail/SessionDetailScreen.ets` 的 `Composer()`）：原来是"22dp 圆角白卡 + 1dp 描边 + 28dp 大阴影，minHeight 104，外边距 14/24"。改成 iOS 的一条 **glass 容器**：圆角 26（iOS 展开态 `diameter/2 + 2`）、细描边、**去掉投影**、内边距 16/14/12、外边距 12/bottom 10、去掉 minHeight（高度由内容决定）；输入字号 16sp/Medium → **17sp**（iOS `.body`），placeholder 同步 17sp。
- **发送/打断**：34dp 圆 → **40dp 圆**（iOS `sendDiameter = touchTarget - 8`），箭头 18dp 不变；**打断不再是红色圆**——iOS 是在同一个圆上把字形换成停止符（`stop.fill`，13pt），因此改成 `primaryAction` 底 + `onPrimaryAction` 的 10dp 圆角方块；不可发送时的透明度按 iOS 的 0.42。
- **附件入口**：30dp 描边圆 → **44dp 裸热区 + 24dp 加号**（iOS 的 `plus` 尺寸与 touch target）。
- **接管开关**：Android 的 30×18 自绘开关 → **iOS 开关**（51×31 轨道、27dp 白色旋钮带 1dp 阴影、开启为 iOS 绿 `#34C759`、标签 13sp）。
- **用户气泡**（`SingleRow()`）：原来是"左侧 22% 空白 + 78% 定宽气泡、16.5sp/24sp、13dp 纵向内边距、22dp 圆角"。改成 iOS 的 `UserMessageBubble`：**内容自适应宽度**（右侧一个 48dp 空白把气泡推到右边、剩余宽度内换行）、17sp/22sp、左右 17dp / 上下 12dp、**24dp 圆角**。气泡底色仍用本工程的 `sessionMessageBubble` token（iOS 是 `white 0.94` / `white 0.13`，色相一致，见第 10 条的调色板约定）。

### 18. 会话详情的事件行与文件变更行（第八批）

对照 iOS 的 `Views/Chat/SessionTimelineEventView.swift`：

- **活动/事件行**（`SessionDetailScreen.ActivityHeader`）：iOS 的 `TimelineMarkerRow` 是"10dp 展开箭头（10dp 槽位）+ 15dp 图标（18dp 槽位）+ 15sp 等宽摘要（`subheadline` mono，尾部省略）+ 可选 accessory，44dp 行高、**自身没有底色**、失败时整行红、否则用主文字色"。原来是"16dp 箭头 + 16dp 图标 + 13sp/34dp + 分组时加深色底、常态用次要色"——按 iOS 全量替换，`grouped` 参数因此无意义（两种调用点在 iOS 里是同一行），一并删除；`sessionTimelineActivitySurface` 这个 token 随之无人引用，保留在 `AAColors`（调色板仍与 `Theme.kt` 一一对应）并在声明处注明。
- **文件变更行**（`DiffBlock` 的头部）：原来只是"11.5sp 加粗等宽路径"。改成 iOS 的 `TimelineFileChangeView`：文档图标 15dp + 操作标签（`caption2` 尺寸）放在 5dp 内边距的浅色圆角小片里 + 12sp 等宽路径（尾部省略），44dp 行高、左右 12dp、浅色底、12dp 圆角；diff 正文的着色与滚动未动。

### 第 40 轮改造总览（iOS 版式）

一条用户指令（"登录页返回键太低 → 改成 iOS 那样"，随后"内部页面也改成跟 iOS 一样"）引出的八批改造。共同约定：**只动版面**——导航结构、状态机、回调、业务逻辑与文案（本工程自己的中英两张表）一律不变；配色继续用 `AAColors`（iOS 的语义色与它有对应关系，见第 10 条）；每一批都以 `clean assembleHap` + 三个脚本收口。

| 批次 | 覆盖的界面 | 对照的 iOS 源码 |
| --- | --- | --- |
| 1 | 扫码框内文案与底部说明胶囊（登录页补细节） | `Views/Auth/QRCodeLoginView.swift`、`QRCodeScannerView.swift` |
| 2 | 设置抽屉（区块头 + 行 + 分组卡） | `Views/Settings/SettingsComponents.swift`、`AccountSettingsSheet.swift` |
| 3 | 账号页 / 语言页 / 更新页 / 身份对话框；chrome 提到设计系统 | 同上 + `AccountIdentitySettingsView.swift`、`PasswordSettingsView.swift` |
| 4 | 首页（会话列表）：顶栏、区块标题、会话行、项目行、底部控件 | `Views/ChatShell/ChatSidebarView.swift`、`ChatSidebarProjects.swift` |
| 5 | 会话详情头部（inline 导航栏，去头纱） | `Views/Chat/ChatPageToolbar.swift` |
| 6 | 设备列表 / 设备详情 / 配对向导 / 终端 / 文件的头部与分段控件 | `Views/Devices/*`、`Views/Settings/*` 的 sheet chrome |
| 7 | 已归档会话 / 新建项目 / 新建会话导航栏 | `ArchivedSessionsSheet`、`ProjectEditorSheet.swift`、`ChatPageToolbar.swift` |
| 8 | 新建会话的配置卡片、工作区选择、目录行 | `ComposerOptionsSheet.swift`、`ProjectSelectionSheet.swift` |
| 9 | 会话详情的 composer 与用户气泡 | `Views/Chat/Composer/ChatComposer.swift`、`SessionTimelineRow.swift` |
| 10 | 会话详情的事件行与文件变更行 | `Views/Chat/SessionTimelineEventView.swift` |

新增的共享件（都在 `ui/designsystem/`）：

- `AAIosChrome.ets`：`AAIosPage`（大标题页）、`AAIosInlineBar`（sheet 的 inline 导航栏，含 `navigationSubtitle` 与 trailing 槽）、`AAIosPrimaryButton`、`AAIosGlassButton`、`AAIosField`（下划线输入）。
- `AASectionHeader`（`ui/screens/common/AppEmptyState.ets`）改为 iOS 次要色 15sp/600 的区块标题；`SettingsGroup` / `ProfileRow`（`ui/screens/profile/ProfileSettingsComponents.ets`）成为设置与列表共用的 iOS 分组卡与行。
- `ios_strings.json`（base + zh_CN）：iOS 独有的三条文案（扫码框内提示、底部说明胶囊、设置"应用"分组标题），与 `app_strings.json` 分开存放，避免被 `convert-android-strings.mjs` 覆盖。

**仍然存在的差异（已知、未做）**：

1. **glass 材质**：iOS 的 `.glassEffect` 是真实的模糊 + 高光；ArkUI 侧用"半透明填充 + 细描边"的平面等价物替代（按钮、composer、条形控件），没有 `backgroundBlurStyle`（在纯色底上也几乎看不出差别）。
2. **按压反馈与触感**：iOS 的按钮/行有系统按压态，Android 版有 `performHapticFeedback`；本工程保留了 `opacity` 的禁用态与加载态，未接入触感。
3. **大标题的滚动收起**：iOS 的大标题会随滚动收起为 inline 标题，本工程是固定大标题。
4. **系统级交互**：iOS 用 `.sheet`/`NavigationStack` 的系统转场与下拉关闭，本工程沿用自身"换页 + 淡入"的导航（第 39 轮已记录）。
5. **iOS 独有的内容**：iOS 的 composer 选项表、文件预览 sheet、归档 sheet 里的若干行（如"隐私政策""关于""打开系统设置"）没有对应页面，未强行补。

### 验证

`clean` 后全量 `assembleHap` 0 error / 0 warning；三个脚本 623 / 175 / 154 全过；`git status -- harmony` 仍无构建产物；逻辑用例（`%TEMP%\aa-tok` 的 15 个 `check-*.mjs`，跑由 `prepare-*.mjs` 从当前 `.ets` 转写的副本）全部通过——这是本轮"只动版面、逻辑未变"的独立证据。

## 多列布局（第 41 轮）

用户要求"需要多列布局"。iOS 客户端的判据是系统的横向 size class：`ChatSidebarState.Layout.resolve(hasRegularWidth:)` 返回 `.regularSplit`（iPad / Mac 走 `NavigationSplitView`，会话列表常驻左栏）或 `.drawer`（iPhone 单列）。本工程照此实现，改动只落在外壳 `app/AgentsAnywhereApp.ets`：

- **判据**：根 `Stack` 的 `onAreaChange` 把窗口宽度（vp）写进 `@State windowWidth`，`isSplitLayout()` 用 ArkUI 的 `lg` 断点 **840vp**（手机竖屏 360、横屏约 780 都到不了，平板 / 2in1 横屏都超过）。取断点而不是机型，与 iOS"只认 size class、不认设备型号"的原则一致；旋转与窗口缩放会重新判定。
- **左栏**：`SidebarColumn()` 固定 **320vp**，内容是把原来 `HomeScreen({...})` 抽成的 `SessionsList()`（两栏共用同一份参数，所以选择行为在两种宽度下一致），右缘一条 `secondaryControlStroke` 细线——`AAIosChrome.ets` 新导出的 `iosHairline()` 提供该颜色，原 `glassStroke()` 改为复用它。
- **右栏**：`layoutWeight(1)`，仍按 `destination` 渲染原来的页面（设备、文件、终端、新建会话、归档等都在这里，与 iOS"侧栏常驻、其余内容进 detail"一致）。登录四页（`LoginMethods` / `ServerSetup` / `QrLogin` / `QrWaiting`）不出左栏：登录前没有会话列表，对应 iOS 只有签入后的 shell 才分栏。
- **会话列表自己的 destination**：分栏时右栏是空白页（系统底色），对应 iOS 的 `ChatShellPlaceholderPage`；手机（< 840vp）时 `showsSidebar()` 为 false，外壳只是多了一层 `Row`/`Column` 容器，右栏铺满整窗，行为与之前**完全一致**。
- **未动**：所有 destination 分支、回调、状态机、文案、配色都没变；设置抽屉仍是整窗页面（iOS 在 iPad 上也是以 sheet 覆盖整个 shell）。

**已知差异（未做）**：iOS 还会给内容列限宽（`ChatControlMetrics.maxContentWidth = 780`），本工程未限宽。

**验证**：`clean` 后全量 `assembleHap` 0 error / 0 ArkTS warning；三个脚本 623 / 175 / 154 全过；逻辑用例（`%TEMP%\aa-tok` 的 15 个 `check-*.mjs`）全过；`git status -- harmony` 仍无构建产物。本机没有鸿蒙设备，分栏的实机观感（断点、320vp 宽度、细线）待用户截图确认。

## 首页分组顺序与侧栏折叠（第 42 轮）

用户反馈"首页页面布局不对，并且项目是通过左侧按钮有折叠隐藏效果的"，随后确认："首页内容顺序照 iOS 侧栏、详情页左上角按钮收起/展开侧栏、卡片与空状态都改成和 iOS 那样一致"。iOS 侧栏的顺序是**设备分组（含「配对设备」行）→ 置顶 → 项目 → 未分组会话**。

### 首页：补上 iOS 侧栏缺的两段

对照 `Views/ChatShell/ChatSidebarView.swift` 与 `ChatSidebarProjects.swift`，原来的列表只有「置顶 → 项目」，缺了 iOS 的**设备分组**、**「配对设备」行**和**「未分组会话」**：

- **设备分组**（`DeviceSection()` / `DeviceRow()`，新增 `HomeScreen.onOpenDevice`）：区块标题用 `devices_title`（iOS 的 `ChatSidebarSectionLabel`，普通标题；`AASectionHeader` 因此新增 `collapsible: false` 的形态：无箭头、无热区），每台设备一行——7dp 在线点（在线 `#10B981`、离线为次要色 45%）+ 等宽 15sp 名称、42dp 高、左右 10dp。点一行进该设备页（`openDevice`），与 iOS 选中设备后进 `DeviceManagementView` 一致。
- **「配对设备」行**（`PairDeviceRow()`）：`ChatSidebarPairDeviceButton` 的 46dp 行，`+` 18dp + 17sp/600 文案，无底色，调用原有的 `onPairDevice`（配对向导）。
- **「未分组会话」**（`ungroupedSessions()`）：iOS `ProjectSidebarPresentation.unassignedSessions` 的等价物——活跃、未置顶、且 `projectId` 不在项目列表里的会话，排在项目树之后，行用 `HomeProjectSessionRow(inset = false)`（与 iOS 传 `inset: false` 相同）。新增文案 `home_ungrouped_sessions`（iOS 的 "Ungrouped sessions" / "未分组会话"）放 `ios_strings.json`。
- 设备分组与配对行在**两种列表模式**（按项目 / 全部会话）都在最前，与 iOS 一致；「置顶」段落仍是原有的一段（把置顶项目与置顶会话放在一起，Android 的形状），未按 iOS 拆成「置顶项目 + Pinned 两段」；不过「全部会话」模式下没有置顶会话时整段不再显示（iOS 也只在有置顶内容时才画这一段）。

### 空状态与卡片：去掉 Android 的整页形态

- **空状态**：原来"没有设备 / 没有项目 / 没有会话"会把整个列表换成一页 `AppEmptyState`（带一个配对或建项目的按钮）。iOS 侧栏从不这么做——它在所属标题下画一行说明（`ChatSidebarEmptyRow`）。现在照此：设备分组下用 `devices_empty`，项目标题下用 `home_no_projects`，最近标题下用 `home_no_sessions_yet`；`EmptyListText` 也随之改成 iOS 的说明行（13sp、次要色、10dp 缩进、38dp 高）。原来那两个按钮的动作仍在（设备分组的「配对设备」行、项目标题右侧的 `+`），所以没有丢入口；`AppEmptyState` 在首页不再使用（该组件仍被其它页面使用）。
- **卡片**：三张快捷入口里的「设备」卡片删除——设备入口就是侧栏的设备分组（iOS 没有这种卡片）。「终端」「文件」两张**保留**：iOS 客户端根本没有终端页面，设备的文件浏览也是从设备页进的，删掉这两张卡片会让这两个入口在鸿蒙端消失（与"功能与 Android 一致"冲突）。若要把它们也移走，做法是在设备详情页加 iOS `DeviceManagementView` 那样的"工作区 / 文件"入口，再把卡片删掉。

### 侧栏折叠：`ChatSidebarState` 的 toggle

- 外壳新增 `@State sidebarOpen` 与 `@Watch` 的 `onWindowWidthChanged()`，对应 iOS `ChatSidebarState.setLayout`：**只有布局切换时才重置**（宽 → 开、窄 → 关），同一布局内的缩放不动用户手动收起的状态；首次布局（`onAreaChange`）即把宽窗口置为打开。
- `showsSidebar()` 现在 = 分栏 && `sidebarOpen` && 非登录页。收起后「会话列表」这个 destination 的右栏不再是空白页，而是**铺满整窗的会话列表**（否则收起侧栏会剩下一个空屏）；再点同一个按钮即恢复分栏。
- 前导按钮改为切换的页面，对应 iOS 里带 `onMenu: toggleSidebar` 的那几个：**会话详情**（`ChatPageToolbar` → `SessionDetailScreen`）、**新建会话 / 新建项目**（`NewSessionView` → `NewSessionHeader`）、**设备详情**（`DeviceManagementView` → `DeviceDetailScreen`，也是从侧栏设备行打开的那一页）、以及**会话列表自己**（`HomeScreen` 顶栏 wordmark 左侧，这是收起后重新展开的唯一入口）。
- 语法是新增的 `sidebarToggle` + `onToggleSidebar` 两个属性（`AAIosInlineBar`、`NewSessionHeader`、两个页面各自接收）：`true` 时前导字形换成新图标 `AA_ICONS.PANEL_LEFT`（lucide `panel-left`，对应 iOS 的 `sidebar.left`）并调用切换，`false` 时保持原来的返回箭头——**手机（< 840vp）因此完全不变**。无障碍文案 `sidebar_toggle`（"Toggle sidebar" / "切换侧栏"）也放在 `ios_strings.json`：iOS 自己的标签是"打开侧栏"，但这里按钮是双向的，所以用了中性的说法。
- **其余页面**（设备列表、文件、终端、归档、配对向导）在分栏下仍是返回箭头：iOS 把文件、归档、配对都放在带关闭按钮的 sheet 里，设备列表这一页 iOS 根本没有（设备就列在侧栏），所以它们照各自的 iOS 形态保留返回/关闭。

**验证**：同上一节——`clean` 后全量 `assembleHap` 0 error / 0 ArkTS warning；资源脚本 621 / 175 / 154 全过（引用数因首页删掉四处空状态而减少）；逻辑用例全过；构建产物仍不入库。

## 手机端抽屉 + 首页继续对齐 iOS（第 43 轮）

用户贴了手机截图："目前首页样式也不对，而且没有折叠按钮"，并逐项确认：**顶部两张卡片不应该有**、**右上角搜索图标不应该有**、**底部「新建会话」与账号按钮样式不对**、**分区标题/行的字号字重间距不对**，以及手机端要**"照 iOS：会话列表改成抽屉，默认收起，详情页左上角按钮打开/收起它"**。

### 手机端：抽屉（`SidebarDrawer`）

- `Sessions` 这个"没有选中"的 destination 现在渲染 **`NewSessionContent()`**（iOS 的 `ChatShellSelection.newSession` → `NewSessionView`），两种布局都一样——手机上的落地页因此是新建会话页，会话列表只活在抽屉/左栏里。原来右栏的空白 `EmptyDetail()` 删掉了。
- 新增 `drawerVisible()` / `drawerLayerVisible()` 与 `@Builder SidebarDrawerLayer()`：窄屏（< 840vp）下、内容被"卡片化"之后，侧栏在卡片**背后**，宽度 `windowWidth × 0.75`（iOS 的 `revealFraction`），关闭时缩到 0.95（`sidebarClosedScale`）并盖一层画布色纱（`systemBackground` 0.5），随进度淡出。宽屏仍然走第 41 轮的 `SidebarColumn` 固定 320vp。

### 抽屉的卡片表现与手势（iOS 的 `SidebarDrawerMainCard` / `SidebarDrawerInteractive`）

- **卡片**：内容整体向右平移 `drawerWidth × progress`，圆角 `10 × progress`、`clip(true)`，并叠一层 **白色 14%×progress 的纱 + 1px×progress 的描边**（`Color.primary` 20%）、外投 `-3×progress` 的 28% 阴影——就是 iOS 在抽屉打开时给内容卡的那一套。原来那层黑色压暗遮罩删掉了（`withoutAlpha` 不再需要）。根 `Stack` 补了画布底色，免得侧栏缩到 95% 时露出窗口默认底色。
- **跟手拖拽**：`drawerProgress`（0…1）+ `getUIContext().animateTo({ curve: curves.springMotion(0.34, 0.9) })`，即 iOS 的 `.interpolatingSpring(response: 0.34, dampingRatio: 0.9)`。松手时按 iOS 的投影规则判定：`progress + 0.2 × velocityX / drawerWidth ≥ 0.5` 则开，否则关。
- **手势挂在哪**：只挂在两个节点上，而不是整屏——① 关闭状态下左侧 44vp 的激活边（iOS 的 `edgeActivationWidth`，`HitTestMode.Transparent` 让点击照常落到下面的页面）；② 抽屉打开时卡片上那层纱（点一下即关，拖动即跟手关）。两处都用 `PanDirection.Horizontal`，竖直拖动不会被识别，所以列表与终端照常滚动。
- 卡片上的纱同时承担"点卡片关闭"的靶子（iOS 的 `SidebarDrawerCloseRegion`）：抽屉开着时页面本身不接受点击，与 iOS 一致。

**已知差异（未做）**：边缘拖拽只有在手势从左侧 44vp 内开始时才认（与 iOS 相同），但没有做 iOS 的 `SidebarDrawerPanGesture` 那套"先判方向再决定归属"的细节；卡片圆角用的是固定 10vp 而不是 `ConcentricRectangle`；设备页的"工作目录"分组是本工程自己的行样式，没有做 iOS 的工作区卡片与项目列表。
- `sidebarOpen` 仍是 iOS `ChatSidebarState.isOpen`：分栏默认打开、抽屉默认收起，只有布局切换时才重置。`navigate()` 在窄屏会把抽屉收起（iOS `selectDestination`），宽屏不动侧栏。
- 前导按钮（`sidebarToggle`）现在**两种布局都为真**：会话详情、新建会话/新建项目、设备详情、以及会话列表以外的一切页面左上角都是 iOS 的 `SidebarMenuIcon`（`AA_ICONS.PANEL_LEFT`），点一下开/关抽屉或收起左栏。手机上的"折叠按钮"就是它——落地页（新建会话页）左上角那一个。
- 系统返回手势：抽屉打开时 `canNavigateBack` 由 `publishBackGesture()` 置为真，`onBackRequested()` 先收抽屉（Android 也是这个顺序）。
- 从抽屉进账号页会先收起抽屉（`drawerVisible()` 也排除了 `profileOpen`），返回时重新拉一次账号，让底部的头像跟着改名/换图更新。

### 首页：只剩 iOS 侧栏有的东西

- **卡片与搜索删掉**：三张快捷入口卡片（设备/终端/文件）与右上角搜索图标全部移除，`QuickEntryCard`、`ToolbarGlyphButton`、`AAHeight` 导入随之删除（`home_search_coming_soon` 这条文案从此没有引用，但它是 Android 对照表里的字符串，保留）。顶栏只剩 wordmark，按 iOS 的 18dp 缩进（列表自身 14dp + 顶栏 4dp）。
- **终端/文件的新入口**：iOS 没有终端页、也没有顶层的文件入口（它从设备页开 `WorkspaceFilesSheet`），所以这两项移到**设备详情页**新增的"工作目录"分组（标题复用 `new_session_workspace`），两行分别是「文件」与「终端」。新增 `TerminalScreen.initialDeviceId` 与 `terminalReturn`，`FilesScreen` 复用已有的 `filesDeviceId`/`filesReturn`，两页返回都回到设备页。
- **底部控件按 iOS**：`NewSessionCapsule()` 换成**按内容宽度**的 prominent 胶囊（iOS 在侧栏传 `maxWidth: nil`；共享的 `AAIosPrimaryButton` 是撑满的，所以这里是它自己的构建器，注释里写明了原因）；账号按钮改成 **50dp 玻璃圆 + 38dp 头像**，复用已有的 `ProfileAvatar`（有图显示图，没有就用名字首字母，与 iOS `AccountAvatarView` 一致）。外壳新增 `@State account`，登录后拉一次 `/auth/me`（抽屉本来也要拉），失败就留在首字母。
- **分区标题的度量**：`AASectionHeader` 现在分两种形态——`collapsible: false`（设备、置顶、未分组会话）是 iOS 的 `ChatSidebarSectionLabel`：15sp/600 次要色、左右 10dp、上 20dp 下 6dp、无箭头无热区；`collapsible: true`（项目）保留 44dp 可点行，改为 iOS 的左右 10dp + 上 16dp。**「置顶」不再是可折叠段**（iOS 用普通标题，且只在有置顶内容时才画），`pinnedSectionExpanded` 状态删除。

**已知差异（未做）**：抽屉没有 iOS 的跟手拖拽/边缘滑出与弹簧动画（只有遮罩点击、返回手势、按钮三种开关方式），也没有 iOS 那层白色 14% 卡片纱与 1px 描边（用全屏压暗的遮罩代替）。设备页的"工作目录"分组是本工程自己的行样式，没有做 iOS 的工作区卡片与项目列表。

**验证**：`clean` 后全量 `assembleHap` 0 error / 0 ArkTS warning；资源脚本 620 / 175 / 154 全过；逻辑用例（`%TEMP%\aa-tok` 15 个 `check-*.mjs`）全过；`git status -- harmony` 无构建产物。

## 侧栏位置与落地页的两处修正（第 44 轮）

用户截图反馈"侧边的样式是不对的，并且首页有些问题，设备和 agent 没显示"。两处都能在截图里定位：

### 1. 侧栏整体被右移了约 53vp（根 `Stack` 把它居中了）

抽屉那一层是根 `Stack` 的直接子节点，而 ArkUI 的 `Stack` 默认 `alignContent: Center`：320vp 的侧栏被居中放进 427vp 的窗口，左边缘从 0 变成约 53vp，于是侧栏里的字、圆点、图标整体右移，看起来像"左侧空了一大块"。宽屏不分栏的那条路径没问题，因为 `SidebarColumn` 一直在 `Row` 里（左对齐）。

修法：用一层 `Row().justifyContent(FlexAlign.Start)` 把抽屉层包起来（和左侧那条激活边同样的写法），不动根 `Stack` 的 `alignContent`——那里还有对话框等其它子节点。

### 2. 落地页停在"正在检查设备"，设备与 Agent 都是灰条

`Sessions`（空选择）这一支现在是新建会话页。它在**启动时**就用空的 `sessionsState` 挂载了，而页面内部把"设备/项目/工作区"三件事都从这份状态里推出来：`hasLoaded` 为假 → `NewSessionSetupReason.CheckingDevices` → 设备行与 Agent 行都画占位灰条，选中设备为空 → 项目区被 `connectorId` 过滤成空 → 显示"暂无项目，新建一个项目后即可开始会话。"，底部的"开始聊天"也一直禁用。状态随后到了，但页面仍停在挂载时的那份快照上（`@Prop` 的那份拷贝没有跟进），`startInventory()` 也就没有以真实设备列表重跑过。

修法：这一支等 `sessionsState.hasLoaded || errorMessage !== null` 再挂载 `NewSessionContent()`，之前显示一个居中的加载指示（新增 `LandingLoading()` 与 `landingReady()`）。这样页面一定是在拿到状态之后才创建：设备行立刻显示设备名，Agent 行在运行时清单回来后显示 Agent，项目区按所选设备过滤后正常列出；首屏加载失败时也会挂载，让页面自己给出失败说明而不是永远转圈。

**验证**：`clean` 后全量 `assembleHap` 0 error / 0 ArkTS warning；三个脚本 620 / 175 / 154 全过；15 个逻辑用例全过。

## 设备 / Agent 行不可点击与邮箱表单（第 45 轮）

### 1. 新建会话页的"设备""Agent"两行点不动

`NewSessionConfigurationCard` 的行只有 `field.active()` 时才响应点击，而它要求 `enabled` 为真：设备行的 `enabled` 原来是 `devicePool().length > 0`——`devicePool()` 只包含**已经报告有可用 Agent**的设备。于是"有在线设备、但清单还没回来（或那台设备上 Agent 没在跑）"时，行里显示着设备名却完全点不动（iOS 不是这样：`NewSessionView` 的目标按钮只在创建中禁用，任何时候都能点开去换设备）。

改法：设备行的选项改成 `onlineDevices()`、启用条件改成 `online.length > 0`，即"有在线设备就能点"。选中一台没有可用 Agent 的设备后，页面下方的说明行（`runtimeError()`）会讲缺什么，并给出"重试"✓，与 iOS 的"选择一个已就绪的 Agent + 选择 Agent"是同一个意思。Agent 行仍然只在有可选项时可点（否则菜单是空的），没有可选项时由同一行说明负责解释。

### 2. 邮箱表单里那个被拉长的大圆角框

`ProfileDialogButton` 用 `layoutWeight(1)` 来分宽度——在 `Row` 里它分的是行宽 ✓，但作为 `Column` 的直接子节点时它争的是**剩余高度**，于是"发送验证码"和"重试"两个单独按钮被拉成整屏高的圆角框（截图里那个大空框），把表单顶得又高又空。

改法：把这两个单独按钮包进 `Row()`（`.width('100%')`），`layoutWeight(1)` 于是在行内撑满宽度 ✓，按钮回到 50dp 胶囊。

顺带补上 iOS 的那一行状态：字段里还是原邮箱时显示「邮箱状态 / 已验证·未验证」（`LabeledContent("Email status", …)`），用的是本工程一直没被引用的 `profile_email_status` / `profile_email_verified` / `profile_email_unverified` 三条文案（`emailVerified` 由设置抽屉从账号里传入）。

**验证**：`clean` 后全量 `assembleHap` 0 error / 0 ArkTS warning；三个脚本 623 / 175 / 154 全过；15 个逻辑用例全过。

## 设置页卡死、返回与 iOS 图标（第 46 轮）

### 1. 侧滑打开抽屉后点头像，页面整体右移且回不去

两处叠加：

- **卡片没有归位**：打开设置时只把 `sidebarOpen` 置了假，没有把 `drawerProgress` 收回去。卡片的位置/圆角/阴影/白纱都读 `drawerProgress`，于是设置页带着 75% 的平移画出来——截图里左侧那片空白就是抽屉该在的位置，而侧栏因为 `profileOpen` 已经不画了。现在统一走新的 `cardProgress()`：分栏、设置页、登录页时一律为 0；打开设置也改成走 `settleDrawer(false)`（与按钮、点纱、拖拽同一个收法）。
- **设置首页没有关闭控件**：子页有返回箭头，但首页只有身份头部和分组，没有任何关闭入口（iOS 的 `AccountSettingsSheet` 是带 `xmark` 的 sheet）。现在首页加了 inline 导航栏：标题「设置」+ 前置 `xmark`（`ProfileHeader` 新增 `closeGlyph`，并给出「关闭」的无障碍文案）。
- **返回手势**：`publishBackGesture()` 现在把 `profileOpen` 也算作"可以返回"，`onBackRequested()` 先关设置页；关闭统一走 `closeProfile()`（置假 + 重发手气势 + 重新拉一次账号，让侧栏头像跟着改名/换图）。

### 2. 应用图标改成 iOS 的那张

`tools/generate-app-icons.mjs` 原来拿 Android 的自适应图标前景（字形只有画布 50%），看起来比 iOS 的小一圈。现在直接从 iOS 的 1024 资源取图（`AppIcon.appiconset/ios-dark-iOS-Dark-1024@1x.png`，也就是 iOS 客户端默认外观用的那张）：

- **背景层**：读图里方块的底色（`rgb(53,53,53)`），铺满整块画布——iOS 那张自带的圆角是系统的事，不搬过来。
- **前景层**：把白色字形从底色上按绿通道的覆盖度解出来（`(pixel - background) / (glyph - background)` × alpha），并丢掉 iOS 图自带的那圈高光描边与柔和阴影（裁掉外边 8% 并抬高阈值），字形保持 iOS 的约 66% 比例。
- **启动图**：两层在 144×144 上合成、25% 圆角，与 DevEco 模板一致。
- PNG 读取器补了 **16 位通道**支持：iOS 那张是 16-bit RGBA，原来只认 8 位。

**验证**：`clean` 后全量 `assembleHap` 0 error / 0 ArkTS warning；三个脚本 625 / 175 / 154 全过；15 个逻辑用例全过。图标用 System.Drawing 渲染预览核对过：启动图是深灰圆角块 + 白色字形（6335 个字形像素），前景是纯字形（无描边）。

## 新建会话页点不动、Agent 一直转（第 47 轮）

用户反馈"项目无法点击、设备/Agent 无法点击、agent 没有显示"。定位到一个自第 44 轮起就存在的**点击被吞**问题，以及一个状态说明缺失：

### 1. 全屏透明遮罩吞掉了整页的点击

第 44 轮补跟手拖拽时，把"左侧激活边"做成了一个**满屏的 `Row`（`HitTestMode.Transparent`）**，里面才是 44vp 的窄条，`PanGesture` 挂在窄条上。ArkUI 里 `Transparent` 的节点**自身也参与命中测试**，它又排在内容卡片之上，于是手机竖屏（抽屉关闭、这个遮罩常驻）时，页面里的一切点击都被它先接走——设备行、Agent 行、项目行全都点不动，而抽屉打开时这个遮罩不画，所以侧栏里的头像按钮反而是好的。这与用户前后几次的描述完全吻合。

改法：**把 `PanGesture` 挂到内容卡片本身**（它是页面的祖先，不是覆盖物），并删掉那个满屏遮罩与卡片纱上的重复手势；打开条件改回 iOS 的 `canBeginHorizontalDrag`：`drawerProgress <= 0.001 && startX <= 44`（`GestureEvent.fingerList[0].globalX`）才认，抽屉已开则任意位置都能拖回。祖先上的手势不会被点击触发（`PanDirection.Horizontal` 不认竖直、普通点击更不会满足 8vp 的距离阈值），所以页面不再有任何死区。

### 2. Agent 行一直显示占位条，看起来像"没显示"

运行时清单要逐个问在线设备（单次 10s 超时 + 五次退避重试），这期间 Agent 行只画一条灰条、底部"开始聊天"也是灰的，而 `runtimeError()` 在这段时间刻意返回空——所以整页看起来就是"点不动 + 没显示"。现在这段时间在卡片下方显示一行 `new_session_checking_agents`（"正在检查可用 Agent"），与 iOS 的"正在查找设备…"同一作用；清单回来后若设备上确实没有可用 Agent，则照旧显示失败原因和"重试"。

**验证**：`clean` 后全量 `assembleHap` 0 error / 0 ArkTS warning；三个脚本 626 / 175 / 154 全过；15 个逻辑用例全过。

## 模拟器冒烟测试（第 48 轮）

用户要求"用我的鸿蒙模拟器做冒烟测试"。本轮把模拟器跑通并做了**未登录面**的冒烟；登录后的页面还差一个账号，需要用户在模拟器里登一次。

### 怎么把模拟器跑起来（记下来给后面几轮用）

- 已创建的实例在 `%LOCALAPPDATA%\Huawei\Emulator\deployed\Customize_01`（`lists.json` 记着它的参数：手机、1080×1920、density 560 → **309vp 宽**、API 23、x86）。
- 启动命令从 DevEco 日志里抄的（`%LOCALAPPDATA%\Huawei\DevEcoStudio6.1\log\idea.1.log`）：
  `"…\tools\emulator\Emulator.exe" -hvd Customize_01 -path <deployed> -t trace_<pid>_commandPipe -imageRoot D:\sdk\HUAWEI`
  **`-imageRoot` 必须是 `D:\sdk\HUAWEI`**：镜像在 `D:\sdk\HUAWEI\system-image\HarmonyOS-6.0.31\phone_all_x86`。第一次我按 `%LOCALAPPDATA%\Huawei\Sdk` 传，模拟器找不到镜像，卡在一个"点击确认清除镜像数据并启动"的对话框上（日志里能看到那句 `QString::arg: Argument missing`），hdc 一直 `[Empty]`。
- 之后：`hdc list targets` → `127.0.0.1:5555`；`hdc install -r entry-default-signed.hap` **可以直接装**（本机调试签名被模拟器接受）；`hdc shell aa start -a EntryAbility -b com.agentsanywhere.app`；截图用 `hdc shell snapshot_display -f /data/local/tmp/x.jpeg` + `hdc file recv`；点击用 `hdc shell uinput -T -c <x> <y>`，回桌面用 `hdc shell uinput -K -d 1 -u 1`。

### 已验证

- **桌面图标就是 iOS 那张**（第 46 轮的成果在真启动器上确认）：深灰圆角块 + 白色终端字形。
- App 能装能起，未登录的三个页面都对：登录方式页（`AuthWelcomeLayout`：wordmark 42sp + 副标题 + 两个胶囊，整体垂直居中 ✓）、选择登录服务页（iOS 的 `AuthScreen`：44dp 返回箭头 + 34sp 大标题 + 22dp 内边距 + prominent/glass 胶囊，顶部对齐 ✓）、账号密码表单页 ✓。

### 待做（需要先登录）

登录后的页面（首页/抽屉/新建会话/会话详情/设置）在模拟器上需要一个账号：本机**没有**跑 agents-anywhere 的服务端（`server/agent_server` 是 Python FastAPI，进程在但没监听；`:8080` 是另一个 Java 应用），所以无法注册临时账号。等用户在模拟器里登录一次后继续。

### 真机冒烟（第 48 轮，接上真机后继续）

真机 `62T0225B18043858`（VYG-AL00）上装当前包（`hdc -t <id> install -r`，同签名可直接覆盖安装，**登录态保留**），逐屏核对：

- **抽屉**：头部左侧按钮打开 ✓；侧栏贴在左边（第 44 轮的居中问题确已修好）✓；卡片右移 + 白纱 + 1px 描边 + 阴影 ✓；侧栏内容与 iOS 一致（设备圆点/配对行/项目树/嵌套会话带状态点）✓；底部「新建会话」+ 头像「M」✓。
- **新建会话页**：等运行时清单回来后，五行配置全部就位（设备 · jerry的Mac mini → Agent · Codex → 模型 · GPT-5.6-Terra → 推理强度 · Low → 权限模式 · 请求批准），工作区列表出现勾选、「开始聊天」变为可用 ✓ —— 第 45/47 轮的加载与说明修正都生效了（等待期会显示「正在检查可用 Agent」）✓。

**发现并确认了一个真 bug：配置卡的五个下拉菜单都打不开**（设备/Agent/模型/推理强度/权限模式）。用两种注入方式都复现（`uinput -T -c` 与 `uitest uiInput click`），并用 `uitest dumpLayout` 确认这些行在框架里是 `clickable: true`、坐标也正确（例如 Agent 行 `[63,?][1217,?]` 覆盖了点击点），所以不是注入方式的问题，而是 `NewSessionConfigurationCard` 里 `.bindMenu(this.expandedKey === field.key && field.active(), …)` 这一路：`expandedKey` 是**普通成员变量**，页面把 `expandedConfiguration` 改掉后卡片不一定重跑 `build`，菜单就不会弹出。下一步改成让卡片自己持有展开状态（`@State` + `@Prop` 初值），或把菜单交给页面层状态驱动。

（工作区的项目行只做"选中"、只有勾选标记这一个可见变化，单次点击不易判定；这一条留待下一轮连同菜单一起验证。）

### 下拉菜单修好了（待解锁复测）

成因在上面写了：`NewSessionConfigurationCard` 的 `expandedKey` 是**普通成员变量**，页面把 `expandedConfiguration` 改掉后卡片不会重跑 `build`，于是 `bindMenu(this.expandedKey === field.key && …)` 永远读到 -1，五个菜单都弹不出来（行本身在框架里是 `clickable: true`，所以点击是到了的）。

**修法**：把 `expandedKey` 从普通字段改成 **`@Prop`** —— 页面状态一变，卡片就会重渲染，`bindMenu` 的开关随之翻转。其余接线（`onToggle` / `onDismiss` / `onSelect`）不变，页面对展开态的所有重置（切设备、建项目等）也继续生效。改动只有一个属性声明行。

**验证状态**：已构建（0 error / 0 warning）并装到真机；但真机在测试中途**自动锁屏**，`hdc shell aa start` 报 `10106102 The device screen is locked during the application launch`，我这边无法解锁（需要 PIN）。所以"菜单能弹开"这一步的实机复测等用户解锁后进行；`hdc shell power-shell wakeup` 能亮屏，但亮屏后仍是安全锁屏（上滑无效）。

**实机复测（已通过）**：解锁后重装并启动，点「设备」行 → **下拉菜单正常弹出**（白色圆角卡，列出 jerry的Mac mini ✓ 打勾、皮蛋的麦克伯克坡若、DESKTOP-P13E1GV），`@Prop` 这一行改动就解决了问题 ✓✓。菜单项的语义与 Android 一致：选了没有可用 Agent 的设备后，页面会按 `pickDevice()` 自动回到"有可用 Agent"的那台（所以行里仍显示 jerry的Mac mini）。

**同一轮里一起修的两处一致性问题**：

- `NewSessionConfigurationCard.fields` 也改成 `@Prop` —— 页面是随着前置条件到位（先是设备、再是 Agent、再是模型目录）**重建这个数组**的，普通成员会让卡片一直显示它出生时那几行。
- 新增 `isCheckingAgents()`：把"设备/Agent 检查中"的两种 Android reason 与 inventory/selection 的两个标志合在一处判断，卡片下方那行「正在检查可用 Agent」现在与 Agent 行的占位条**永远一致**（之前出现过"行是灰条但一句说明都没有"的状态）。检查已经落定、但选中的设备仍拿不到可用 Agent 时，这行还会带一个「重试」——就是失败行那个重新检查的入口。

**实机复测（已通过）**：解锁后重装启动，点「设备」行 → **下拉菜单正常弹出**（白色圆角卡，列出 jerry的Mac mini ✓ 打勾、皮蛋的麦克伯克坡若、DESKTOP-P13E1GV），`@Prop` 这一行改动就解决了问题 ✓✓；换成 DESKTOP-P13E1GV 后设备行与项目列表（D:\code\…）都跟着变了 ✓；底部状态行也正确地显示「正在检查可用 Agent」✓。菜单项的语义与 Android 一致：选了没有可用 Agent 的设备后，页面会按 `pickDevice()` 回到"有可用 Agent"的那台。

**仍待观察**：这台真机上的运行时清单有时几十秒都不出结果（同一个 Mac 半小时前是正常的），所以 Agent 行会长时间停在占位条上；退避阶梯的收尾、以及"检查落定后仍无可用 Agent 时是否给出重试"，下一轮再看。剩下没冒烟的屏：会话详情、设置页开关/返回、左缘拖拽开抽屉、工作区项目行的选中反馈。

**再加一处防抖**：`startInventory()` 现在按"在线设备集合"去重 —— 设备签名在运行中翻转（例如某台设备在线状态抖动）时不再重新启动整条重试阶梯（那会把 `pendingInitial` 重新填满，页面就长时间停在"检查中"）。同一个设备集合的一次运行还没结束就忽略后续触发。

**根因（日志定位）**：`hdc shell hilog -x` 里应用只有一件事在刷屏 —— `NETSTACK: [websocket_exec.cpp:498] lws callback reason is 8`，即**实时 WebSocket 一直在断开重连**。运行时清单是靠连接器回一个 RPC（HTTP 侧等连接器应答），所以当选中那台 Mac 的连接器不在线/不应答时，清单就一直 pending、Agent 行停在灰条 —— 这也解释了为什么早上同一台机器是正常的。**这不是 UI 的问题**：界面现在会正确显示「正在检查可用 Agent」（iOS 也是"正在查找设备…"），检查一旦落定还会给「重试」。

## 真机冒烟与三处状态不同步修正（第 49 轮）

接着第 48 轮的四个待办做真机冒烟。三项 UI 复测里 **1 项失败并定位到根因、2 项通过**（失败的正是第 48 轮"已装机、未复测"的那条）；第 5 条（实时 WebSocket）查清后**结论是"不是 bug"**，因此没有改代码。

### 1. 工作区勾选：第 48 轮的 `@Prop` 只修了一半（断在第二层边界）

点工作区行前后 `dumpLayout` 完全一致：该行 `children=2`（`Shape`+`Column`），勾选标记该多出的第三个子节点从未出现，另一行也恒为 2。行本身 `clickable=true`、坐标就是行 bounds 中点，而且同一页的「设备」行能点开菜单、「新建项目」行能跳转，所以**不是命中测试**：我又反复开关下拉菜单**强制父组件重渲染**，勾选标记依旧不出现，问题只能在渲染链上。

成因：值要跨**两层**边界，第 48 轮只修了第一层。

```
NewSessionScreen.selectedWorkspacePath (@State)
  → NewSessionWorkspaceSection.path      ← 第 48 轮已改 @Prop ✓
    → WorkspaceOptionRow.selected        ← 仍是普通成员 ✗ 断在这里
```

`NewSessionComponents.ets` 里 `selected: boolean = false;` 没有装饰器。普通成员只在子组件**创建时**赋值，父组件后续重渲染不会更新它，于是父层算出的 `selected=true` 永远进不到 `if (this.selected)` 那个分支。

**编译产物级的证据**（本轮审计从 `entry/build/default/cache/.../default@CompileArkTS/esmodule/debug/` 读出来的）：普通成员生成的 `updateStateVars(params) {}` 是**空的**，只有 `@Prop`/`@Link` 才会在重渲染时推送值；同一个文件里已修的 `NewSessionConfigurationCard` 会推 `{fields, expandedKey}`，而全普通成员的 `NewSessionPathSection` 推 `{}`。这条规则现在有据可查，不用再靠推断。

**修法**：`WorkspaceOptionRow.selected` → `@Prop`；连带 `WorkspaceMarqueeText.selected` → `@Prop`（"只有选中的长路径才滚动"同样因为普通成员而是死的）。

**实机复测（已通过）**：重装后点 `Documents` 行 → `jerry` 行 `children` 3→2、`Documents` 行 2→3，勾选**移动**过去了；重启应用后勾选又正确落在持久化的 `jerry` 上（修之前它从不出现）。

### 2. 设置页 X 关闭（通过）

抽屉底部头像 → 设置页（标题「设置」、昵称 `mimic`）→ 关闭按钮是左上角 `Column [63,137][217,290]`（内含 X 字形 `Shape`），点它的中点 → 干净回到新建会话页。`closeProfile()` 一路正常。

### 3. 长按会话行 → 操作卡（通过）

`uitest uiInput longClick` 长按抽屉里的会话行 → 白色圆角操作卡，**重命名 / 归档 / 置顶**三项齐全，与 Android 的会话操作一致。`HomeSessionRow` 的 `GestureGroup(Exclusive, LongPressGesture)` 接线是好的。

### 4. 目录阶段的重试入口（比 handoff 说的多修一处）

handoff 第 4 条说"点击重跑 `loadRuntimeDetails()`"就够了。但读代码发现 `loadRuntimeDetails()` 开头是：

```ts
if (this.selection.capabilities.fresh()) {
  // Already loaded for this runtime; nothing to do.
  return;
}
```

**能力加载成功、只是模型或权限目录失败**时（`failModelCatalog` 只把那个 catalog 置为未加载），`capabilities.fresh()` 仍为真，于是这个「重试」点了**什么也不会发生**——按钮是死的。所以：

- `NewSessionRuntimeSelectionState` 新增 `beginRuntimeCatalogs()`：只重问目录、保留已经拿到的能力集（能力请求才是贵的那一个），并在能力报告"该目录不可用"时原样不动。
- `NewSessionScreen` 从 `loadRuntimeDetails()` 里抽出共用的 `loadRuntimeCatalogs()`，两条路径（首次加载 / 重试）走同一段代码，失败时也按同一段逻辑落到失败态。
- 新增 `retryRuntimeResolution()`，把"清单还没落定"与"清单已落定、只差能力/目录"分开：前者重跑清单并 `inventory.refresh()`，后者走 `loadRuntimeDetails()`。两个状态行（检查中 / 失败）都改用它，不再各写一遍。

### 5. 实时 WebSocket：查清的结论是"不是 bug"（推翻第 48 轮的两处判断）

第 48 轮把 `NETSTACK: [websocket_exec.cpp:498] lws callback reason is 8` 读成"连接错误"、并据此认定"长连一直在断开重连"。两处都不成立：

- **`reason is 8` 不是错误。** libwebsockets 的枚举里 `LWS_CALLBACK_CLIENT_RECEIVE = 8`，语义是"**服务端有数据到达**"（[libwebsockets User Callback](https://libwebsockets.org/lws-api-doc-v2.2-stable/html/group__usercb.html)）。这行 INFO 日志是**收到帧**的证据，本身不是故障。
- **并没有周期性掉线。** 把屏幕保持常亮后连续观测：

| 观测 | 结果 |
|---|---|
| 120 秒轮询 | 只有 1 条 `Dashboard connection up (attempt 0)`，**0 条 down** |
| 440 秒（10:32:50 → 10:40:10）轮询 | 仍然**只有那 1 条 up**，一次都没断 |

- **之前看到的"26 秒掉一次"和"应用日志整整 150 秒一条都没有"，都是息屏伪影。** 息屏后应用被冻结：既不执行也就不写日志，socket 也随之结束，于是日志里出现一次 `down`，之后再无任何输出——看上去就像"疯狂重连"。服务端代码也不会主动断（`server_push_websocket.py` 只等 disconnect，队列静默 ≤15 秒就发一条 keepalive）。

**因此不改代码。** 另外记一笔：`@ohos.net.webSocket` 的 `pingInterval` **默认就是 30 秒**（`disable: 0`，`@since 21`），这台设备（API 26）本来就在自动 ping；Android 显式写 `.pingInterval(20, TimeUnit.SECONDS)` 只是更早、更紧。给它加 ping 属于"观测不到问题就改代码"，不做。

### 6. 同类隐患审计（另开一轮，本轮不动）

本轮顺带做了一次**只读**审计：扫描整个 `harmony/entry/src/main/ets`，找"声明为普通成员、又在自己 `build()` 里参与渲染决定、且父组件传的是会变的值"。除已修的 `WorkspaceOptionRow.selected` 外，还有 **15 组 HIGH**，症状明确的有：

| 严重度 | 位置 | 症状 |
|---|---|---|
| HIGH | `ui/screens/home/NewSessionPathSection.ets:28-39`（`entries`/`loading`/`errorMessage`/`hasRetry`） | 目录浏览器可能**永远停在"正在加载目录…"**、进目录/返回上级不重绘、出错时**没有重试行** |
| HIGH | `ui/screens/home/NewSessionHeader.ets:23` `headerEditing` + `NewSessionComponents.ets:121` `editing` | 点铅笔**无法进入标题编辑**，铅笔也不会变勾 |
| HIGH | `ui/screens/files/FilesScreen.ets:1268` `FileListRow.menuOpen` | 长按文件**弹不出菜单**（与已修的 `expandedKey` 的 `bindMenu` 一模一样） |
| HIGH | `ui/screens/profile/ProfileSettingsComponents.ets:121` `ProfileRow.trailing` | 设置页**昵称/邮箱的值不显示**（行在 `account` 还是 null 时就建好了） |
| HIGH | `ui/screens/sessiondetail/CodeBlockPanel.ets:257` `CopyIconButton.copied` | 复制**没有勾选反馈** |
| HIGH | `ui/screens/home/HomeSessionRow.ets:30` `SessionStatusIndicator.indicator` | 会话行的状态点/胶囊**不随会话状态变化** |
| HIGH | `ui/screens/devices/DevicesScreen.ets:244` `DeviceRow.preview` | 设备行的 Agent 预览**一直停在"检查中"或"不可用"** |
| HIGH | `ui/screens/home/NewSessionWorkspaceSection.ets:46-47` `projects`/`sessions` | 新建的项目**不出现在列表里**、recent 列表不更新 |
| HIGH | `ui/screens/profile/ProfileSettingsDrawer.ets:57-58` `appearanceMode`/`languageMode` | 选了新语言/外观后**勾选和标签不动**（选择其实已生效） |
| HIGH | `ui/screens/devices/DeviceDetailScreen.ets:943/979/980` `SelectionCircle.selected`、`SessionDetailRow.selectMode`/`selected` | 进入多选**看不到选择圈**，归档操作作用在看不见的选择上 |
| HIGH | `ui/screens/sessiondetail/SessionDetailScreen.ets:113/115/117/122` 三个 notices + `attachments` | 会话开着时新到的**审批请求/附件不可见** |
| HIGH | `ui/screens/sessiondetail/SessionRuntimeControls.ets:40/43` `busy`/`errorMessage` | 点批准**看不到任何反应**（无错误框、无忙碌态） |
| HIGH | `ui/screens/home/HomeScreen.ets:49` `projectStatusFilter` + `HomeProjectActions.ets:380` `filter` | 状态筛选**树不更新、勾选不移动** |
| HIGH | `ui/screens/home/HomeSessionActions.ets:161`、`HomeProjectActions.ets:133/134` 对话框的 `errorMessage`/`busy` | 弹窗内联错误**不显示**、保存按钮**不进"保存中"** |

修法同本轮：把声明行改成 `@Prop`（这些调用点都始终传值，所以 `@Prop` 安全）；改完按老规矩跑 `assembleHap` + 三个门禁。

### 7. 本轮验证

- `clean` + `assembleHap`：**BUILD SUCCESSFUL，0 error / 0 ArkTS warning**（日志里 WARN 0 行、ERROR 0 行）。
- 三个门禁：`627 refs / 154 ETS`；`175 文本文件 BOM=0 replacement=0 mojibake=0`；`154 ETS unreachable=0`。
- 15 个逻辑用例：全部 exit 0，无一行 FAIL（`check-newsession` → `ALL CHECKS PASSED`）。
- 真机复测：工作区勾选**能移动**（本轮唯一的行为改动里最关键的一条）。

### 8. 真机配方补充（这一轮踩出来的）

- **`hdc shell power-shell timeout -o 1800000`**：临时把息屏超时改成 30 分钟，收尾用 `-r` 还原。**这条是测长连的前提**——不设它，息屏会让应用冻结，测出来的全是伪影（上面第 5 条就是踩了这个坑）。
- **应用日志用 `hdc shell hilog -x -T AgentsAnywhere` 过滤**（域是 `A00000`）。`hilog -T` 的过滤是设备侧做的，比拉全量再 grep 可靠得多。
- **长按用 `uitest uiInput longClick <x> <y>`**，比 `uinput -T -d/-u` 稳。
- **不要用 `uitest uiInput keyEvent Back`**：根页面上返回是交给平台的，会直接把应用退出到系统（本轮因此落到系统设置里一次）。
- 坐标一律 `uitest dumpLayout` 取节点 bounds 中点，**不要估算**：运行清单到达时整页会重排（本轮第一次点工作区行就吃了这个亏）。

## 页面背景纯白、深色模式与剩余屏幕冒烟（第 50 轮）

用户要求三件事：继续冒烟测试、把页面背景改成纯白色（"目前不是纯白色"）、适配深色模式。

### 1. 页面背景改为纯白（顺带对齐了 iOS）

- `AA_LIGHT_COLORS.canvas`：`#FDFCFB` → **`#FFFFFF`**。iOS 的 `ChatShellView` 背景用的是 `Color(.systemBackground)`，浅色下就是纯白、深色下是黑，所以这一改正好把两个客户端的页面底色对齐了，不是凭空造色。
- `ProfileSettingsSupport.profilePageBackground()` 原本硬编码 `#F4F3EF`（只对浅色生效、不走 `canvas`），改成跟随 `colors.canvas` —— 少一个字面量，设置页也跟着白。
- `TerminalContent` 的终端画布 `#FEFDFB` → `#FFFFFF`（浅色终端本来就是白底）。
- `AttachmentViews` 的图片查看器背景 `#FDFCFB` → `#FFFFFF`。

**实测（真机截图取像素）**：页面 `#FFFFFF`，改前是 `#FDFCFA`。注意肉眼看预览图会误判成"还是米白"——**必须取像素**：`#FDFCFB` 与 `#FFFFFF` 只差 2~4 级，JPEG 预览里完全看不出。

### 2. 深色模式：能切，但设置页不重绘（已修）

实测发现一个真 bug：在设置页切到深色后，**这一页仍然是浅色的**，只有关掉设置页回到 shell 才变黑。根因还是那条 ArkUI 规则，只是这次断在 `colors` 上：

| 位置 | 问题 | 修法 |
|---|---|---|
| `ProfileSettingsDrawer.colors` | 普通成员 → 调色板变了这一页不重绘 | `@Prop` |
| `ProfileSettingsComponents` 的 5 个 struct（`ProfileHeader`/`SettingsGroup`/`ProfileRow`/`ProfileDivider`/`SignOutCard`） | `colors` 是普通成员 → 卡片仍是白的 | 全部 `@Prop` |
| `AAIcon.color` | 普通成员，而它几乎处处由调色板算出 → 图标停在旧主题的颜色 | `@Prop`（一行，杠杆最高） |
| `ProfileRow.trailing`/`trailingIcon`/`trailingAttention`/`showChevron` | 普通成员 → 顺带就是审计的 **H10**：设置页昵称/邮箱的值**从来不显示**，外观/语言的值也不刷新 | `@Prop` |

**实测（两个方向，且页面保持挂载，不靠重建）**：

| 方向 | canvas | 卡片 | 外观行的值 |
|---|---|---|---|
| 深色 → 浅色 | `#FFFFFF` | `#FFFFFF` | 浅色 |
| 浅色 → 深色 | `#09090B` | `#1F1F1F` | 深色 |

顺手修掉 H10 之后，设置页的昵称（`mimic`）与邮箱（`phamton0308@gmail.com`）终于有值了 —— 之前那两行是空的。

### 3. 从抽屉点会话不会关抽屉（已修）

冒烟会话详情时发现：在抽屉里点一个会话行，**页面确实切过去了，但抽屉没关**；内容卡片又被右移，于是用户只看到抽屉右边一条缝，会话详情躲在后面。根因在 `AgentsAnywhereApp.openSession()`：

```ts
this.destination = AppDestination.SessionDetail;   // ← 绕过了 navigate()
```

而手机端关抽屉的 `settleDrawer(false)` 就在 `navigate()` 里（iOS 的 `selectDestination` 语义）。改成 `this.navigate(AppDestination.SessionDetail)` 即修好。

**顺带核对**：其余直接写 `this.destination` 的地方只剩启动时的恢复、以及登录/登出两条 —— 那两处整个 shell 都会被替换，不受抽屉影响，保持原样。

### 4. 本轮新增的冒烟覆盖

| 屏 | 结果 |
|---|---|
| 会话详情 | ✓（修完第 3 条后：抽屉自动关闭、详情全宽、时间线与表格正常） |
| 设备详情 | ✓（在线状态、AGENT 分组、工作目录=文件/终端、会话分组的 活跃/已归档/全部） |
| 文件 | ✓（`/Users/jerry` 目录列表、`..`、`.agents-anywhere`/`.codex` 等点目录） |
| 终端 | ✓ **真的连上了那台 Mac 的 zsh**：打出 `jerry@jerrydeMac-mini-2 ~ %` 并回显了 `.zshrc` 的报错；终端画布现在是白底 |
| 归档会话 | ✓（深色下渲染正常，图标/文字/卡片对比都够） |

### 5. 本轮验证

- `clean` + `assembleHap`：**BUILD SUCCESSFUL，0 error / 0 ArkTS warning**（日志 WARN 0 行、ERROR 0 行）。
- 三个门禁：`627 refs / 154 ETS`；`175 文本文件 BOM=0 replacement=0 mojibake=0`；`154 ETS unreachable=0`。
- 15 个逻辑用例：全部 exit 0，无一行 FAIL。
- 真机像素级验证：浅色页面 `#FFFFFF`、深色 canvas `#09090B` / 卡片 `#1F1F1F`，切换两个方向都**即时**生效。

### 6. 测出来的一条工具经验（重要）

**`uitest dumpLayout` 不可靠地包含 `bindMenu` 弹出的内容** —— 菜单在独立的浮层窗口里，有时 dump 得到、有时 dump 不到。本轮因此把"菜单没打开"误判过两次（其实是开着的）。判断菜单/浮层是否出现**要看截图**，不能只看 dump；`dumpLayout` 仍然适合取常规页面的节点 bounds。

## 内联导航栏居中与输入框对齐 iOS（第 51 轮）

用户反馈两处：**进入设备详情后设备名没有居中**、**输入框样式不对**。

### 1. 内联导航栏的标题没居中（已修，且是共享组件的问题）

先量了再改：设备详情页屏幕宽 1280px（中心 640），而标题与副标题的**节点**是 `x=[175..951]`，中心 **563** —— 偏左约 26vp。

成因在共享的 `AAIosInlineBar`：它把标题放在 `layoutWeight(1)` 的中间列里，本来就已经被两侧挤到剩余空间里，却又在**尾侧**额外插了一个 `Blank().width(44 * trailingSlots)`。于是尾侧 = 44(占位) + 44(调用方真正画的那个按钮) = 88，而首侧只有 44，中间列的中心自然左移 (88−44)/2 = 22vp。

`trailingSlots` 的语义本来是"调用方在内容槽里画几个 44dp 的尾侧项"——而调用方确实已经在画它们了（`DeviceDetailScreen`/`FilesScreen`/`TerminalScreen` 各画 1 个），所以那个 `Blank` 是**重复占位**。

**改法**：换成 `Stack` —— 标题块按整条 bar 居中，并用 `sideInset()`（= `44 × max(1, trailingSlots)`）做**对称**左右内边距，于是文字中心恒等于 bar 中心，与两侧到底有几个按钮无关；长名字会在碰到按钮之前先省略。原来的 `Blank` 去掉。

**实测（同一台真机、同一页）**：

| 屏 | 改前标题中心 | 改后标题中心 | 期望 |
|---|---|---|---|
| 设备详情 | 563 | **640** | 640 |
| 终端 | — | **640** | 640 |
| 文件 | — | **640** | 640 |

（`AGENT` 那个竖向居中的分组标题一直是 640，不在这个问题里。）

### 2. 输入框（会话页 composer）改成 iOS 的玻璃等效样式

对照 iOS `Views/Chat/Composer/ChatComposer.swift` + `ChatControlMetrics.swift`：iOS 的输入框是 `.glassEffect(.regular.interactive(), in: .rect(cornerRadius: isExpanded ? 26 : 24))`，**外面**套 `.padding(.horizontal, isExpanded ? 12 : 32)`、`.padding(.top, 8)`、`.padding(.bottom, 10)` —— 没有描边，也不是白底。

鸿蒙这边原来是：`raisedSurface`（纯白）+ 写死的 `#3C3C43` 1px 描边 + 圆角 26 + 左右共 28、底部共 22。看起来就是一个**重描边的方框**，正是用户说的"不对"。

**改法**：改用本仓库既有的"玻璃材质平面等效"约定（`AAIosGlassButton` 就是这么做的）——`glassFill()` + `iosHairline()`，并按 iOS 的收起态取值：左右 32、上 8、下 10、圆角 24。为了让会话页也能用，`AAIosChrome.ets` 里的 `glassFill` 加了 `export`（`iosHairline` 本来就已导出）。

**实测**：输入框底色由 `#FFFFFF` 变为 **`#F5F5F5`**（黑 4% 叠白），描边变成发丝级，圆角 24，左右收进到 32。

### 3. 本轮验证

- `clean` + `assembleHap`：**0 error / 0 ArkTS warning**（日志 WARN 0 行 / ERROR 0 行）。
- 三个门禁：627 refs / 154 ETS；175 文件编码干净；154 ETS 0 orphans。
- 15 个逻辑用例全过。
- 真机：三屏标题中心均为 640；输入框底色 `#F5F5F5`。

### 4. 输入框支持多行增长（本轮补做，用户已确认要）

iOS 的 `ComposerDraft.isExpanded` 是 **`isFocused || !text.isEmpty || !attachments.isEmpty`** —— 是一个*状态*，不是对高度的测量。它同时决定两件事：圆角 24 ↔ 26，左右内边距 32 ↔ 12。

鸿蒙原来用的是单行 `TextInput`（固定 40 高），永远长不成两行。改成：

- `TextArea` + `.constraintSize({ minHeight: 40, maxHeight: 160 })`。160 来自 iOS 的 `maximumEditorHeight = min(160, max(72, height * 0.30))`（手机上就是 160）。
- 新增 `@State composerFocused`（由 `.onFocus` / `.onBlur` 维护）与 `composerExpanded()`，按上面那条式子判断。
- `.enterKeyType(EnterKeyType.Send)` + `.onSubmit(...)`：回车发送（Android 的 IME action 也是 Send）；否则多行框会把回车当换行。

**踩到一个 ArkUI 坑**：内边距一开始写在 composer 自己身上用 `.margin({ left, right })`，**完全不生效** —— 一个 `.width('100%')` 的子组件加水平 margin，实测两种状态测出来的 inset 一模一样（都是 20vp，只有 padding 在起作用）。改成**在调用点用一个外层 `Column` 的 `.padding()`** 给内边距，才生效。

**实测（真机）**：

| 状态 | 编辑器高度 | 左右 inset |
|---|---|---|
| 收起（空草稿、未聚焦） | 47vp | **57vp** |
| 展开（草稿非空） | 47vp | **34vp** |
| 展开 + 追加 60 字符 | **70vp**（长成两行） | — |

（两个 inset 都比标称的 48/28 大 6~9vp，是 `TextArea` 自身的内部留白；关键是两者相差约 23vp，与 32−12 的设计一致。）

**验证时的一个教训**：为了量多行增长，我往那个会话的输入框里追加了 60 个字符。**那个输入框里存着用户一条没有发出去的草稿**（"这个样式明显不对，保证和iOS一致"）——我按"追多少删多少"回删时多按了 2 下，把草稿末尾的"一致"删掉了，随后按原字符串补回并逐字符比对确认 `len=17` 与原文一致。**结论：以后在这台真机上做输入测试，先确认目标输入框里有没有用户的草稿；有草稿就换一个只读/空的目标，或者干脆不测。**

**没有动的地方**：iOS 收起态那个"单行小胶囊"会把「接管」开关收进 ＋ 的选项面板里，而鸿蒙/Android 是把这个开关常驻在输入框内的。这一条**没有**照搬——它会改变一个现有功能的可达性，需要单独确认。

### 5. 侧栏设备行没有选中态（用户反馈"侧边点击设备，不会切换设备"）

先复现：在抽屉里点 `DESKTOP-P13E1GV`，页面**确实**切到了那台设备（详情页标题显示 `DESKTOP-P13E1GV` 且居中），`openDevice()` 也正确写了 `selectedDeviceId`。所以"没切换"不是指数据没切。

对照 iOS `ChatSidebarView.swift:305`：设备行会画

```swift
.background(isSelected ? AppTheme.sidebarSelectionFill(colorScheme) : .clear, in: RoundedRectangle(cornerRadius: 9))
```

而鸿蒙的 `HomeScreen.DeviceRow` **完全没有选中态** —— 抽屉根本不知道当前是哪台设备（`HomeScreen` 连 `selectedDeviceId` 都没接）。于是"点完之后列表看起来一模一样"，用户无法判断设备切换了没有。

**改法**：给 `HomeScreen` 加 `@Prop selectedDeviceId`（由 app 传入），`DeviceRow` 按 iOS 的 `sidebarSelectionFill`（浅色黑 10% / 深色白 20%，圆角 9）画底。

**实测**：点 `DESKTOP-P13E1GV` → 返回 → 重开抽屉，该行像素由 `#FBFBFB` 变为 **`#E1E1E1`**，其余两行不变。

**同一族的另一处（本轮未做，见待确认）**：iOS 的**会话行**也吃同一个 `sidebarSelectionFill`（`ChatSidebarView.swift:350`，`isSelected: selectedSessionId == session.id`），鸿蒙的 `HomeSessionRow` 同样没有选中态。app 里已经有 `@State selectedSessionId`，只是没往下传。

### 6. 「选中设备后一直显示正在加载运行时…」+「侧边点击设备不切换」——同一个根因

用户先后报了这两条。查下来是**同一个** ArkUI 规则，断在三个地方：

**（a）`DeviceDetailScreen` 的数据成员是普通成员。** `openDevice()` 的顺序是"先 `deviceRuntimes = loadingFor(id)`、再 `navigate()`"——所以详情页**诞生在加载态**，请求回来的答案永远写不进页面（普通成员不会再被赋值），"正在加载运行时…"就永久停在那里。同理 `deviceId` / `state` 也是普通成员，而 `destination` 在设备之间**没有变化**，ArkUI 会**复用**这个组件而不是新建，于是从设备 A 的页面切到设备 B 时，页面还拿着 A 的数据。

**（b）共享的 `AAIosInlineBar.title` / `subtitle` 也是普通成员。** 设备页标题是 `this.detail().device.name`，页面确实重渲染了，但 bar 的 title 只在创建时被赋过值——所以修好 (a) 之后，页面内容换了、**标题还是旧设备名**。

**（c）侧栏没有选中态。** iOS 的 `ChatSidebarView.swift:305/350` 用同一个 `AppTheme.sidebarSelectionFill`（浅色黑 10% / 深色白 20%，圆角 9）标出当前设备行与当前会话行；鸿蒙的 `HomeScreen` 连 `selectedDeviceId` / `selectedSessionId` 都没接。

**改法**：

- `DeviceDetailScreen` 的 `state` / `deviceId` / `runtimes` / `bulkBusy` / `deviceNotice` → `@Prop`。
- `AAIosInlineBar` 的 `title` / `subtitle` → `@Prop`（共享组件，一次修好设备页/文件/终端三条 bar）。
- `AAColors` 新增 `sidebarSelectionFill(colors, selected)`；`HomeScreen.DeviceRow`、`HomeSessionRow`、`HomeProjectSessionRow` 都用它；`HomeScreen` 新增 `selectedDeviceId` / `selectedSessionId` 两个 `@Prop` 由 app 传入（5 个会话行调用点都补了 `selected:`）。

**实测（真机）**：

| 场景 | 改前 | 改后 |
|---|---|---|
| 打开设备页 | 永远"正在加载运行时…" | **Codex / 运行中** |
| 在设备页从侧栏切到 DESKTOP-P13E1GV | AGENT 换了、标题还是 jerry的Mac mini | 标题 **DESKTOP-P13E1GV**、AGENT **DeepSeek Harness / 运行中** |
| 侧栏当前设备行 | 无标记 | 底色 **#E6E6E6**（其余 #FFFFFF） |
| 侧栏当前会话行 | 无标记 | 底色 **#E6E6E6**（其余 #FFFFFF） |

**这轮最大的教训**：这条规则的排查顺序应该是"**先看哪些成员是普通成员，再看数据是否真的在变**"。"加载运行时"我一开始误判成"连接器慢/环境问题"（因为在新建会话页上也见过类似等待）；(b) 又是在 (a) 修好之后才露出来的第二层。**同一个页面里普通成员往往是成片的，修一处要顺手把同页同类的一起看。**

### 7. 「新建会话里 Agent 一直不显示」——`revision` 是个只写不读的 `@State`

用户报的第四条。这次没有猜，加了临时诊断日志（打完即删），拿到的事实让结论毫无歧义：

```
[diag] runtimes conn_1396e43f... ok 193ms count=1
[diag] settled selDev=conn_f235... selConn=conn_f235... hasAvail=true setupReason=null runtimes=2 runtimesLoading=false
```

**数据 150 毫秒就到了，而且状态完全健康**（`setupState()` 返回 `null`、`hasAvailableSelectedRuntime` 为真、`runtimes=2`、无错误）。可界面还停在「正在检查可用 Agent」+ Agent 行灰条。所以问题不在数据，在**页面根本没重渲染**。

**根因两处，都是同一条 ArkUI 规则的另一种表现**：

1. **`@State private revision` 只被写、从没被读。** 全文件 20 处 `this.revision += 1;`，但 `build()` 里没有任何地方读 `revision`。ArkUI 只重渲染**读过**某个状态的元素，所以这 20 次自增对渲染**完全无效**——页面在等待期间一直用它出生时那份 `fields`。而 `selection` 又是普通成员，于是 `configurationFields()` / 状态行 / 开始聊天按钮的可用性全都冻在初始态。**这就是"Agent 一直不显示"**。
   - 改法：`selection` → `@State`（它本来就是整对象替换，正适合 `@State`）；顺手把那个死掉的 `revision` 连同 20 处自增删掉——它没有任何行为影响，但会误导下一个读代码的人（已经误导过一次了）。
2. **`NewSessionConfigurationCard` 的 `ForEach` 键是 `field-${field.key}`。** ForEach 在**键不变时不会重跑 item 构建**，会复用已建的组件——所以即使页面重渲染、把全新的 `fields` 传下来，每一行仍然画它出生时那个 field 对象（即加载占位）。把行内容折进键（`loading` / `enabled` / `active()` / `options.length` / `value`）后，变了的行就是一个新行。
   - 这也解释了为什么第 48 轮把 `fields` 改成 `@Prop` **没能**修好 Agent 行：页面压根没重渲染，根本传不出新数组。

**实测（真机，清空数据后重开）**：

| 项 | 改前 | 改后 |
|---|---|---|
| 状态行 | 一直「正在检查可用 Agent」 | 消失 ✓ |
| Agent 行 | 灰条占位 | **Codex** ✓ |
| 模型 / 推理强度 / 权限模式 | 灰条占位 | **GPT-5.6-Terra / Low / 完全访问权限** ✓ |

**这轮验证**：`clean` + `assembleHap` 0 error / 0 ArkTS warning；三门禁（627 refs、175 文件编码干净、154 ETS 0 orphans）；15 个逻辑用例全过；临时诊断日志已全部删除（grep `[diag]` 为 0）。

**又一条教训**：`@State` **被写但没被读，等于没写**。这个仓库里有不少"自增一个 revision 来强制刷新"的写法，凡是没在 `build()` 里读过那个变量的，都是空操作。排查"数据到了但界面不动"时，先确认**触发重渲染的那个状态真的被读过**。

## 设备详情页对齐 iOS（第 52 轮）

用户给了 iOS 设备详情页的截图，要求"完全依照 iOS 检查还有啥不一样，帮我修改好"。对照 `Views/Devices/DeviceManagementView.swift` + `DeviceAgentSection.swift` + `DeviceOverviewContent.swift` + `DeviceOverviewSections.swift` 逐项重写了这一屏。

### 改了什么

| 位置 | 改成 iOS 的样子 |
|---|---|
| 表头副标题 | `<deviceOs> · <在线/离线>`（iOS `connectionDescription`），原来只有「在线」 |
| 第一段 | 段头 `Agent Runtime`（次要色）+ **右侧 44dp 重新发现按钮**（加载中转圈）；行放在一张 **28dp 圆角分组卡**里（`colors.subtle`，行间 Divider，行内上下 8dp） |
| 运行时行 | **删掉前置状态圆点/转圈**；名称 17sp/600 + `类型 · 状态` 12sp；**开关移到最右且改成绿色**；「删除配置」**移进长按菜单**（iOS 的 contextMenu 位置） |
| 第三块 | 新增 **「设备内容」+ 分段控件 [项目 \| 会话]**，切换下面那一块 |
| 项目模式 | 段头 `N 个项目` + 加号；行 = 文件夹图标 + 名称 + **等宽路径** + `N 个会话` + **文件夹 / 新建会话** 两个 44dp 按钮；长按菜单 = 重命名 / 置顶 / 复制路径 / 归档 |
| 会话模式 | 行头 = **项目下拉 + `…` 菜单 + 新建会话按钮**；筛选改成**分段控件**（活跃/已归档/全部），替掉原来的胶囊 `FilterTag` |
| 会话行 | 补上第二行说明 `runtime · 项目名` |
| **删掉** | 「工作目录」整段；**文件**改从项目行的文件夹按钮进（按该项目的路径）；**终端**移进设备操作菜单 |
| 顺手删的死代码 | `WorkspaceSection`/`WorkspaceRow`、`SectionTitle`、`FilterTag`、`SmallActionButton`、`AgentIconButton`、本来就没人引用的 `DeviceStatusLabel` |

**又抓到一条同类 bug**：这一屏原来有个 `toastRevision` 计数器，和上一节 `NewSessionScreen` 的 `revision` 一样——**只写不读**，所以定时消失的 toast 从来不重绘（只有 app 驱动的 `@Prop` 路径能看到）。已删除，改成 `@State toast`。

### 验证

- `clean` + `assembleHap`：**BUILD SUCCESSFUL，0 error / 0 ArkTS warning**（父代理独立复跑过一次，结论一致）。
- 三个门禁：`653 resource refs / 154 ETS`、`175 文件 BOM=0 replacement=0 mojibake=0`、`154 ETS unreachable=0`。
- 15 个逻辑用例：全过。
- **真机比对：未完成** —— 手机处于**安全锁屏**，`aa start` 报 `10106102 The device screen is locked`，`power-shell wakeup` 只能亮屏、解锁需要用户的 PIN。等解锁后按截图逐项比对。

### 已知偏差（不是漏做，是鸿蒙还没有对应能力）

1. **运行时「配置」按钮（iOS 的 sliders）没做**：鸿蒙没有运行时配置面板，做了就是死按钮。→ 下一批补（见待办）。
2. **「添加更多 Agent」按钮没做**：鸿蒙没有添加 Agent 的面板，暂以 iOS 位置上的桌面端提示文字代替。→ 下一批补。
3. **项目「删除」没做**：`ProjectsApi` 只有 list/create/update，`SessionsController` 没有删除项目，Android 也没有；iOS 的 `dashboard.deleteProject` 在鸿蒙没有对应接口。重命名/置顶/复制路径/归档已接。
4. **运行时「重命名」没做**：同样没有接口。
5. 「项目行 → 新建会话」只是打开新建会话页（复用侧栏同样的入口），没有预选该项目——`NewSessionScreen` 没有"预选项目"的入参。
6. 项目级"全部归档"仍走**设备级**确认与范围：`SessionsController.archiveProjectSessions` 只能归档、不能取消归档，用项目路径去接"全部取消归档"会变成归档。
7. `N 个项目` 是普通字符串不是复数形式（`app_plurals.json` 由 Android 生成），英文下可能出现 "1 projects"；中文正常。
8. `device_detail_agents_section` / `device_detail_sessions_section` 两个字符串现在没人用了，但 `app_strings.json` 是生成文件、不手改，所以留着。调色板里 `runtimeSwitchCheckedTrack`/`runtimeSwitchCheckedThumb` 也因开关改绿而暂时没人用——调色板仍与 Android `Theme.kt` 1:1 对齐，没有删 token。

### 静态复查（本轮补做，因为真机被锁屏挡住）

真机处于安全锁屏、无法装机比对，于是对这次 1800 行重写做了一遍**针对 ArkUI 规则的静态复查**（脚本查：普通成员、只写不读的 `@State`、`ForEach` 键、`width('100%')` 子组件上的水平 margin、没人调用的 `@Builder`）：

- **只写不读的 `@State`：0 个** ✓（重写时顺手删掉的那个 `toastRevision` 没有留下同类）。
- **`ForEach` 键**：`runtimeRowKey` / `projectRowKey` / `sessionRowKey` 都把可见内容折进去了 ✓；另外两个（项目下拉项、分段控件）的标签是静态的，用 id/index 没问题。
- 其余命中项都是 `@Builder` 形参、对象字面量字段、静态标签，不是问题。
- **查出并修掉一个真问题**：`actionsOpen` / `actionBusy` / `actionError` / `confirmAction` 这四个由 app 传入、且在页面存在之后会变的状态，**一直是普通成员**（重写前就是，不是这次引入的）。后果有两个：
  1. `bindSheet($$this.actionsOpen, …)` 绑在普通成员上，设备操作面板**开不出来**（app 把它置 true，子组件的普通成员不会更新）；
  2. 更严重的是 `confirmAction` 永远是 `undefined`，而它 gate 着确认卡片 —— 于是这一页上**所有需要确认的操作**（本批新加的长按「删除配置」、全部归档、删除设备）都会调完 app 之后**什么都不显示**。
  四个都改成 `@Prop` 后构建通过（app 的调用点本来就都传了）。

**真机比对（已完成，用户解锁后做的）**：装上这批包、在设备页选中截图里那台 `DESKTOP-P13E1GV`，逐项核对（节点 bounds + 截图）：

| 截图上的 iOS | 鸿蒙实测 | 结论 |
|---|---|---|
| `DESKTOP-P13E1GV`（居中） | `x=[175..1105]` → 中心 **640** | ✓ |
| `windows · 在线` | `windows · 在线` | ✓ |
| `Agent Runtime` + 右侧刷新 | `Agent Runtime` + 刷新字形 | ✓ |
| `设备内容` + 分段 [项目 \| 会话] | `设备内容` + `项目`/`会话`（选中态药丸在「项目」） | ✓ |
| `6 个项目` + 加号 | `6 个项目` + 加号 | ✓ |
| 项目行（文件夹/名称/等宽路径/N 个会话 + 两个图标按钮） | `Agents-Anywhere` / `D:\code\Agents-Anywhere` / `2 个会话` + 文件夹与铅笔按钮，灰卡 + 行间分隔 | ✓ |
| 运行时行 + 绿色开关 | 名称 + `运行中` + **绿色开关**；无前置圆点 | ✓（字形待补，见下） |
| `+ 添加更多 Agent` 醒目按钮 | 仍是桌面端提示文字 | ⏳ 由并发批次替换 |

**比对后仍差三处**：

1. **运行时行的两行文字语义**：截图是 **实例名 `DSH`** + `DeepSeek Harness · 运行中`（类型 · 状态）；鸿蒙显示的是类型名 + 状态。iOS 的规则很明确：`sessionDisplayName = name.isEmpty ? displayName : name`，第二行是 `typeDisplayName · status`。等并发批次改完那一行再修（它正在改同一个文件，避免互相覆盖）。
2. **顶栏两颗按钮没有玻璃圆底**：截图里汉堡与 `⋯` 各有一个浅色圆底，鸿蒙的 `AAIosInlineBar` 只画裸字形。这是**共享组件**的既有差异（文件/终端页同样），要改就一起改。
3. 「配置」字形按钮与「添加更多 Agent」醒目按钮 —— 正在由并发批次实现（第 53 轮那批）。

### 下一批（已确认要做，接口已核实）

用户确认两个新能力都做。接口在服务端已齐：

| 用途 | 接口 |
|---|---|
| 列出可添加的 Agent 类型 | `GET /connectors/{id}/runtime-types` |
| 重新发现类型 | `POST /connectors/{id}/runtime-types/discover` |
| 添加一个 Agent | `POST /connectors/{id}/runtimes`，体 `{runtimeType, name, config, active}` |
| 保存某个 Agent 的配置 | `PUT /connectors/{id}/runtimes/{runtimeId}/config`，体 `{config}` |

`DeviceRuntimeView` 本身就带 `schema` / `uiSchema` / `defaults` / `config`，所以配置面板不需要额外请求。工作量的大头是**按 JSON-schema 动态渲染表单**：要支持 `text`(min/max/secure)、`boolean`、`number`(integer/min/max)、`choice`(enum)、`keyValue`、`json`，以及两个自定义编辑器 `modelGateway`、`customModels`，外加 ui-schema 的字段顺序、`requiredForNamedInstance`、默认值合并与 `metadata.i18n`。两个面板共用同一个表单渲染器。

## 设备详情页补齐两个能力：运行时配置 + 添加 Agent（第 53 轮）

第 52 轮比对后剩下的两处「鸿蒙还没有对应能力」，按用户确认都做了。接口在第 52 轮已核实。

### 加了什么

| 层 | 内容 |
|---|---|
| API | `DevicesApi` 新增 `listRuntimeTypes` / `discoverRuntimeTypes` / `createRuntime`（体 `{runtimeType,name,config,active}`）/ `putRuntimeConfig`；`DevicesController` 对应四个包装 |
| DTO | 运行时的 `defaults` 原来被解析器丢掉了（配置面板要用），已补；新增运行时类型 DTO 与解析（按 iOS 把 `configSchema.schema ?? schema` 折叠）；`runtimeTypeCanAdd` 复刻 iOS 的 `V2RuntimeInventory.canAdd`（`present && 有 schema && （实例已清空 或 未达 instancePolicy 上限）`） |
| Schema 模型 | 新文件 `feature/devices/RuntimeConfigSchema.ets`：按 ui-schema `order` 排序（未知字段按名排在后面）、`requiredForNamedInstance`、`defaults`+`config` 播种草稿、`resetDefaults`、`makeConfig`，以及 iOS `RuntimeConfigValidation` 的完整移植（anyOf/oneOf/type/enum/min-max/pattern/items/required/properties，连带 iOS 自己的报错文案） |
| 表单 | 新文件 `ui/screens/devices/RuntimeConfigForm.ets`：**8 种字段全支持** —— `text`（含明文/密文切换）、`number`、`json`、`boolean`、`choice`（走 `AADropdownMenu`）、`modelGateway`、`keyValue`、`customModels`；连 `metadata.i18n` 的每个键都映射到了资源 |
| 面板 | 新文件 `ui/screens/devices/RuntimeConfigSheets.ets`：`RuntimeConfigurationSheet`（命名 + 表单 + 恢复默认 + 保存，忙碌态与服务端错误内联）与 `AddDeviceAgentSheet`（按 iOS 推荐序列可添加类型、头部重新发现、快速添加/配置两条路、同一个表单、创建走 `POST /runtimes`） |
| 入口 | 运行时行补上 **`slider.horizontal.3` 配置按钮**（在开关之前，即 iOS 的 `[config][switch]`）；Agent Runtime 段尾把桌面端提示换成 **醒目的 `AAIosPrimaryButton`「添加更多 Agent」** |
| 其它 | `AAIcons` 补 `eye`/`eye-off`（密文切换用）；`ios_strings.json` 两个语言各 +76 条 iOS 文案 |

**注意一个 ArkUI 细节**：一个节点只能挂最后一个 `bindSheet`，所以第二个面板挂在页面列上、而不是根节点上。

### 交付后我自己发现并修的四处

1. **运行时行的两行文字取错字段**（第 52 轮比对时就记下的差异）：这一行原本走 `runtimeInstanceLabels(displayName, type)`，而它的规则会**丢掉"名字等于运行时类型"的实例名**——这台设备的实例名是 `DSH`、类型是 `dsh`，小写后相等，于是标题变成类型名「DeepSeek Harness」。iOS 的规则简单得多：`sessionDisplayName = name.isEmpty ? displayName : name`。已按 iOS 改，并补上 DTO 里被丢掉的 `name` / `typeDisplayName`；第二行现在恒为 `类型 · 状态`（只有与标题**完全相同**时才省掉重复）。
2. **顶栏两颗按钮没有玻璃圆底**：像素实测按钮区域是纯白 `#FFFFFF`，而参考图里汉堡和 `⋯` 各有一个浅色圆盘；iOS 自己的 `ChatPageToolbar` 注释也写着 toolbar items "own size, spacing, **glass grouping**"。共享的 `AAIosInlineBar` 现在给首尾各一个 `groupedFill` 圆盘（`trailingSlots === 1` 时尾侧也套圆盘，多个则留给调用方），一次修好设备/文件/终端等 8 个页面。
3. **`actionsOpen`/`actionBusy`/`actionError`/`confirmAction` 一直是普通成员**（第 52 轮静态复查查出，重写前就是这样）：`bindSheet($$this.actionsOpen)` 绑在普通成员上 → 设备操作面板开不出来；`confirmAction` 永远 `undefined` → 这一页**所有需要确认的操作**（长按删除配置、全部归档、删除设备）调完 app 之后什么都不显示。四个改 `@Prop`。
4. **静态复查** 1800 行重写：只写不读的 `@State` **0 个**；三处会变内容的 `ForEach` 键都折进了内容。

### 验证

| 项 | 结果 |
|---|---|
| `clean` + `assembleHap` | **BUILD SUCCESSFUL，0 error / 0 ArkTS warning**（我自己复跑，与子代理报告一致） |
| 三个门禁 | `750 resource refs / 157 ETS`、`178 文件 BOM=0 replacement=0 mojibake=0`、`157 ETS unreachable=0` |
| 15 个逻辑用例 | 全过 |
| 真机 | **待复验**（手机又锁屏了，见下） |

### 子代理如实上报的、本批**没做**的地方（我认可这些取舍）

- iOS 保存失败后会**滚动到第一个出错字段**：ArkUI 要额外接 Scroller + 逐字段测量，本批改为在字段旁内联显示错误。
- iOS 的**未保存改动拦截**（`interactiveDismissDisabled(isSaving || hasChanges)` + 放弃确认）：本批只在上传中阻止关闭。
- 数字字段保持普通键盘：ArkUI 的 `InputType.Number` 会挡掉 `-` 和 `.`，比 iOS 的 `numbersAndPunctuation` 更糟。
- `minLength/maxLength` 按 UTF-16 计数（`text.length`），iOS 按 `unicodeScalars.count`，只有星平面字符会不同。
- 服务端错误显示为表单下方内联红字（本仓库 `DeviceActionsSheet` 的写法），不是 iOS 的 toast。
- 没有复用 `AAIosField`（66dp/20sp 的认证页字段）等输入组件，新写了 44dp 的 `RuntimeConfigInput`。

**一处规格与代码的出入**（子代理指出、我采纳）：我在规格里写的"添加 = POST /runtimes"不完整——iOS 会**先复用**该类型已存在的（被清空的）实例（保存配置 + 激活），只有确实没有时才 POST；否则单实例类型会 4xx。代码按 iOS 的来。

### 仍未完成（需要设备）

第 52 轮那批的**布局**已真机比对通过；但本批新加的东西**还没在真机上验过**：配置按钮与配置面板、醒目的「添加更多 Agent」按钮与添加面板、上面第 1/2 条两个修正。原因是手机再次进入**安全锁屏**（`aa start` 报 `10106102 The device screen is locked`，`power-shell wakeup` 只能亮屏，解锁需要用户的 PIN）。用户解锁后我要做的：

1. 装当前包 → 设备页逐项比对：运行时行应是 **`DSH` + `DeepSeek Harness · 运行中`**、有配置字形按钮、段尾是**黑色醒目按钮**、顶栏两颗按钮有浅色圆盘。
2. 点配置字形 → 面板应打开、能改字段、能保存（`PUT .../config`）。
3. 点「添加更多 Agent」→ 列出可添加类型、能走到表单。
4. 长按运行时行 → 「删除配置」→ **确认卡片应出现**（第 3 条修的就是这个）。

### 交付后的离线复验（手机锁屏期间做的）

真机拿不到，于是把「能离线验的都验完」：

- **独立复跑**：`clean` + `assembleHap` → BUILD SUCCESSFUL，0 error / 0 ArkTS warning；三个门禁 `750 refs / 157 ETS`、`178 文件编码干净`、`157 ETS 0 orphans`；15 个逻辑用例全过。（与子代理报告一致，不是照抄。）
- **对新写的 ~2100 行做 ArkUI 规则静态审查**（`RuntimeConfigSchema` / `RuntimeConfigForm` / `RuntimeConfigSheets` / `DeviceRuntimeState` / `DevicesController` / `DevicesDtos`）：
  - **只写不读的 `@State`：0 个**（这是本仓库栽过两次的坑）。
  - **输入不会被重建**：三处 `ForEach` 键折了 `rowRevision`，而 `rowRevision` 只在**增删行**时自增（`RuntimeConfigForm.ets:302/311`），**不在每次按键时**变——否则每敲一个字就会重建 `TextInput`、输入法和光标全废。这是我重点查的一条，结论是安全的。
  - 文本框的写回**同时**更新本地 `@State` 和模型（`this.text = next` + `draft.setText(...)`），所以任何无关重绘都不会把已输入的字符弹回去。
  - `width('100%')` 子组件上的水平 margin：0 处。
- **新接线也查了**：app 侧的 `deviceRuntimeTypes` / `deviceRuntimeTypesLoading` / `deviceRuntimeTypesError` 都是 `@State`；页面侧的 `runtimeTypes` / `runtimeTypesLoading` / `runtimeTypesError` 是 `@Prop`；回调是普通成员（正确，回调不需要响应式）。
- **顺手补一处一致性**：第 52 轮那批给共享 `AAIosInlineBar` 补了 iOS 的玻璃圆盘，于是「新建会话」页自己的 `NewSessionHeader` 就成了唯一还画裸字形的页面——已给它的首尾两颗 44dp 按钮补上同样的圆盘。

### 顺手修的两处一致性 + 一个测试保真度问题

1. **`DeviceConfirmDialog` 用同一个取名规则**：删除配置的确认文案原本也走 `runtimeInstanceLabels`，于是行上显示 `DSH`、确认框里却写「DeepSeek Harness」。改成与行、与配置面板标题同一个 `runtimeInstanceName`。
2. **`NewSessionHeader` 补玻璃圆盘**：给共享 `AAIosInlineBar` 补上圆盘之后，「新建会话」页自己的 header 就成了唯一还画裸字形的页面，已一并补上。
3. **测试保真度（值得记一笔）**：`check-confirm.mjs` 的 `prepare` 脚本**用手写的桩**代替了真实的标签函数，桩的兜底是 `type.toUpperCase()`，于是测试里"无名实例应回退到类型"这条**期望值写的是桩的行为（`DSH`）而不是真实实现**。这次把桩换成 `import { runtimeInstanceName } from './RuntimeIdentity.ts'`（`prepare.mjs` 本来就会把它转写到旁边），测试立刻暴露出这条期望是错的——真实（也是 iOS 的）回退是**类型显示名**「DeepSeek Harness」。期望值已改正，15 个用例仍全过。**教训：桩会让测试通过在一个假的行为上。**

### 真机复验（第 6 轮，用户解锁后完成）

四项全部通过，而且**查出了两个只有真机才能发现的 bug**（都已修好并复验）：

| 项 | 结果 |
|---|---|
| ① 布局与文案 | `DESKTOP-P13E1GV` 居中（中心 640）、`windows · 在线`、`Agent Runtime` + 刷新字形、运行时行 **`DSH`** + **`DeepSeek Harness · 运行中`**、有**配置字形**按钮、开关在最右且绿、段尾是**黑色醒目「添加更多 Agent」**、顶栏两颗按钮有玻璃圆盘（像素 `#F5F5F5` 对页面 `#FFFFFF`）——与参考截图一致 ✅ |
| ② 运行时配置面板 | 点配置字形 → 面板打开，按 schema 渲染出真实字段：`新会话默认模式`（选择）、`DSH home`（文本，带 schema 的英文说明）、`startupTimeoutMs` 30000、`requestTimeoutMs` 60000、`maxRestartAttempts` 3、`restartBackoffMs` 1000，底部 `全部恢复默认值` + `保存` ✅ |
| ③ 添加 Agent 面板 | 点「添加更多 Agent」→ 列出可添加类型：**`Codex`（推荐徽标）** 与 **`Claude`**，各带说明与 `快速添加` / `配置` 两条路 ✅ |
| ④ 长按 → 删除配置 → 确认卡 | 长按运行时行 → 菜单出现 `删除运行时配置` → 点它 → **确认卡出现**：标题「**删除 DSH 配置？**」（用的是实例名 `DSH`，说明取名规则已贯通到对话框）、正文说明会先停运行时再删配置、`取消` / 红色 `删除配置` ✅（我只点了「取消」，没有真的删除） |
| ⑤ 会话模式 | 分段切到「会话」→ 行头是 **`全部项目` 项目下拉 + `…` 菜单 + 新建会话字形**（正是 iOS 的三个尾侧控件）；下面是 **分段筛选 `活跃` / `已归档` / `全部`**；行是「标题 + `DeepSeek Harness · 项目名`」两行，尾侧状态字形与时间（now / 2h / 3h …）✅ |

**真机查出的两个 bug（都已修）**：

1. **配置面板是透明的**：宿主 `bindSheet` 用的是透明底（各面板自己画面板），而 `AddDeviceAgentSheet` 与 `DeviceActionsSheet` 都画了、**`RuntimeConfigurationSheet` 没画**——于是表单直接浮在页面上，能透过它读到 `Agent Runtime`、项目列表那些文字。已补 28dp 圆角面板 + `sheetColors().container`。
2. **「添加更多 Agent」按钮点了没反应**：加了临时诊断日志才定位到——处理函数**确实执行了**、`mode=add` / `open=true` 也都设了，但面板不出现。差别在于这条路径**同一个 tick 里还改了 app 状态**（去加载 runtime types），刚弹出的 sheet 被丢掉了；而配置面板那条路径不改 app 状态，所以正常。按 iOS 的做法修——**类型清单跟着页面加载**（iOS 的 `DeviceAgentSection` 就是用页面 model 里的 `inventory.types`），按钮只负责弹出面板。顺带删掉了因此变成死代码的 `onLoadRuntimeTypes` 属性与接线。

**又一次印证**：`uitest dumpLayout` **抓不到 `bindMenu` 弹出的菜单**（本次菜单就是靠截图才看见的，dump 里完全没有），而**截图是唯一可靠依据**——这条已经写进第 49 轮的工具经验里，本轮又踩了一次。

**没有做的事**：没有点「保存」写回运行时的配置、也没有点「快速添加」真的去创建运行时——那是会改到用户真机（那台 Mac / PC 上的 Agent 实例）的写操作，冒烟测试不该擅自做。这两条属于「功能已实现、未做端到端写验证」。

## 设备页行内边距：文字贴着卡片边、长标题相互挤压（第 54 轮）

用户反馈"页面上的字会有遮挡，需要适配屏幕宽度来优化"（附的是「会话」模式截图）。

**先量，结论和第一眼不一样**：卡片本身**没有超宽** —— 像素扫描两张截图，卡片都是 `x=[84..1195]`，左右各 84px（28vp）边距，完全对称，也不是"卡片溢出屏幕"。

真正的问题是**行内容没有左右内边距**：`GroupedCard`（28dp 圆角 + `colors.subtle` 的灰卡）**自己不画内边距**，而三种行（`DeviceRuntimeRow` / `ProjectDirectoryRow` / `SessionDetailRow`）都只有 `.padding({ top: 8, bottom: 8 })`。于是：

- 会话行右侧的时间（`now` / `3h` / `19h`…）直接顶在卡片边界上（实测节点 x1 = 1196，卡片右边 = 1195，**余量 0**）；
- 运行时段最右的开关、项目行最右的铅笔按钮同样贴边；
- 长标题/长说明与右侧时间之间只剩十几像素，看起来就是"字挤在一起/被挡"。

**改法**：给这三种行加 `left/right: 16` 内边距（iOS 的 `GroupBox` 本来就会给内容留白），**分隔线保持通栏**（与参考图一致）。

**实测（节点 bounds，卡片右边 1195）**：

| | 改前 | 改后 |
|---|---|---|
| 会话行时间 x1 | **1196（余量 0px）** | **1140（余量 55px ≈ 18vp）** |
| 行标题 x0 | 175 | 231 |
| 长标题 | 与时间相互挤压 | **省略号截断**（`SpringBoot4与Vue3全栈项…`） |
| 长说明 | 同上 | **省略号截断**（`DeepSeek Harness · zhejiang---erp---…`） |

**验证**：`clean` + `assembleHap` 0 error / 0 ArkTS warning；三门禁 `750 refs / 157 ETS`、`178 文件编码干净`、`157 ETS 0 orphans`；15 个逻辑用例全过；真机复验（截图 + 节点 bounds）。

**一个测量方法的教训**：第一次我用"扫最右侧深色像素"来找裁切，但那行时间是 `colors.faint`（#AAA8A2，R=170），根本不在我的"深色"阈值里，于是得出了"8px 余量"的错结论。**量文字位置要用节点 bounds，不要用颜色阈值猜**。

## 关掉配置面板后整页被灰层挡住、点不动（第 55 轮）

用户反馈：设备详情页点 Agent 的配置按钮弹出面板，**关掉之后应用就点不动了，有一层灰色挡住**。

**复现与定位（真机）**：按步骤走一遍，并量关闭后的像素——页面读数是 `#B8B8B8`，正好是白色叠上 `maskColor` 的 28% 黑；**关闭前、关闭中、关闭后三次采样完全一样**，说明灰层常驻。再看节点树，问题一目了然：

```
SheetWrapper x[0..1280] y[137..2832]
  SheetPage  x[0..1280] y[164..2832]     ← 面板还在「呈现」着
    Column   x[56..1224] y[163..164]     ← 内容只剩 1px
    Scroll   x[0..1280] y[164..2832]     ← 空的
```

也就是**面板仍处于弹出状态、但内容被清空了**——只剩它自己的遮罩盖住整页，于是"看着像一层灰、点什么都没反应"。

**根因**：`closeRuntimeSheet()` 在**同一个 tick 里**既把 `runtimeSheetOpen` 置 false、又把 `runtimeSheetMode` 清成 `''`；而 `runtimeSheetMode` 正是面板内容的判断依据，于是 ArkUI 收到的是一个"空页面的正在关闭的 sheet"，遮罩留了下来。（对比：**添加 Agent** 那条路径当时因为同一个 tick 里改了 app 状态而**根本弹不出来**，第 53 轮已修——两条其实是同一类"状态同 tick 打架"。）

**改法**：关闭时只置 `runtimeSheetOpen = false`，把内容清空**推迟到关闭动画之后**（`setTimeout(..., 400ms)`），并加保护——若这段时间里用户又打开了面板（`runtimeSheetOpen` 为真）就不清，避免把新面板清空。三条关闭入口（面板的 X、`shouldDismiss`、下拉关闭）都走这一个方法，所以一处修好。

**实测（真机）**：

| | 改前 | 改后 |
|---|---|---|
| 关闭后页面像素 | `#B8B8B8`（被 28% 遮罩压暗） | **`#FFFFFF`** |
| 节点树里的 `SheetWrapper` | 仍在（空 `SheetPage`） | **消失** |
| 关闭后再点分段控件 | 无反应 | **正常切换**（实测切到「会话」，出现 `全部项目` / `活跃`） |

**验证**：`clean` + `assembleHap` 0 error / 0 ArkTS warning；三门禁 `750 refs / 157 ETS`、`178 文件编码干净`、`157 ETS 0 orphans`；15 个逻辑用例全过。

**又一条自查教训**：中途我用"dump 里有没有 `全部项目` / `活跃`"判断切换是否生效，得出过一次"无反应 ✗"的错结论——其实模式已经切过去了，是我的检测函数写错（PowerShell 里把 `if` 当表达式用直接抛异常）。**判断"能不能点"不要靠一次间接推断，要直接看目标状态的节点/像素。**

## 「设备内容」旁的分段控件比 iOS 宽了一倍多（第 56 轮）

用户反馈设备详情页「设备内容」旁边的 项目/会话 切换"UI 不适配"。

**量化对比**（同一张参考截图 + 真机截图，按像素量控件中间行的轨道宽度）：

| | 控件轨道 |
|---|---|
| iOS 参考截图 | `x=[955..1209]`，**254px（85vp）** |
| 鸿蒙（改前） | `x=[573..1189]`，**616px（205vp）** —— 2.4 倍宽 |
| 鸿蒙（改后） | `x=[940..1195]`，**255px（85vp）** ✅ |

**根因**：`SegmentedControl` 本身没问题（32dp 轨道、28dp 白色药丸、13sp/600 标签，几何与文件页一致），是**调用点把宽度写死成 `Column().width(180)`**。而 iOS 的 `contentPicker` 用的是

```swift
contentPicker.fixedSize(horizontal: true, vertical: false)   // DeviceManagementView.swift:193
```

也就是**按内容自适应**。于是鸿蒙这边两个分段被拉到 180vp，标签在超宽的药丸里显得散、整条控件顶着页面左半边。

**改法**：把宽度改成按标签内容算出来（`segmentedControlWidth()`：13sp 下 CJK 约 13dp/字、拉丁约 7dp/字，每段 16dp 内边距，44dp 为 iOS 的最小段宽），两个标签只算一次（`contentLabels()`），宽度与所画内容永远一致；英文（Projects / Sessions）会自动变宽而不会被截断。**会话筛选那条保持不变**——iOS 的 session filter 没有 `.fixedSize`，本来就该撑满。

**验证**：`clean` + `assembleHap` 0 error / 0 ArkTS warning；三门禁 `750 refs / 157 ETS`、`178 文件编码干净`、`157 ETS 0 orphans`；15 个逻辑用例全过；真机复验（截图 + 像素实测 255px，与参考图一致）。

**这一轮的方法论**：用户说"UI 不适配"时，**先把参考截图和真机截图都量出来**（这次是量轨道的像素宽度）比凭观感调参快得多，也让"改到什么程度算对"有了明确判据（85vp）。

## 分段控件的白药丸压在轨道边框上（第 57 轮）

用户反馈「项目和会话的切换按钮……按钮与边框有点叠一起了」。放大看确实如此：**白色药丸的左右边缘正好落在轨道的圆角边框上**。

**根因**：`SegmentedControl` 是「一个 Stack + 一个单独画的药丸 + 一行标签」的结构——

- 标签那行有 `padding(2)`，所以文字是内缩 2dp 的；
- 但药丸是**另一个兄弟节点**，用 `margin({ left: pillOffset(), top: 2 })` 定位，而 `pillOffset()` 返回的是**百分比**：`0%` / `50%`，宽度也是 `50%`。

于是选中第一项时药丸左边 = 0%（压在左边框上），选中第二项时药丸右边 = 100%（压在右边框上）——**轨道那 2dp 的内边距只作用到了文字，没作用到药丸**。

**改法**：不再单独画药丸，改成**让被选中的那一段自己当药丸**——每个分段就是一个 28dp 高、圆角 7dp 的单元格，选中时上白底和阴影。这样它天然继承轨道自己的 `padding(2)`，四边都内缩 2dp（与 iOS 选中药丸 2pt 内缩一致），而且**不需要任何百分比换算**。顺手删掉了因此不再使用的 `segmentWidth()` / `pillOffset()`。

**注意 `ForEach` 的键**：药丸位置现在属于"内容"，所以键要带上选中态（`` `segment-${index}-${this.selectedIndex}` ``）——否则切换时 `ForEach` 不会重建条目，药丸不会动。这正是第 47 轮那条教训。

**实测（真机像素）**：

| | 改前 | 改后 |
|---|---|---|
| 选中「项目」，药丸左边距 | **0px（压在边框上）** | **7px ≈ 2vp**（含阴影量测误差） |
| 选中「会话」，轨道右缘内侧像素 | 白色（药丸压到边） | **`#E9E9E9` 轨道灰**（药丸内缩） |
| 上下内缩 | 2dp（本来就有） | 2dp |

**验证**：`clean` + `assembleHap` 0 error / 0 ArkTS warning；三门禁 `750 refs / 157 ETS`、`178 文件编码干净`、`157 ETS 0 orphans`；15 个逻辑用例全过。同一个组件也被本页的**会话筛选**（活跃/已归档/全部）复用，所以那条一起修好了。

## 待确认问题

- **会话行是否也要加选中态**：见上一节第 5 条末尾。iOS 有，鸿蒙没有；改动很小（`HomeScreen` 加一个 `@Prop`、2 个 `HomeSessionRow` 调用点、组件加背景）。
- **输入框收起态是否照搬 iOS 的"单行小胶囊"**：见上一节第 4 条末尾。照搬的话「接管」开关要从输入框里移走（iOS 放在 ＋ 的选项面板里），属于交互改动，等确认。
- **主题切换只重绘"被重建的子树"（系统性问题，已记录）**：每个组件几乎都把 `colors` 当普通成员接收，所以切换深浅色时只有**重建过的**子树拿到新调色板。现在唯一的"切换时仍挂载"的页面是设置页，已按第 50 轮第 2 条修好；其余页面在导航时重建，所以表现正常。若要彻底免疫，需要把 `colors` 系统性改成 `@Prop`（约百处、且 `@Prop` 对对象是深拷贝，建议改用 `AppStorage` + `@StorageProp` 的共享主题），建议与下面那条同类清单合成一轮做。
- **同类状态不同步的存量清单（第 49 轮审计）**：见上一节第 6 条的 15 组 HIGH，已确认"普通成员的 `updateStateVars` 为空"这一机制来自编译产物。建议**单开一轮**批量改 `@Prop` 并逐条真机抽查；本轮为避免范围蔓延没有动。
- **签名配置需要用户决策**：本机 `harmony/build-profile.json5` 现在带有 DevEco Studio 自动生成的 `signingConfigs`（`material` 指向 `C:\Users\Administrator\.ohos\config\...`，并含 `keyPassword`/`storePassword` 字段）。这既是好事（能产出可安装的 `entry-default-signed.hap`），也是隐患：绝对路径换机即失效、口令字段不应入库。提交前建议二选一：删掉 `signingConfigs` 与 `"signingConfig": "default"` 回到"未签名但到处能构建"，或改成从环境变量/本地未入库的 profile 读取。`harmony/README.md` 的签名一节已如实说明。
- 是否需要发布签名与上架流程（当前产物含一个本机调试签名）。
- 应用内更新在鸿蒙上是否改为引导至应用市场，或只做版本提示（当前按差异表实现为"打开下载页"）。
- 平板 / 2in1 的多列布局已按 iOS 的 `NavigationSplitView` 实现（见第 41 节），断点 840vp、左栏 320vp、侧栏折叠（第 42 节）是否需要调整，仍待实机确认。
- 首页现在只有 iOS 侧栏的内容（设备分组 / 配对 / 置顶 / 项目 / 未分组），卡片与搜索已删；「终端」「文件」移到了设备详情页的"工作目录"分组。是否接受这个入口位置，还是希望它们以行的形式回到侧栏？
- 手机端抽屉已按 iOS 补上跟手拖拽、左侧边缘滑出、弹簧收放，以及卡片的白色纱 + 1px 描边；未做的只有 `ConcentricRectangle` 的圆角计算与卡片纱上的高光。实机手感（拖动跟手度、边缘触发宽度 44vp）待确认。
- 分栏下的前导按钮已按 iOS 分工：会话详情、新建会话、设备详情、会话列表是"收起侧栏"；文件 / 终端 / 归档 / 配对向导仍是返回或关闭（iOS 里它们是 sheet，设备列表 iOS 没有）。若希望这几页也换成收起侧栏，需要先确认返回路径。**第 43 轮后**：会话详情、新建会话、设备详情在两种布局下都是"开/关会话列表"，只在手机上是抽屉、宽屏上是左栏。
