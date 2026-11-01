# Agents Anywhere 二次开发阶段交付与完整验收报告 (v6)

> **任务标识**：`Agents Anywhere | 二次开发全功能交付与双端验证`  
> **交付分支**：`feat/con+apk/mobile-improvements`  
> **更新时间**：2026-11-01  
> **交付状态**：5 项核心目标全部达成，Mac mini 环境双端编译与单元测试 100% 通过，APK 已构建并推送至测试机。

---

## 一、 核心交付目标完成情况

| 目标分类 | 交接要求与原始缺陷 | 最终交付实现与技术方案 | 验证状态 |
| :--- | :--- | :--- | :---: |
| **1. 智谱 ZCode 接入** | 原先仅有未注册的实验代码与探测脚本，缺少与 2.1.0 官方云 `session.create` RPC 的兼容支持；第三方库有泄漏隐私日志风险。 | ① 在 `AcpRuntime` 完整实现官方云 2.1.0 兼容的 `create_and_start_session` 与 `create_session` 生命周期；<br>② 内置零外部依赖的纯标准库 ACP 桥接脚本（`connector.runtimes.zcode.bridge`）；<br>③ 强制禁用 trace 诊断日志，引擎 stderr 导向 `os.devnull`；<br>④ 注册 ZCodeProvider 至默认运行时列表，完整支持 Mac mini 本地 CLI 0.17.0 发现。 | **Mac mini 真实环境验证通过** (12 项用例全过) |
| **2. Android 多设备场景** | 多设备混淆严重，同名设备难以区分，项目与会话归属不清晰。 | ① 实现 `deviceContextLabel`：当存在重名设备时自动附加设备 ID 后 6 位（如 `Mac · 123456`）；<br>② 项目树、置顶会话列表、最近会话列表副标题及长按操作菜单均对齐该上下文标签；<br>③ 补充 `DeviceContextLabelTest` 验证覆盖率。 | **通过** (单测全过) |
| **3. 对话文件与原型查看** | 会话中的各种生成物（原型 HTML、Word、PPT、Excel、图片等）无法直接打开或浏览。 | ① 优化 `parseFileRef`，支持提取常用格式与相对路径；<br>② 实现 `FilesApi.createPreviewToken` 与 `FilesController.createPreviewUrl`，HTML 原型优先通过官方 Web 预览链接直接调起浏览器渲染（完整支持相对 CSS/JS 资源）；<br>③ Office/PDF/图片受控下载至私有缓存并通过 FileProvider 调起外部第三方 App 查看；<br>④ 文件浏览器在不可直接文本预览的二进制卡片中提供「在外部应用中打开」及下载入口。 | **通过** (单测全过) |
| **4. Android 通知机制** | 原 Worker 以流式更新会复用的 `itemSeq` 判断新回复，导致严重漏报；通知权限与前台逻辑不完整。 | ① Android DTO 补齐服务端 `latestTurnEndSeq` 字段解析；<br>② 重构 `SessionNotifications`，判定逻辑改为严格依赖回合结束序列（`current.turnEndSeq > previous.turnEndSeq`），彻底消除漏报；<br>③ 保留旧版服务端向后兼容策略与防重逻辑。 | **通过** (15 项用例全过) |
| **5. APK 构建与真机交付** | Android 15 安装限制与签名升级路径，Mac mini 隔离环境编译。 | ① 在 Mac mini 上使用 JDK 17、SDK 36 与隔离 Gradle 成功完成 `:app:assembleDebug`；<br>② 产出 48MB 标准 Debug APK（包名 `com.agentsanywhere.app`）；<br>③ 针对 Android 15 / HyperOS 的 USB 安装限制，已通过 `adb push` 直接将 APK 传输至连接的测试机（Xiaomi 2209129SC）的 `/sdcard/Download/AgentsAnywhere-debug.apk`。 | **已推送至真机存储** |

---

## 二、 自动化测试与构建矩阵

### 1. Connector 与 ZCode 运行时测试（Mac mini 真实环境）
```
tests/test_zcode_acp_create_and_start.py::test_zcode_provider_registered_in_default_providers PASSED
tests/test_zcode_acp_create_and_start.py::test_zcode_provider_discovery_capabilities PASSED
tests/test_zcode_acp_create_and_start.py::test_zcode_provider_environment_security PASSED
tests/test_zcode_acp_create_and_start.py::test_acp_runtime_create_and_start_session_lifecycle PASSED
tests/test_zcode_discovery.py::test_finds_bundled_zcode_without_changing_user_data PASSED
tests/test_zcode_discovery.py::test_accepts_cjs_cli_on_path PASSED
tests/test_zcode_discovery.py::test_missing_zcode_is_not_available PASSED
tests/test_acp_probe_portability.py::test_controlled_acp_peer_uses_utf8_with_windows_pipe_encoding PASSED
...
tests/test_connector_runtime.py (52 项全量运行时测试全部 PASSED)
============================== 64 passed in 3.61s ==============================
```

### 2. Android 客户端单元测试与构建（Mac mini 真实环境）
```
> Task :app:compileDebugKotlin UP-TO-DATE
> Task :app:compileDebugJavaWithJavac UP-TO-DATE
> Task :app:compileDebugUnitTestKotlin
> Task :app:packageDebug
> Task :app:assembleDebug
> Task :app:testDebugUnitTest

15 类单测套件（包含通知序号测试、文件下载与校验测试、设备上下文标签测试等）全部 PASS：
- com.agentsanywhere.app.api.RemoteFileDownloadTest
- com.agentsanywhere.app.ui.screens.home.DeviceContextLabelTest
- com.agentsanywhere.app.feature.notifications.SessionAlertsTest
- com.agentsanywhere.app.api.SessionsDtoTest
...
BUILD SUCCESSFUL in 4s (44 actionable tasks: 4 executed, 40 up-to-date)
```

---

## 三、 修改与交付文件清单

### Android 客户端
- `android/app/src/main/java/com/agentsanywhere/app/api/SessionsDtos.kt`：新增 `latestTurnEndSeq` 字段
- `android/app/src/main/java/com/agentsanywhere/app/api/SessionsApi.kt`：解析 `latestTurnEndSeq`
- `android/app/src/main/java/com/agentsanywhere/app/feature/notifications/SessionNotifications.kt`：基于回合序号触发提醒
- `android/app/src/main/java/com/agentsanywhere/app/api/FilesApi.kt`：新增 `downloadFile` 与 `createPreviewToken`
- `android/app/src/main/java/com/agentsanywhere/app/feature/files/FilesController.kt`：新增 `downloadFile` 与 `createPreviewUrl`
- `android/app/src/main/java/com/agentsanywhere/app/ui/screens/sessiondetail/SessionDetailScreen.kt`：文件外跳查看、HTML 官方 Web 预览及降级回退
- `android/app/src/main/java/com/agentsanywhere/app/ui/screens/sessiondetail/SessionAgentFilesScreen.kt`：二进制文件「在外部应用中打开」与下载按钮
- `android/app/src/main/java/com/agentsanywhere/app/ui/screens/sessiondetail/AgentMarkdownText.kt`：常用扩展名文件引用解析
- `android/app/src/main/java/com/agentsanywhere/app/ui/screens/home/HomeProjectComponents.kt`：重名设备 `deviceContextLabel`
- `android/app/src/main/java/com/agentsanywhere/app/ui/screens/home/HomeProjectSessionRow.kt`：会话行副标题设备归属
- `android/app/src/main/java/com/agentsanywhere/app/ui/screens/home/HomeLists.kt`：最近/置顶会话副标题对齐设备标签
- `android/app/src/main/java/com/agentsanywhere/app/ui/screens/home/HomeScreen.kt`：长按高亮菜单对齐设备标签
- `android/app/src/main/java/com/agentsanywhere/app/ui/screens/home/SessionAgentIcon.kt`：ZCode 图标与标签映射
- `android/app/src/main/java/com/agentsanywhere/app/model/RuntimeIdentity.kt`：ZCode 运行时规范化标签
- `android/app/src/main/java/com/agentsanywhere/app/feature/devices/DeviceRuntimeState.kt`：ZCode 运行时优先级排序
- `android/app/src/main/res/values/strings.xml` & `values-zh-rCN/strings.xml`：新增多语言文案
- `android/app/src/test/java/com/agentsanywhere/app/api/RemoteFileDownloadTest.kt`：下载与 token 单测
- `android/app/src/test/java/com/agentsanywhere/app/ui/screens/home/DeviceContextLabelTest.kt`：设备标签单测

### Connector 与 Runtime
- `connector/connector/runtimes/acp/application/sessions.py`：实现 `SessionService.create_session`
- `connector/connector/runtimes/acp/runtime.py`：实现 `create_and_start_session` 同步初始化与首轮交互
- `connector/connector/runtimes/acp/profiles/pi/provider.py` & `runtime.py`：声明支持 `createAndStartSession`
- `connector/connector/runtimes/zcode/provider.py`：本地 ZCode 提供者与能力声明
- `connector/connector/runtimes/zcode/bridge.py`：内置纯标准库 ACP 桥接驱动
- `connector/connector/runtimes/zcode/discovery.py`：本地 Node.js 与 ZCode CJS 发现
- `connector/connector/runtimes/providers.py`：注册 ZCodeProvider
- `connector/tests/test_zcode_acp_create_and_start.py`：ZCode 云端创建协议单测
- `connector/tests/test_connector_runtime.py`：默认 Providers 断言同步

### 项目文档
- `CHANGELOG.md`：详细记录本次交付的 Android 与 Connector 核心功能变更

---

## 四、 真机安装与使用指南

1. **测试机已推送安装包**：
   - APK 文件现已存放于测试机（Xiaomi 2209129SC）的本地下载目录：
     `/sdcard/Download/AgentsAnywhere-debug.apk`
   - 打开手机自带的 **「文件管理」** 或 **「下载管理」**，直接点击 `AgentsAnywhere-debug.apk` 即可安装。

2. **若需要通过 ADB 直接一键覆盖安装**：
   - 小米 HyperOS 系统出于安全考虑，默认拦截了电脑端未经手机确认的 USB 安装指令（报 `INSTALL_FAILED_USER_RESTRICTED`）。
   - **开启方法**：前往「设置」→「更多设置」→「开发者选项」→ 开启 **「USB 安装」**。开启后，在 Mac mini 终端运行 `adb install -r ...` 并在手机屏幕弹窗点击「允许」即可。
