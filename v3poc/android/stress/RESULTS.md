# Android 压测结果（a1）与 iOS（r3）对比

同一个渲染包（`renderer.html` 16034266 字节，带内存控制的版本）、同一个压测规格和内容生成器。原始数据在 `.local-dev/v3poc/android/stress/` 和 `.local-dev/v3poc/ios/stress/`（不提交），表格由 `stress/compare.py` 生成。

**先看前提**：Android 跑在 Pixel 9 配置的模拟器上（API 36，WebView 133，arm64），GPU 是 CPU 软件渲染（lavapipe），而且压测期间宿主 Mac 同时跑着另一台带窗口的模拟器、iOS 压测和 Gradle，load average 在 20–60 之间。iOS 是 iOS 模拟器（GPU 由 Mac 的 Metal 提供）。所以**帧率、卡顿、eval 往返这些和时间有关的数字只能说明 Android 侧没有出现结构性问题，不能拿来和 iOS 比快慢**；内存、DOM、桥流量、合并这些和时间关系不大的数字可以比较。

## 已完成的档位

协调者要求暂停压测（qemu 占满 CPU），`a1-burst` 在约 135 秒时中途停止，`open3000`、`kill`、`memwarn` 三档还没跑。

| 指标 | a1-protocol | r3-protocol | a1-burst（中途停止） | r3-burst（前 135 s） |
|---|---|---|---|---|
| 规格 | hz:3, parallel:1，360 s，交互 | 同左 | hz:30, parallel:3，交互 | 同左 |
| 完成 item | 137 | 140 | 95 | 151 |
| 桥流量（倍数） | 39 MB (×12) | 43 MB (×12) | 175 MB (×73) | 380 MB (×102) |
| 掉帧 全程 / 末分钟 | 48% / 50% | 3% / 4% | 51% / 45% | 8% / 5% |
| 最长卡顿 | 717 ms | 367 ms | 417 ms | 1914 ms |
| >100 ms 卡顿 | 63 | 11 | 58 | 9 |
| 到绘制 首分钟→末分钟 | 41 → 47 ms | 37 → 31 ms | 57 → 45 ms | 36 → 31 ms |
| receive 最大 | 9 ms | 4 ms | 4 ms | 1 ms |
| eval 往返 末分钟均值 / 最大 | 68 / 334 ms | 8 / 180 ms | 58 / 334 ms | 9 / 656 ms |
| 在途最大 | 1 | 1 | 1 | 1 |
| 合并掉的事件 | 0 | 0 | 2010 | 49 |
| 渲染进程 RSS 起→止（峰值） | 324 → 400 (419) MB | 486 → 575 (634) MB | 326 → 495 (507) MB | 546 → 742 (774) MB |
| App 内存 起→止（Android PSS / iOS footprint） | 99 → 140 MB | 46 → 62 MB | 100 → 135 MB | 52 → 103 MB |
| DOM 末 | 4625 | 1141 | 3454 | 6662 |

`dumpsys meminfo` 的 PSS（a1-protocol）：App 106 → 147 MB，渲染进程 175 → 216 MB（峰值 230 MB）。

## 读法

- **桥的设计在 Android 上成立**：同一时间最多 1 次 `evaluateJavascript` 在途；hz:30 时渲染包来不及处理，事件按 item id 合并（2010 次），桥流量反而比 iOS 少一半多，没有越积越多。编码在后台线程，每批 0.3–0.5 ms。
- **eval 往返 60–70 ms（iOS 8 ms）**：Android 的 `evaluateJavascript` 要跨进程到渲染进程再回调到主线程，加上模拟器软件渲染和宿主满载，单次往返变长；因为「一次在途 + 合并」，往返变长只是让每批更大、批数更少，不会堆积。真机上要重新测。
- **掉帧 48–51%**：页面和原生的掉帧几乎相同，而且不随时间变差（首分钟和末分钟差不多），是模拟器软件渲染的上限，不是桥或渲染包的退化。
- **内存**：渲染进程 RSS 比 iOS 的 WebContent 低（Chromium 和 WebKit 统计口径不同，只能看趋势）；协议档 6 分钟里增长约 80 MB，和 iOS 的增长幅度相当。App 进程的 PSS 比 iOS footprint 高约 60–80 MB，主要是 ART 堆和 WebView 在 App 进程里的那部分（Chromium 的浏览器侧代码跑在 App 进程里）。
- **DOM 末 4625（iOS 1141）**：内存控制版渲染包会释放离屏轮次的 DOM，iOS 跑到最后只剩 1141 个节点；Android 的数字在 2200–5100 之间来回，说明离屏释放在 Android 上也在工作，但最后时刻刚好有展开的内容。需要在 open3000 / memwarn 档上再确认。
- 没有 FATAL、ANR，也没有 `tile memory limits exceeded`。

## 还没做

- `a1-burst` 跑满 360 秒、`a1-open3000`（3000 条快照，`--cache-items 3000`，第 60 / 75 秒切走再切回）、`a1-open-cap300`、`a1-kill`（第 90 秒 `kill -9` 渲染进程）、`a1-memwarn`（第 60 / 65 秒 `am send-trim-memory` RUNNING_LOW / RUNNING_CRITICAL）。命令见 `stress/run-all.sh`（各档串行，不要并行跑）。
- 毛玻璃开 / 关的耗电和帧时间对比（模拟器上本来就看不出差别，见 design README）。
