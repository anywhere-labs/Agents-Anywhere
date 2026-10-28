# Android Foldable Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付可安装的 Android Debug APK：宽窗口左侧项目/会话、右侧真实会话，侧栏可收起，窄窗口维持手机导航并恢复会话与阅读状态。

**Architecture:** 在现有导航装配层把 Sessions 与 SessionDetail 合为一个自适应工作台，原控制器、打开会话/已读回调、草稿存储和实时连接不变。复用 Home 列表，以账号作用域的 SaveableStateHolder 保存 Home 和各会话的可保存界面状态；仅用 Compose 实际布局约束判断宽度。不新增依赖、协议或消息缓存。

**Tech Stack:** Kotlin 2.2、Jetpack Compose、Material 3、JUnit/Robolectric、现有 Compose instrumentation tests、Gradle 8.10.2、JDK 17、Android API 36。

---

## 完成条件与边界

设计依据：`docs/superpowers/specs/2026-10-28-android-foldable-workspace-design.md`，用户已最终批准。

- 实际宽度 <600dp 单栏；>=600dp 双栏；侧栏宽度为 36%，钳位 240–320dp。
- 每种真实会话入口都调用现有 onOpenSession；宽屏只替换右侧，选中行有视觉和 selected 语义。
- 收起不导航、不丢当前会话，展开入口至少48dp、有描述；宽屏偏好不隐藏窄屏列表。
- 返回先退出会话文件/终端子页，再回列表；回列表后右侧空态，待创建会话不被误判为空态。
- A→B→A、宽窄切换和 Activity 重建保留草稿、列表/阅读位置及展开状态；布局切换不同时挂载两个详情。
- 设置/账号、新建、全局设备/文件/终端仍为完整页面；240dp侧栏长按菜单不越界或抛异常。
- 新增检查、受影响回归、APK构建和签名校验均记录真实结果；无法执行的设备/服务器检查明确标注。
- 不做遮挡铰链、上下半折布局、拖动分隔线、多标签、签名/应用标识改造。

## 工作目录与构建基线

实施目录：`.worktrees/foldable-workspace`，分支 `feat/apk/foldable-workspace-impl`；最终验证后 fast-forward 回根目录功能分支。根目录原代码不直接开发。

API36已由主会话安装成功。子代理的只读错误不是源码失败。本机全局 Gradle init 脚本会清空 JitPack，不能为此修改项目仓库或全局设置；采用独立 GRADLE_USER_HOME，复用已有缓存和 wrapper，使用项目原有仓库。独立目录位于被忽略的 `.superpowers/gradle-home`。一次只运行一个 Gradle。

以下命令均在工作树根目录运行：

```bash
JAVA_HOME=/Library/Java/JavaVirtualMachines/temurin-17.jdk/Contents/Home \
ANDROID_HOME=/Users/zhoutingshuai/Library/Android/sdk \
GRADLE_USER_HOME="$PWD/.superpowers/gradle-home" \
android/gradlew -p android testDebugUnitTest
```

若基线仍失败，先定位并记录失败阶段；不得通过降 SDK、删测试或替换终端依赖掩盖失败。源码实施前向用户说明基线状态。

## 文件责任与并发边界

| 范围 | 文件 | 责任 |
|---|---|---|
| 工作台装配 | `android/app/src/main/java/com/agentsanywhere/app/app/AgentsAnywhereNavHost.kt` | 路由归一、唯一Home/详情调用、账号保存作用域、全窗账号覆盖层 |
| 布局 | `android/app/src/main/java/com/agentsanywhere/app/app/SessionWorkspace.kt`（新建） | 实际宽度规则、左右有界布局、收起后展开入口、空态 |
| 列表 | `android/app/src/main/java/com/agentsanywhere/app/ui/screens/home/HomeScreen.kt`、`HomeLists.kt`、`HomeProjectComponents.kt`、`HomeProjectSessionRow.kt`、`HomeSessionActions.kt` | 选择透传、紧凑排布、滚动保存、长按菜单安全 |
| 会话 | `android/app/src/main/java/com/agentsanywhere/app/ui/screens/sessiondetail/SessionDetailHeader.kt` | 弹性标题，不改变按钮功能 |
| 阅读回归 | `android/app/src/main/java/com/agentsanywhere/app/ui/screens/sessiondetail/SessionMessages.kt`、`TimelineReadingState.kt`、`SessionDetailScreen.kt` | 只在恢复测试证明缺口时作共享根因修正，不重写消息模型 |
| 文案 | `android/app/src/main/res/values/strings.xml`、`values-zh-rCN/strings.xml` | 收起/展开的英文及中文无障碍文案 |
| 检查 | `android/app/src/test/java/com/agentsanywhere/app/app/SessionWorkspaceLayoutTest.kt`（新建）、`android/app/src/androidTest/java/com/agentsanywhere/app/app/SessionWorkspaceTest.kt`（新建）、既有消息滚动测试 | 阈值/公式、布局/恢复、消息阅读回归 |
| 说明 | `CHANGELOG.md`、`android/README.md`、正式设计状态 | 用户可见变化、安装与范围、已批准状态 |

Home 与工作台可以分工但不能同时修改 NavHost 或字符串。Home 先交接新参数和移出的账号参数清单；导航随后接线。主会话统一运行 Gradle、最终审查和打包。

### Task 1: 建立可检查的宽度规则（TDD）

**Create:** `android/app/src/test/java/com/agentsanywhere/app/app/SessionWorkspaceLayoutTest.kt`。

- [ ] 写下失败检查：

```kotlin
package com.agentsanywhere.app.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SessionWorkspaceLayoutTest {
    @Test fun widthUsesAvailableWindowAndClampsSidebar() {
        assertNull(workspaceSidebarWidth(599f))
        assertEquals(240f, workspaceSidebarWidth(600f)!!, 0.01f)
        assertEquals(252f, workspaceSidebarWidth(700f)!!, 0.01f)
        assertEquals(288f, workspaceSidebarWidth(800f)!!, 0.01f)
        assertEquals(320f, workspaceSidebarWidth(1000f)!!, 0.01f)
    }
}
```

- [ ] 用上述环境前缀执行 `android/gradlew -p android testDebugUnitTest --tests com.agentsanywhere.app.app.SessionWorkspaceLayoutTest`；预期先因 helper 不存在失败。若构建环境先失败，不称为测试红灯。
- [ ] 在新建 `SessionWorkspace.kt` 同包内实现：

```kotlin
internal fun workspaceSidebarWidth(availableWidthDp: Float): Float? =
    if (availableWidthDp < 600f) null else (availableWidthDp * 0.36f).coerceIn(240f, 320f)
```

- [ ] 重跑该测试；预期上述五个边界通过。由宿主内部实际 BoxWithConstraints 调用，不能用设备名称或 screenWidthDp 替代父约束。
- [ ] 审查并提交 helper 与测试，提交信息 `feat(android): 定义折叠屏工作台宽度规则`。

### Task 2: 复用完整 Home 链路并适配紧凑侧栏

**Modify:** 上表五个 Home 文件；先阅读完整文件及每个被改函数的全部调用点。

- [ ] 在真实 Home 测试中使用已有 AgentSession fixture 方式构造 A/B，点击后由测试边界回调更新 selectedSessionId。最小断言：

```kotlin
compose.onNode(hasText("Session A") and hasClickAction()).performClick()
compose.onNode(hasText("Session A") and hasClickAction()).assertIsSelected()
```

测试必须覆盖普通 pinned/recent、项目 pinned session、置顶项目 child、普通项目 child；只测孤立行不能证明透传。使用已有 AndroidJUnitRunner/Compose rule，不把 androidTest 依赖移入 JVM test。

- [ ] HomeScreen 追加以下参数，并经过 HomeContent、HomeList/SessionList、HomeProjectModeList/HomeProjectList/HomeProjectTreeItem 传到两个真实会话行：

```kotlin
selectedSessionId: String? = null,
compact: Boolean = false,
onCollapseSidebar: (() -> Unit)? = null,
```

行新增 `selected: Boolean = false`，调用处使用：

```kotlin
selected = session.id == selectedSessionId,
```

不改变过滤条件，不修改 onOpenSession，不给项目标题添加会话选择。高亮使用主题颜色：

```kotlin
.background(if (selected) colors.subtle else Color.Transparent)
.semantics { this.selected = selected }
```

- [ ] 用已有 `combinedClickable` 取代行上的 detectTapGestures，保留原长按触觉、bounds和回调；不要叠加双套点击。长按展示副本清除交互语义。
- [ ] compact Header 分为品牌与操作行，保留账号/搜索/收起；收起用48dp IconButton。compact 减小 HomeContent 留白及 QuickEntry 内边距，保留设备/终端/文件所有入口；手机原尺寸不动。
- [ ] HomeContent 在持久存在的位置创建 rememberSaveableStateHolder，用 sidebarViewMode 区分项目/会话列表保存边界。三处临时 pinned/recent 展开 Boolean 改 rememberSaveable。项目 LazyColumn 显式绑定 rememberLazyListState；不加入外层 verticalScroll。
- [ ] 两个长按覆盖层使用一致的安全宽度和局部锚点：

```kotlin
val menuWidth = minOf(252.dp, (maxWidth - 36.dp).coerceAtLeast(0.dp))
```

Card 实际宽度、px定位计算共用 menuWidth。通过 onGloballyPositioned 记录覆盖层 boundsInRoot，行的 root 锚点减去覆盖层原点后再定位。钳位的最大值不得小于最小值；菜单文字单行省略但保留操作按钮。不要保存几何坐标跨尺寸变化。
- [ ] 从 Home 移出 ProfileSettingsDrawer 的现有完整调用及其专用参数/回调，交接给 Task3；保留 profileOpen/onProfileOpenChange 控制入口。Home 自己的菜单错误提示继续使用原 ToastHost。
- [ ] 在240/320dp真实父约束下检查英文、中文、长标题/审批和两类长按，确认没有异常、按钮可达及选择语义正确；检查手机布局未被 compact 规则影响。
- [ ] 审查 diff，提交 `feat(android): 让项目与会话列表适配可折叠侧栏`。

### Task 3: 接入自适应工作台与全窗账号页

**Modify/Create:** NavHost、SessionWorkspace、SessionDetailHeader、两份字符串及 Task3 Compose 测试。依赖 Task2 的 Home 参数交接。

- [ ] 新建实际约束下的 Compose 测试：599dp仅列表；600/800/1000dp同时左右；点击收起后再展开；窄屏即便保存 collapsed=true仍能显示列表。可用测试 slot 统计同时活跃的详情实例，断言最大为1。使用 `StateRestorationTester` 检查 collapse偏好及当前会话键的恢复。
- [ ] 在 NavHost 的 AnimatedContent 外创建账号作用域的保存状态和 holder：

```kotlin
key(serverUrl, userId) {
    val workspaceStateHolder = rememberSaveableStateHolder()
    var sidebarCollapsed by rememberSaveable { mutableStateOf(false) }
}
```

将现有 Surface/AnimatedContent放入该作用域，不新建业务状态容器。Sessions和SessionDetail映射到相同动画目标：

```kotlin
val animatedDestination = when (currentDestination) {
    AppDestination.Sessions, AppDestination.SessionDetail -> AppDestination.Sessions
    else -> currentDestination
}
```

- [ ] SessionWorkspace 用 BoxWithConstraints+有限高 Row 布局。宽屏展开时 Home 宽为 helper 结果；窄屏 Sessions时 Home占满；窄屏Detail时仅详情。宽屏收起时显示48dp的可触达展开入口，不能把该入口放在会被移除的Home内。其余空间给详情，空态复用 `session_open_from_list` 文案。
- [ ] workspace内只保留一个 HomeScreen 和一个 SessionDetailScreen 调用，原参数逐项原样迁移。Home包 `SaveableStateProvider("home")`；详情包以实际selectedSessionId或preparedSessionDraft.localSessionId为身份的独立保存边界。高亮按目的地门控：

```kotlin
val activeSessionId = selectedSessionId.takeIf {
    currentDestination == AppDestination.SessionDetail
}
```

详情可见性使用目的地，而非ID非空；preparedSessionDraft存在且ID为空仍显示真实待创建详情。initialSession查找同时覆盖 active、archived和projectSessionsById，避免项目专属会话缺初始元数据。
- [ ] SessionDetailHeader中224dp固定宽度换为 Row剩余空间的weight，并增加相邻按钮间距；原两按钮回调不变。展开入口不塞进固定标题。系统返回沿用现有详情BackHandler。
- [ ] 将Task2移出的唯一ProfileSettingsDrawer调用放在NavHost整个Surface的Box最上层，传回全部原回调，新增对应全窗ToastHost；账号打开时最后注册BackHandler优先关闭账号，不能先返回会话列表。
- [ ] 两种语言加入 `workspace_collapse_sidebar`/`workspace_expand_sidebar`，中文「收起侧栏」/「展开侧栏」，英文「Collapse sidebar」/「Expand sidebar」。以stringResource提供内容描述，触控目标>=48dp。
- [ ] 运行窄测试、编译 androidTest，确认保存边界没有同键重复挂载。审查唯一详情的加载、实时订阅、草稿、发送及返回链路；提交 `feat(android): 接入自适应双栏会话工作台`。

### Task 4: 会话阅读、草稿及尺寸恢复回归

**Test:** 扩展 `android/app/src/androidTest/java/com/agentsanywhere/app/ui/screens/sessiondetail/MessageListScrollFollowTest.kt`，新建或扩展草稿存储的 Robolectric 测试。

- [ ] 复用真实 MessageList 测试数据、Theme和controller fixture，在外部真实会话保存边界内依次渲染A→B→A；记录A首个可见消息、展开项和滚动offset，切回后断言恢复且B不继承。再改变实际父宽度和执行StateRestorationTester恢复，断言相同阅读消息仍可见，不意外跳到最新。
- [ ] 验证历史分页位置：加载旧消息后离开并返回；检查首次loading分支不会消费掉未挂载MessageList的恢复值。若恢复消息不在初始快照，恢复状态必须保留该消息身份并通过既有onLoadOlder补齐到该位置；不得只恢复越界数字索引后宣称成功。
- [ ] 最小共享修复限于SessionMessages/TimelineReadingState/SessionDetailScreen已有保存与分页链路；先grep全部调用，保留following/流式滚动/新消息按钮规则。不新增第二套消息缓存或实时客户端。由失败断言决定改动位置，不在没有失败证据时改写阅读算法。
- [ ] 草稿检查使用真实SessionComposerDraftStore：A文本+附件、B不同文本、prepared local ID分别写入并读回，新建store实例后仍隔离；切换身份不得把旧会话的异步请求结果写进新会话。
- [ ] 运行原MessageListScrollFollowTest及新增恢复检查；对Activity.recreate、系统返回优先退出子页、键盘和旋转进行设备检查。没有可用设备时记录未执行，不用车载AVD替代手机验证。
- [ ] 必要的共享修复与回归测试一并提交 `fix(android): 保留窗口与会话切换时的阅读状态`；若无需修复，仅提交对应test类型提交。

### Task 5: 完整检查、变更说明和 APK

- [ ] 更新设计文档状态为「用户已最终批准，进入实施」。在android/README.md增加600dp阈值、侧栏收起和首版不覆盖遮挡铰链说明，不修改无关根README。
- [ ] 根CHANGELOG顶部未发布Android节增加中文用户结果条目：折叠屏展开后可并排浏览项目/会话和消息，并可收起侧栏；提交后用该功能提交的8位哈希链接补充引用，不虚构PR号。
- [ ] 用Task1环境前缀依次执行：

```bash
android/gradlew -p android testDebugUnitTest assembleDebug assembleDebugAndroidTest lintDebug
```

预期各任务成功；记录单测XML中真实测试数、失败和跳过。已知基线失败单独说明，不删断言或改依赖版本绕过。若有手机/可缩放模拟器，再运行 `connectedDebugAndroidTest`；没有运行不能标记通过。
- [ ] 审查 `git diff --check`、完整最终diff及新增文件；独立审查功能验收覆盖和代码质量，修正实际问题再重跑相关检查。不得提交SDK、APK、日志、临时镜像脚本、凭据或签名文件。
- [ ] APK来自 `android/app/build/outputs/apk/debug/app-debug.apk`；使用SDK的apksigner验证签名，并用aapt确认应用标识、版本和minSdk/targetSdk，执行 `shasum -a 256`。不卸载用户设备应用，不读取官方密钥。
- [ ] 将最终提交fast-forward回 `feat/apk/foldable-workspace`（先确认根目录仍干净）。保留独立工作树内APK，通过present交付其实际文件；说明这是Debug开发签名，不能保证覆盖不同签名的官方版。
- [ ] 最终报告仅包含实际完成的交互、APK/SHA256、真实检查结果及未验证项。物理折叠/厂商键盘/真实服务端发送审批无执行证据时明确列为未验证。

## 计划自审

- 设计1–3：Task1–3覆盖阈值、收起、空态、手机导航、全窗账号与非工作台页面。
- 设计4：Task2–4保留真实打开/已读和发送链路，覆盖保存边界、prepared身份和单一详情。
- 设计5：明确不包含实体遮挡铰链、姿态和额外桌面功能。
- 设计6–7：Task4–5覆盖恢复、实际检查、构建签名、中文日志及未验证范围。
- 类型一致：宽度helper输入/输出为Float/Float?；选中ID为String?；selected为Boolean；compact为Boolean；折叠回调可空且不改导航。
- 未新增协议、通用布局框架、持久化格式或依赖。读位置的条件修复必须先由可运行失败检查证明，不能以计划文档代替实际实现/验收。
