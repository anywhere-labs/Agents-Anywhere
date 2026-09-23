# PR #75：输入草稿观察范围对照

2026-09-14，在 PR #75 与远端 main `287fc57a` 的合并版本上验证。探针版本为 `230400c7`；随后只补充结果断言和本报告，应用实现没有改变。

## 方法

- Xcode 27.0（27A5252f），iOS 27.0 SDK，iPhone 17 / iOS 27.0 模拟器，Release arm64。
- 实际 `SessionChatView`、`ChatTimelineView`、`ChatComposer` 和 `ComposerTextView`，注入固定离线历史：24 条记录，8 条折叠工具，助手正文合计 7,200 字符。没有运行中的流式输出。
- 同一二进制通过环境变量切换：baseline 在会话页根重新加入旧的 text/attachments `.onChange`，并停用子组件的落盘回调；fixed 使用 PR 的子组件回调，根不读取草稿值。子组件原本就会读取这些值。
- 每轮原生 `UITextView.setMarkedText` 更新 120 次，使用 n / ni / nih / niha / nihao / 你好循环，并通过真实 delegate 同步草稿。每六步提交 marked text；每步至少等待 50 ms。
- 先等待页面和键盘稳定，再测量输入循环。执行顺序为 baseline / fixed / fixed / baseline / baseline / fixed，每种模式三轮。
- 临时插桩记录进程 CPU 时间、实际 View body 求值次数、草稿持久化通知次数和输入循环时间。脚本结束后恢复全部应用源文件，探针不进入正常应用入口。

## 结果

| 指标 | baseline（三轮） | fixed（三轮） |
|---|---|---|
| 进程 CPU 秒 | 4.055 / 4.253 / 4.054 | 2.701 / 2.924 / 2.804 |
| CPU 中位数 | 4.055 s | 2.804 s |
| 会话页 body 求值 | 每轮 120 | 每轮 0 |
| 时间线 body 求值 | 每轮 145 | 每轮 25 |
| 输入框 body 求值 | 238 / 233 / 236 | 每轮 120 |
| 草稿持久化通知 | 每轮 120 | 每轮 120 |
| 输入循环耗时中位数 | 8.046 s | 8.182 s |
| 步间隔 P95 的中位数 | 80.54 ms | 84.28 ms |

CPU 中位数下降约 **30.8%**。新实现消除了每次输入引发的会话页根重新求值，时间线仍会因输入框尺寸/布局等更新而求值，不能称为零更新。两种模式均确认 120 次原生 marked-text 更新实际发生，最终草稿与 UITextView 内容一致，附件变化仍触发持久化通知。

这不是 FPS、真机响应延迟或耗电量测试。步间隔包含主动等待、调度和布局；本次没有观察到输入循环总耗时或 P95 改善。没有驱动真实拼音候选栏，也没有覆盖服务端流式输出、网络事件、滚动、长按选择或所有历史规模。结果支持缩小草稿观察范围的机制和 CPU 收益，不能宣称全部 iOS 卡顿已修复。

固定 fixture 没有配置真实账号/runtime。会话打开与历史订阅任务在临时副本中禁用，自动设置读取在无 token 时本地失败；测量在初始布局和提示稳定之后进行。正常生产任务、权限逻辑及文字选择功能没有修改。

## 其他验证

- 未插桩的正常应用 Release iOS Simulator build 成功。
- `swift test --package-path ios`：232 项测试、28 个 suite 全部通过。
- `git diff --check` 通过。
- PR 同时补充 `TimelineHistoryPull.init(edge:)`，修复带 private 存储属性时合成逐成员初始化器不可访问的问题。
- 新会话页仍可能通过 `canCreate` 读取草稿，此 PR 不保证新会话页没有输入观察。

## 复现

在独立 worktree、已有可用模拟器的环境中运行；脚本不会自动启动模拟器或本地服务。

```sh
DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer \
python3 ios/scripts/probe-composer-draft.py \
  --device <booted-simulator-udid> \
  --derived-data /tmp/aa-composer-build \
  --output /tmp/aa-composer-results
```

脚本使用独立 bundle ID `com.agentsanywhere.composerprobe`。同目录的六份 JSON 为原始结果；缺失的 body 计数表示该轮为零。后续回归运行会断言 marked text、草稿同步、附件通知、通知次数和页面观察范围，CPU 数值只记录，不使用机器相关阈值判失败。
