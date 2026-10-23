# HarmonyOS 端开发 Handoff（DevECode 接续说明）

工程：仓库根 harmony/ 目录。
鸿蒙工程：harmony/ 目录（bundle com.agentsanywhere.app，**兼容 API 12+（compatibleSdkVersion 5.0.0(12)），target API 26**）。
参考实现：本仓库 android/app/src/main/java/com/agentsanywhere/app（Kotlin，分层规则见 android/ARCHITECTURE.md）。
契约：本仓库 contracts/ 与 docs/api/。Server 当前 2.1.0。

## 模块拆分（2026-10）

自单模块 entry 起按「common → network → session → terminal → files」顺序抽取，每步独立提交且构建绿色，源文件均为纯 move（git rename 100%）：

- common（HAR）：designsystem/i18n/utils/纯工具 13 文件 + FileViewSupport（零网络依赖共享组件）
- network（HAR）：api/ 13 文件（ApiClient、领域 API、DTO、RealtimeWebSocket）
- session（HSP）：auth 全部、SharedApiClient、会话域 store/组件/页面 40 文件，自带 router_map 与 293×3 字符串资源；DiffCodeView/ConfirmDialog/StateViews 等被多域复用的组件在此
- terminal（HSP）：TerminalEmulator/TerminalRender/TerminalPage
- files（HSP）：FilesPage/SessionAgentFilesPage/FileRowMenuOverlay
- entry 仅剩：EntryAbility/EntryBackupAbility、Index 壳、设备域 3 页面、AnnouncementGateOverlay、DevicePairingFlow

拆分要点：HSP module.json5 的 `type: shared` 必填 `deliveryWithInstall: true`（schema 00303038）；HSP/HAP 的 BuildProfile 生成在 `<module>/build/default/generated/profile/default/`（HAR 在模块根，均已 gitignore）；HSP 页面资源（$r）不回退到 HAP，需按引用过滤复制到模块 resources（3 locale）。

## 构建（devecocli 可用）
- **devecocli 1.3.4 可用**（`devecocli build` / `devecocli build clean`），正常构建直接用它；以下 hvigorw 为备选路径：
  & "D:\ProgramFiles\DevEco Studio\tools\hvigor\bin\hvigorw.bat" --mode module -p product=default -p module=entry@default assembleHap
  （Node 使用 DevEco Studio 自带的 Node，无需 devecocli。）
- **必须先设环境**（hvigor daemon 会继承，改环境后要 --stop-daemon）：
  $env:DEVECO_SDK_HOME = "D:\ProgramFiles\DevEco Studio\sdk"
  $env:Path = "D:\ProgramFiles\DevEco Studio\jbr\bin;$env:Path"  # PackageHap 需要 java，否则 spawn java ENOENT
- 最近一次构建：**BUILD SUCCESSFUL（compatibleSdkVersion 5.0.0(12) 下通过，devecocli clean 全量 59s）**，仅 WARN（deprecated API / crypto may-throw / system-capacity / PATCH @since 26 降级提示，均不阻断）。

## 已完成
- 脚手架 + build（hvigorw build 通过）
- 公共层：common/Json.ets、ApiUrls.ets、ApiException.ets
- API 层：api/ApiClient.ets、AuthApi、SessionsApi+SessionDtos（含 RuntimeNotice DTO + notices/respond 端点）、DevicesApi、FilesApi、TerminalApi、RealtimeApi+RealtimeDtos+RealtimeWebSocket
- 认证：auth/AuthSessionStore、LoginServer、WebLoginModels（PKCE S256）
- 导航：Index 为唯一 @Entry + Navigation(Stack) + 系统路由表（resources/base/profile/router_map.json，module.json5 已挂 "routerMap": ""）；注意路由表字段名是 **buildFunction**（不是 buildMethod，schema 校验会拒绝）
- 页面：
  - pages/Index（登录门禁 + Navigation 宿主）
  - pages/LoginPage（Web PKCE 登录）
  - pages/HomePage（会话列表，入口：Devices/Terminal/Files）
  - pages/SessionDetailPage（timeline 渲染、user/assistant 气泡、markdown-lite 代码块分段、审批 notice 卡片 + respond、composer 乐观消息 + interrupt、历史分页、实时 WS 接入含 events 恢复与重试）
  - pages/DevicesPage（设备列表、展开 runtime 配置、重命名、删除、配对占位）
  - pages/TerminalPage（terminals-v2 复用/创建、WS 流式输出 base64 编解码、输入、重连、resize 占位、ANSI 清洗）
  - pages/FilesPage（设备选择、目录列表（目录优先排序）、进目录/上级、文本文件查看、binary/truncated 提示、**根路径切换（~ / / / 自定义路径选择器）**）
  - pages/ProfilePage（个人信息、改密码、**邮箱绑定：send-email-code → 验证码弹窗 bind-email 两步入驻流程**、语言切换、登出确认）
  - 会话详情能力驱动 UI（capability gating）：
    - GET /sessions/{id}/runtime/capabilities → hasCapability(set, id) + RemoteRuntimeCapabilitySet
    - Share：POST /sessions/{id}/shares（scope=session, itemIds=[]）→ 用 context.openLink(shareUrl) 拉起系统分享/浏览器
    - Takeover：patchSession 的 	akeover 字段，由 capabilities 控制开关显示

## 已知偏差/缺口（下轮可选）
1. 实时是 WebSocket（Server 无 SSE 端点），payload 简化为 {session,item,items,state,eventCursor}；notices 不走 WS（runtime.notice.* 事件触发重新拉取），catalogs 未移植（capabilities 已移植）
2. 会话详情：附件只占位（上传 API 未接）；无 slash-command 解析；markdown 仅代码块分段，无标题/列表/加粗
3. 终端：无真实 resize（创建时 80x24）；无持久后台服务；断线仅手动/进入时重连（fromSeq=lastSeq）
4. 文件浏览：无重命名/上传/下载（根路径切换已完成）
5. 设备管理：配对流程仅占位（未做 create device + token 展示 / pair-code claim）
6. 首页会话列表未接 dashboard 实时刷新；创建会话入口为底部 Sheet（已做，是否与 Android 完全一致待 UI 验证）
7. 模拟器 UI 验证已大量完成（API 26 Mate 80 + API 13 Phone API13，见 hmo-vs-android-gap-list.md 与本文档验收记录）；真机（尤其 API 12 最低版本设备）未验证；深色模式重渲染已在 P2 补齐 @StorageProp
8. 客户端自动更新：downloadUpdate 目前用 context.openLink(downloadUrl) 兜底，未做真实下载/安装

## 本次适配（API 12+）
- **compatibleSdkVersion 26.0.0 → 5.0.0(12)**（targetSdkVersion 保持 26.0.0）。
- **审计方法**：Node 脚本解析 SDK d.ts 的 `@since` 标注（扫描导入成员/链式属性/组件/控制器方法），辅助 devecocli check compat（13→24，307 条记录）交叉验证。
- **审计结论**：真正 API 12 不可用项只有 2 个，均已处理：
  1. `http.RequestMethod.PATCH`（@since 26）→ patchJson 降级 POST + `X-HTTP-Method-Override: PATCH`，Server 端 `agent_server/infra/http_method_override.py` 中间件重写（已单独验证通过；server 全量 pytest 因本机无 Docker/PostgreSQL、uv git 依赖拉取失败未跑）。
  2. `motion.*`（模块整体 @since 15；HoldingHandStatus/holdingHandChanged/DETECT_GESTURE 均 @since 20）→ **原审计"canIUse 守卫即可"结论有误**：静态 `import { motion } from '@kit.MultimodalAwarenessKit'` 在 API 12 上页面模块加载即崩（requireNapi 失败，canIUse 来不及执行），且 `ohos.permission.DETECT_GESTURE`（@since 20）声明会导致 API 12 安装失败（"install failed due to grant request permissions failed"，权限无法按设备条件声明）。**已修复**：HomePage 改订阅 `operatingHandChanged`（@since 15，语义为操作手，对"FAB 靠近拇指"更贴切），权限换成 `ohos.permission.ACTIVITY_MOTION`（**@since 7**，API 12 完全认识，user_grant 需运行时弹窗授权，拒绝则 FAB 保持右侧静默降级），motion 模块改为 canIUse 守卫内**动态 import**（API 12 上永不加载该模块，零崩溃零安装风险）。附带收益：功能可用范围从 API 20+ 扩大到 API 15+。
- **确认安全（≤12）**：SymbolGlyph(11)、openLink(12)、Font.registerFont(10)、cameraPicker(11)、ScanKit(9-11)、webview(9-10)、UIContext(10-12)、cryptoFramework、vibrator、backgroundTaskManager、wantAgent、fileIo、preferences 等全部 ≤ API 12；编译期 `fill`/`PATCH`/`motion` 的 @since 26/15/20 告警均为「新重载/新枚举成员」误报（旧重载 ≤ 12 仍可用）。
- **AGENTS.md / 本文档**同步更新最低版本说明。

## 本次品牌化 + 语言切换优化
- **品牌图标**（与 Android 端一致，取材 android/app/src/main/res）：
  - 分层图标 background.png（1024x1024 纯白，对应 Android `@android:color/white`）+ foreground.png（直接拷贝 `drawable-nodpi/ic_launcher_foreground.png`，1024x1024 透明底黑色 AA 标志，自带安全区留白），AppScope 与 entry 各一套。
  - startIcon.png（144x144）：白色圆角底（rx 匹配品牌 37/180）+ 前景缩放合成，亮/暗启动页背景（白/黑）下均可见。
  - 生成脚本：C:\Users\Qiao\AppData\Local\Temp\deveco\gen-icons-from-android.ps1（临时，勿提交）。早期用 web icon.svg 渲染的黑底白标版本已被否决（与 Android 端不一致）。
- **切换语言卡顿修复**（LanguageSettings.ets）：
  - 根因：setLanguage 同步调 `i18n.System.setAppPreferredLanguage` → 整棵可见页面树同帧重建；且语言变更触发 EntryAbility.onConfigurationUpdate → loadAndApply → 再次 setAppPreferredLanguage，造成重复配置变更/重渲染。
  - 修复：① `lastAppliedLocale` 守卫，已应用过的 locale 直接跳过，阻断回环；② 交互路径 `setLanguage` 只延迟 300ms 应用系统语言（persist + AppStorage 选中态仍即时更新，勾选行当帧响应）。
  - 未在真机实测帧率，构建已通过。

## API 13 模拟器验收（compatibleSdkVersion 附近实测）
- **镜像情况**：华为模拟器镜像目录最低 **API 13（HarmonyOS 5.0.1）**，API 12 无镜像可下载——API 12 只能真机验证。本机已下载 API 13 镜像，创建实例 "Phone API13"（127.0.0.1:5557）。
- **实测结论**（本地签名 HAP，devecocli build SUCCESSFUL 后部署）：
  - 安装成功（compatibleSdkVersion 5.0.0(12) 的 HAP 可装 API 13）✓；启动正常，全程 **3 次崩溃日志检查均无 jscrash** ✓
  - OAuth Web 登录全链路通过（PKCE WebView → 回调 → token 交换 → 进入主页）✓
  - 主页项目树（Agents-Anywhere / 11 / dsit-v2.0r00f00）、项目行点击原地展开会话列表 ✓
  - 设备页（工作笔记本在线 "1 个 Agent 在线"、DESKTOP-BO6LFMF 离线、添加新设备行）✓
  - 文件页（工作笔记本 → 这台电脑 → C:/D:/E: 盘符列表）✓
  - 会话详情页（Timeline 消息、"推理了 37 次, 执行了 62 次工具" 组摘要、DSH · idle + live 徽章、Load earlier messages、接管按钮）✓
- **未覆盖**：PATCH 降级路径（API 13 上 `http.RequestMethod.PATCH` 已存在，不触发 fallback，需 API 12 真机）；API 12 安装/运行（无镜像无设备）。
- **API 13 工具坑（供后续验收复用）**：`snapshot_display` 不支持 `-t` 参数（devecocli ui screenshot 失败）且**只接受 `.jpeg` 后缀**（`.png` 报 invalid suffix）；devecocli `ui layout` 在 API 13 上 dump 失败（ENOENT），改用 `hdc shell uitest dumpLayout -p <path>` 导出无障碍布局树后 `file recv` 拉回解析，节点带 bounds 坐标，可精准驱动点击。

## 本次补齐（P2）
- **暗色模式重渲染**：getColors() 原本以非响应式方式读 AppStorage，没有任何 @Component 订阅 APP_IS_DARK_KEY，导致系统/手动切换主题时页面不重绘。已在 14 个文件、17 个 struct 上加 @StorageProp(APP_IS_DARK_KEY) themeIsDark: boolean = false;（ConfirmDialog 是 @CustomDialog，不支持该装饰器，已跳过——dialog 在 open() 时重建，仍通过 getColors() 生效）。EntryAbility 的 onConfigurationUpdate→syncTheme 已正确维护该 key。
- **更新弹窗令牌化**：AppUpdatePromptOverlay.ets 原先硬编码 #111827 / #2563EB 等十六进制与 Color.White，违反 ColorTokens 规则；已改写为使用 getColors() 令牌（headingText / muted / inkSoft / secondaryActionSurface / onPrimaryAction / primaryAction / dialogSurface）。downloadUrl 字段保留以兼容调用点。
- 说明：HarmonyOS 端无法像 Android 那样自装 APK；真实 HAP 自更新需要 AppGallery/企业签名（ohos.permission.INSTALL_BUNDLE），本自托管分发模式不满足，故 openLink 仍是更新动作（即打开下载页人工侧载），属诚实的可达成对齐。

## 本次修复记录（编译通过前）
- ProfilePage.ets：修复 build() 末尾括号错位（.title/.onReady 误挂 Column → 改为挂 NavDestination），$r(...) as string 非法强转、errorMessage 类型不匹配、.alignSelf(VerticalAlign.Center)（Column 应用 ItemAlign）、session_expired 未知资源 → 改为字面量。
- SessionsApi.ets：补 RemoteRuntimeCapabilitySet import（getSessionRuntimeCapabilities 返回类型引用）。

## 硬性约束（上一轮经验）
- ArkTS：不允许 any/unknown；build() 内禁止局部变量/switch/三元/console；ForEach 必须 key；catch 不写类型注解
- 接口若要用对象字面量实现（如 Listener），成员必须写成**函数类型属性**（onOpen: () => void），方法签名（onOpen(): void）会触发 arkts-no-untyped-obj-literals
- webSocket.WebSocket（API 26）没有 destroy()，用 off() + close() 释放
- ctx.pathInfo.param 是 unknown，需 s string 收敛后再 typeof 校验
- RequestMethod.PATCH 从 API 26 才有：ApiClient.patchJson 运行时检测 `http.RequestMethod.PATCH`（API 12 上为 undefined），不支持时降级为 POST + `X-HTTP-Method-Override: PATCH`（Server app.py 已加对应中间件）
- **@kit 模块整体 @since > compatibleSdkVersion 时，静态 import 会在低版本设备页面加载即崩**（canIUse 守卫救不了 import 本身）；必须改成 canIUse 守卫内**动态 import**。同理 requestPermissions 里声明高版本才有的权限会导致低版本安装失败，且无法按设备条件声明——只能换成低版本就存在的等价权限
- **动态 import 必须用 `@ohos.*` 底层路径，不能用 `@kit.*` 路径**（实测）：kit 是编译期 shim 无运行时实体，`await import('@kit.MultimodalAwarenessKit')` 编译通过但运行时解析为**空模块**，`kit.motion` 为 undefined；正确写法 `await import('@ohos.multimodalAwareness.motion')` 后经 `.default` 访问命名空间成员。且命名空间**不能赋给中间变量**（arkts-no-ns-as-obj 报错），须 `motionModule.default.on(...)` 链式访问
- **无摄像头设备（模拟器）上 `cameraPicker.pick` 返回 undefined 而非 Promise**（syscap stub），直接 `.then` 会崩页（实测 jscrash "Cannot read property then of undefined"）；须 `const picked: Promise<PickerResult> | undefined = cameraPicker.pick(...)` + undefined 守卫，同 PATCH 处理模式
- 不引入新 npm 依赖；如需先报告
- 每个模块写完先 arkts_check 再 build，失败立即修
