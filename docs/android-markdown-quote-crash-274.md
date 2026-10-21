# Android 引用块闪退修复方案（#274）

## 问题与根因

部分会话的 Agent 回复包含引用块内的代码块，Android 打开会话并渲染该消息时，
可能抛出 `Asking for intrinsic measurements of SubcomposeLayout layouts is not supported`
并终止进程。当前的块级公式渲染也会触发相同组合。

实际布局路径是：

```text
AgentMarkdownText
  MarkdownQuote：Row.height(IntrinsicSize.Min)
    MarkdownBlocks
      MarkdownCodePanel / MarkdownMathBlock
        SelectableMarkdownCodeBlock
          BoxWithConstraints（基于 SubcomposeLayout）
```

引用块为了让竖线与内容等高而查询子树的固有高度；`BoxWithConstraints` 不支持这种查询。
故障取决于消息内容及其是否进入渲染范围，不要求长会话、特定 Runtime 或服务端环境。
展开 reasoning 时也复用相同的 Markdown 组件。

用户气泡属于独立的作者渲染分支，正文使用 `Text`，不在引用块的子树中。
已有最小复现不涉及 `UserBubble`，因此本次修复保留其父容器宽度计算，
不采用 Issue 中通过屏幕宽度代替父容器约束的附带改法。

## 实施方案

仅调整 `android/app/src/main/java/com/agentsanywhere/app/ui/screens/sessiondetail/AgentMarkdownText.kt`
中的 `MarkdownQuote`：

1. 用普通 `Column` 承载引用内容，移除 `IntrinsicSize.Min` 和用于撑高竖线的子布局。
2. 使用 `drawBehind`，按实际测量后的内容高度绘制 2 dp 竖线。
3. 保留 12 dp 起始留白（原 2 dp 竖线加 10 dp 间隔）、6 dp 内容间距及引用文字颜色。
4. 随布局方向将竖线放在起始侧，保持 LTR / RTL 下的竖线与留白一致。

代码块、公式和嵌套引用继续走现有解析与内容渲染路径；不改动选择复制、文件链接或宽度约束。
不需要 API、数据库或其他客户端变更。

## 验证方式

最小复现输入应出现在 Agent 的 Markdown 回复中；用户气泡按纯文本显示，不能代替该入口：

````markdown
> ```kotlin
> val answer = 42
> ```
````

- 在修复前后的实际 `AgentMarkdownText` 上对比普通引用、独立代码块、引用内代码块和块级公式。
- 检查嵌套引用、Bash 代码块、表格、多段中文，以及深色和 RTL 布局。
- 使用独立临时包名运行模拟器验证，检查异常日志、进程状态与实际界面；验证入口不进入正式 APK。
- 执行 Android 编译与相关静态检查；不新增或修改 `tests/` 目录。

模拟器上的组件验证不能替代原用户 Redmi K70E、原版 2.0.3 release APK 或原私有会话的验收。
发布前仍应使用最终签名 APK 在原会话上确认打开和滚动正常。

## 已完成的验证（2026-10-21）

- Android Debug APK 编译及 `checkLegacyRoutes` 通过。
- 在 Android 16 的 Redmi 真机上覆盖安装本分支 APK，安装包校验和与本地构建产物一致。
- 通过实际登录与项目列表进入专用本地验证会话，引用内代码块、块级公式、嵌套引用内 Bash、
  中文多段引用与表格、展开 reasoning 内的引用代码均正常显示，验证期间进程稳定且无目标异常。
- 重启 App 后重新打开引用代码块会话正常，登录状态保留。

真机会话采用通过 Store 写入的专用 Timeline 夹具，未执行真实 Runtime，也未验证原报告的私有会话。
RTL 已在绘制逻辑中适配，但尚未完成真机方向验收。
`lintDebug` 报告现有 `remember(context)` 返回 `Unit` 的 `RememberReturnType` 错误；
该代码块与上游 `main` 相同，本次未修改，Lint 整体未通过。

## 风险与回滚

改动局限于引用块的装饰绘制与布局，主要关注竖线高度、嵌套缩进和 RTL 起始侧的位置。
若出现显示回归，可回退本次 `MarkdownQuote` 修改；回退后原固有尺寸测量崩溃风险会恢复。
