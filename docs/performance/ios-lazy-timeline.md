# iOS 惰性时间线验证报告

验证日期：2026-10-26。范围：本 PR 的 `ChatTimelineView`、`TimelineHistoryPosition`
和对应回归测试；不涉及其他客户端或协议。

## 目的与实现边界

普通 `VStack` 会构建全部已加载的消息组。本次只将这一段改为原生
`LazyVStack`，用稳定 ID 注册滚动目标。历史提示、待发送消息和尾部可见性
探针保留在外层，避免这些状态依赖离屏视图的生命周期。

历史页插入后，原锚点可能离开惰性布局的渲染范围，因此先按 ID 定位，再按
测量差值恢复消息内部的阅读偏移。如果布局回调先到，同页已经得到的精确偏移
不能再被后到的 ID 定位覆盖。用户取消定位时，加载完成依据是数据已进入
展示层，不再等待离屏锚点产生几何回调。

虚拟化粒度是消息组。单条很长的 Markdown、展开的工具组及全量分组计算仍有
开销。本报告没有测得帧率、内存或主线程耗时改善，不将核心测试等同于 UI 性能验证。

## 方案选择与不变量

选择原生 `LazyVStack` 是为了沿用现有 SwiftUI 消息组、Markdown 渲染器和滚动状态机。
没有引入第三方列表库或自维护高度缓存，也没有裁剪已加载的历史数据。

- 消息和工具组使用原有稳定 ID；折叠状态仍由会话模型持有。
- 前插历史按原锚点的几何差值修正，不将同时发生的尾部流式增长算作历史增高。
- 用户开始滚动或侧栏接管导航时取消定位，避免网络返回后覆盖新的阅读意图。
- 加载提示和尾部探针仍然挂载；惰性布局只负责消息组。
- 单条长消息、展开工具组内的布局以及全量分组计算不在本次优化范围。

这延续了 [iOS 流式渲染优化 #199](https://github.com/anywhere-labs/Agents-Anywhere/pull/199)
与 [跨端长会话优化 #394](https://github.com/anywhere-labs/Agents-Anywhere/pull/394)
区分实现、正确性检查和性能测量的方式。两者是相关工作，不代表本 PR 的验证结果。

## 环境与可核查证据

- 云端：GitHub Actions `macos-26`，Xcode 26.6，iPhone SE（第 3 代）/ iOS 26.5 Simulator。
- 本地：Apple silicon，macOS 26.5.1，Command Line Tools / Swift 6.3.2；没有完整 Xcode。
- 本地临时产物和隔离测试副本存放于外置 APFS 卷，不提交缓存或锁文件。
- [本轮原始源码与模拟器验证](https://github.com/yunboer/Agents-Anywhere/actions/runs/40313467098)：
  原始 `Package.swift` 的核心测试、完整 App 构建、安装启动与后续聊天 UI 回归均通过。
  日志、截图和 `.xcresult` 见 `ios-validation` 附件。
- 验证分支只位于贡献者 fork，工作流和测试注入不包含在产品 PR 中。
  验证与 PR 的 `ios/` Git tree 均为 `d52359e25437fc610f838f89738c6a65edc982d1`。
  附件保留 14 天；[验证工作流](https://github.com/yunboer/Agents-Anywhere/blob/1dc154e8dda678f381c8eda9c689feb696424dbc/.github/workflows/ios-validation.yml)
  与 [UI 测试及 fixture](https://github.com/yunboer/Agents-Anywhere/blob/1dc154e8dda678f381c8eda9c689feb696424dbc/ci/ios-validation/prepare-ui.py)
  固定到该轮提交，便于复现。
- 本轮基于 `main` 的 `91de2dffdde6f0aabe98745fe17bdd277ead1623`。验证提交包含
  fork 专用工作流；用 `ios-tree.txt` 与 PR 提交上的 `git rev-parse HEAD:ios`
  核对完整 iOS 子树，而非把验证分支的提交 SHA 当作 PR head。

## 检查结果

| 检查 | 结果 |
| --- | --- |
| Xcode 原始 manifest 的 ClientCore 构建及测试 | **253 项、31 个套件全部通过**，测试执行约 4.050 秒，不含构建时间 |
| 本地 CLT 隔离环境 ClientCore 测试 | **253 项、31 个套件通过**，约 3.444 秒 |
| 历史定位套件 | **13 项通过**，含本 PR 新增的 6 项 |
| 完整 iOS App 模拟器构建 | 通过，Debug / `CODE_SIGNING_ALLOWED=NO` |
| 原始 App 安装、启动 | 通过，启动截图和存活进程已核对 |
| 聊天交互回归 | **1 个 XCTest UI 用例通过**，覆盖下文 4 类交互 |
| `git diff --check` | 通过 |
| 真机 / Instruments 性能对比 | 尚未执行 |

本地 CLT 缺少 `Testing` 和 `_TestingInterop`，因此本地结果来自隔离副本，
临时使用 Swift 官方 `swift-6.3.2-RELEASE` 测试框架。正式项目没有添加这些依赖；
云端 Xcode 使用原始 manifest 运行标准测试，是本报告的主要验证依据。

## 历史定位覆盖场景

`ios/Tests/ClientCoreTests/TimelineHistoryPositionTests.swift` 共 13 个测试，
其中本 PR 新增 6 个：

| 场景 | 检查内容 |
| --- | --- |
| 请求先于展示完成 | 旧行仍在展示时不能提前结束加载 |
| 长消息内阅读 | 前插历史后保留消息内部的偏移 |
| 流式尾部增长、重复布局 | 不把尾部增高算作前插增高，不累计重复修正 |
| 新手势、导航取消 | 取消后不能覆盖新的阅读意图 |
| 未变化、空页、失败页 | 不移动阅读位置，正常结束加载 |
| 顶部过度拖拽 | 恢复至静止 inset，而非保留过度滚动量 |
| 工具组前缀合并 | 保留原组尾部边界 |
| 惰性锚点重建（新增） | 每个展示页只请求一次 ID 定位，仍等待有效布局 |
| 取消后的离屏锚点（新增） | 没有几何回调也能在展示完成后结束 |
| 没有测量锚点（新增） | 请求和展示以任意顺序完成均能结束 |
| 估算坐标未变化（新增） | ID 定位后仍恢复消息内偏移，重复测量不再修正 |
| 加载中发生程序化导航（新增） | 新导航取消旧锚点恢复，无后续布局回调也能结束加载；自身 generation 不会误取消 |
| 布局先于页面通知（新增） | 同页已有精确偏移时不再请求 ID 贴顶；其他页仍可请求锚点 |

## 标准复现命令

### 自动发现与执行

`ios/Package.swift` 的 `ClientCoreTests` test target 指向 `Tests/ClientCoreTests`。
历史定位用例位于 `TimelineHistoryPositionTests.swift`，使用 Swift Testing 的
`@Suite` / `@Test`，由标准测试命令自动发现和执行。可先列出用例核对收集结果：

```sh
swift test --package-path ios list
```

其中应包含 `TimelineHistoryPositionTests` 的 13 个用例；新增的 6 个用例覆盖
惰性锚点重建、取消、缺失锚点、估算坐标不变、程序化导航和布局回调先到。
验证工作流保存 `test-list.log` 与实际执行的 `core-tests.log`，分别用于核对
测试收集和测试结果。UI 用例由 fork 验证脚本生成，单独通过 `xcodebuild test`
运行，不包含在这 253 项 Swift Package 核心测试中。

### 构建与测试

在已安装兼容 Xcode 的 Mac 上，从仓库根目录运行：

```sh
swift build --package-path ios
swift test --package-path ios --filter TimelineHistoryPositionTests
swift test --package-path ios
xcodebuild -project 'ios/Agents Anywhere/Agents Anywhere.xcodeproj' \
  -scheme 'Agents Anywhere' -configuration Debug \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath ios/.build/simulator CODE_SIGNING_ALLOWED=NO build
```

仅检查语法时可以运行下列命令；它不会验证 UIKit/SwiftUI 视图完整类型和链接：

```sh
swiftc -frontend -parse \
  'ios/Agents Anywhere/Agents Anywhere/Views/Chat/ChatTimelineView.swift' \
  ios/Tests/ClientCoreTests/TimelineHistoryPositionTests.swift
```

## 失败与取消时的行为

- 历史请求失败、返回空页或首行未变化时，沿用现有请求和错误处理；恢复状态无需
  再等待新的锚点布局，也不会为未增加的历史发出位置修正。
- 用户开始拖动、侧栏接管导航或发送消息触发新导航时，取消旧的恢复意图；请求与
  展示完成后结束加载，即使原锚点已经离屏，也不依赖它重新产生几何回调。
- 如果请求开始时没有测量到锚点，允许数据正常展示并结束加载；此路径不承诺保留
  消息内部偏移。有锚点时，只有同一导航 generation 的有效测量才能恢复位置。

这些分支由历史定位核心测试覆盖；网络失败、侧栏取消的真实 UI 验收仍属于下文
列明的未覆盖场景。

## 模拟器交互回归

UI 测试运行真实的 `SessionChatModel` 和 `ChatTimelineView`，使用固定 HTTP 响应，
并逐步向末条消息追加 Markdown，模拟流式内容增长。测试只在验证分支替换启动入口、
注入数据和辅助可访问性标记；原始 App 在注入前已完成独立构建、安装和启动。

同一个 XCTest 用例依次验证下列场景，全部通过，前后截图已经核对：

| 场景 | 断言与结果 |
| --- | --- |
| 前插历史 | 从 40 条增加到 140 条，加载提示结束；原消息组屏幕 Y 坐标为 **136.5 → 136.5 pt**，满足偏移小于 15 pt 的断言 |
| 返回底部 | 点击到底部后，实际尾部标记位于视口内，返回按钮消失 |
| 底部流式增长 | 末条消息连续追加至 revision 20 后，尾部仍可见 |
| 上滑阅读时流式增长 | 主动上滑后继续追加至 revision 39，尾部保持离屏，返回按钮仍可见 |

这验证了普通、无待审批通知的固定数据场景，不代表真实账号、服务端或 WebSocket
端到端验证。长消息内部翻页、工具组合并、取消恢复等还有核心状态测试覆盖；
相应 UI 场景以及审批、侧栏、键盘、旋转和 Dynamic Type 尚未逐项运行。

## 后续性能测量

本 PR 不给出帧率或内存改善的数值结论。需要用相同设备、构建配置和构造会话比较
基线与 PR，逐次加载至 100、500、1,000 条记录，混合长 Markdown、代码块、图片和
工具组，记录打开耗时、内存及滚动卡顿。通过 Instruments 检查离屏 Markdown 布局
工作与主线程耗时，保留原始 trace 后再报告差异；模拟器不能替代真机帧率测量。

仓库现有 CI 不包含 iOS 构建或测试；外部贡献者的上游工作流还需维护者批准运行。
上游检查的通过或跳过不能替代本报告的 iOS 验证。
