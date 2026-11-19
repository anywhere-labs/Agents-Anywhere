# v3 移动端 PoC 交接

原型基线：`feat/ios+apk+fe/v3-poc`，`7ab4956e` / `fcff87ae`。本轮 Android 收尾分支：`fix/apk/v3-poc-handoff`。继续使用 `MockSessionsClient`；未接真实 MeshCall 会话服务。

## 当前快照（2026-11-19）

- 新增会话页右上角「文件与终端」统一入口（文件夹图标，位于会话菜单左侧，两者共用一个玻璃胶囊），面板内切换文件 / 终端；当前仅演示提示，未接文件或终端服务。
- 入口更新包：`.local-dev/v3poc/handoff/AA-v3-android-workspace-20261119.apk`；release 构建和签名校验通过，本次未安装到设备，入口与切换交互尚待真机验收。下方已安装记录指之前的 handoff 包。

- 工作区：`/Users/xipian/.codex/worktrees/v3-mobile-poc/Agents-Anywhere`；代码提交：`96254007`，交接文档随分支一起交付；未创建 PR。
- 新测试包已覆盖安装到真机并冷启动，日志确认 renderer ready 和页面加载完成；不是只完成了打包。
- APK：`.local-dev/v3poc/handoff/AA-v3-android-handoff-20261119.apk`，约 24 MiB，release 构建、调试签名、mock 数据。
- 已修正：Sheet 内卡片不透明、滑块清透端保留真实模糊、背景未录制时实色降级、面板玻璃关闭时开关滑块不透明、重复分隔线。
- 已整理：tokens 源文件与生成文件、开关尺寸和弹簧、玻璃叠色与描边规则；新增 `--check`、临时 frost 参数和整屏录制诊断事件。
- 本地 v2 Server / Web 已按要求关闭；启动前已有的 PostgreSQL / Redis 保留。真实连接和 MeshCall 接入暂缓。
- iOS 原型就在同一远端 `feat/ios+apk+fe/v3-poc` 分支，不需要另找 iOS 专用分支；参考截图不在仓库中。
- 下一步先做新包的深浅色滑块五点检查、Sheet / 开关交互和 10 次冷启动，再做 release 帧时间 A/B；按钮高光需先取得 iOS 截图，功耗需另做受控测试。

## 分工与入口

- `protocol/`：渲染桥与拟议会话协议；`fixtures/`：演示会话。
- `web/`：共享渲染包；`ios/`：UIKit + WKWebView；`android/`：Compose + WebView。
- `design/README.md` 与 `design/TOKENS.md`：交互规则、token 来源、叠色与描边。
- 先在 `web/` 安装依赖并执行 `npm run build:renderer`。生成的 `ios/AAv3PoC/Renderer/renderer.html` 不提交，Android Gradle 从这个位置复制资源。
- Android 构建：设置可用的 JDK 和 Android SDK，再在 `android/` 执行 `./gradlew :app:assembleRelease`。release 使用调试签名，仅供测试。

## 已定规则

- 目标架构跟随 Effi Cloud：会话内容保存在用户电脑，Server 不存会话内容；原生持有连接与缓存，WebView 不联网。这是 v3 目标，不是现有 v2 Server 的行为。
- WebView 内触摸只归 WebView，祖先节点不挂手势；抽屉只从左边缘排除带拉出。
- 只有真实模糊时才使用半透明玻璃，无背景录制或无法模糊时使用不透明实色。
- iOS 对比度由系统处理；Android 按参考截图取色，不靠目测宣称对齐。
- 玻璃按压整体等比放大、阻尼回弹，不拉伸变形。
- Sheet 中档是玻璃且不压暗背后页面，大档不透明；内部卡片始终不透明。
- 「面板和菜单的玻璃」开启后，也只在覆盖层显示和退出动画期间额外录制整屏。
- `stress/` 只用于 WebView 渲染压测，UI 收尾不运行这些压测脚本。

## 原交接待办的当前状态

| 项目 | 状态（2026-11-19） |
| --- | --- |
| 浅色「允许」按钮的灰色立体边缘 | 待 iOS 参考截图取色；未修改该按钮颜色，也未宣称已对齐 |
| 模糊程度逐档检查 | 已修正清透端不模糊却透明的问题，新增临时 `--ef frost`；五点深浅色真机验收未完成 |
| 开关、面板玻璃、叠色、描边文档 | 已补齐；源 tokens 与生成文件重新同步，新增 `--check` |
| 新玻璃效果的 release 帧时间 | release 已构建；真机 A/B 采样未完成，不能引用旧记录当本轮结果 |
| 面板玻璃的省电幅度 | 未测；设备连接时在充电，不能给出耗电结论；界面已去掉未经验证的省电幅度暗示 |
| 冷启动偶发侧栏打开 | 未复现或定位，本轮尚未执行 10 次冷启动；再次出现应先用 `getevent` 核对输入，不用 monkey 重现 |
| MeshCall SDK 替换 mock | 按当前用户要求暂缓 |
| code review | 本轮只做 Android 玻璃与生成链路的定向检查，修复不透明卡片、清透端和降级开关等规则偏差；整个 v3poc 尚未完成完整审查 |

本轮可交付变更与验证边界见 [Android 验证记录](android/validation/HANDOFF-2026-11-19.md)。

## 本机依赖与参考资料

- iOS 参考截图原路径：`.local-dev/v3poc/compare-ref/ios/`，未入库且当前机器没有。
- 当前机器有 Xcode，但没有安装 iOS Simulator runtime，因此没有生成新的 iOS 参考截图。
- 本轮 Android 构建使用 JDK 21.0.13（源码目标仍为 Java 17）、Android SDK 37、Gradle 9.9.1；原交接的 Homebrew JDK 17 路径在此机器不存在。
- 模拟器验证玻璃应使用 `-gpu host` 和可见窗口；不可用 `-no-window` 的结果判断外观。
- 真机型号 23113RKC6C，Android 16，WebView 143.0.7499.192。重新连接后已安装修正版并确认渲染就绪；完整交互、性能及功耗验证仍待进行。
- MeshCall 仓库 #76 / #77 等状态沿用原交接线索，本轮未重新核实，不将其当作已修复或当前仍未修复的事实。
