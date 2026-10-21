# iOS 客户端性能审计（2026-10-13）

静态代码审计，未运行 Instruments。路径约定：`$APP` = `ios/Agents Anywhere/Agents Anywhere/`，`$TX` = `ios/Packages/Textual/Sources/Textual/`。

关联 issue：anywhere-labs/Agents-Anywhere#83（长会话卡顿）。

## 0. 处理状态（PR #321，已合并，2026-10-13）

| 编号 | 状态 | 说明 |
| --- | --- | --- |
| H1 | 已处理 | Domain / Network / V2RealtimeAPI 全部 `nonisolated`，解码脱离主线程；token provider 用 Mutex |
| H2 | 已处理 | `V2TimelineItem.init(json:)` 单次建树；`payload()` 往返与 `confirmEchoes` 删除；socket 帧单次解析；`JSONValue` 探测顺序调整 |
| H3 | 已处理 | `mergeOne` 二分原地替换；`V2SessionModel.update` / `stage` 保留行索引；`displayText` 解码时算一次；显式 `==` |
| H4 | 已处理 | `flush` 对未变化行直接跳过，`TimelineRowStructure` 只在值变化时重建 |
| H5 | 已处理 | Entry 脏标记、按会话 flush、2.5 s 合并、`trim` 仅新建文件时执行、dashboard 只在变化时写 |
| H6 | 已处理 | token 内存副本；`syncDashboard` 按值变化赋值；AppState 迁移到 `@Observable`，视图只因读取的属性失效 |
| H7 | 已处理 | `V2Timestamp` 缓存解析；`SessionSidebarPresentation.sorted`；项目可见性一次遍历；`ChatShellView` 只算一次会话列表 |
| H8 | 已处理 | `applyMeta` 返回是否变化，`applyMetadata` 只对变化项 emit；`apply` / `DeviceAgentModel` / `NewSessionModel` / 连接监控做等值守卫 |
| M1 | 已处理 | `StreamingGlyphReveal` 用 `hasStreamed` 保持渲染分支 |
| M2 | 已处理 | group / row / footer / actions 按身份 Equatable；`entry(cwd:)` 按版本缓存；复制/分享文本按需拼接；turn review 记忆化；内联 notice 按目标分组 |
| M3 | 已处理 | Textual `HighlightedTextFragment` 对已高亮块延迟 350 ms 再 tokenize |
| M4 | 部分 | 链接/附件扫描随 `TextBuilder` 只算一次；`onChange(of: content)` 的整串比较保留（共享存储时为身份比较） |
| M5 | 已处理 | `NoticeExpiryClock` 只在有过期时间时每秒刷新；`isExpired` 走 `V2Timestamp` |
| M6 | 已处理 | `V2LocalStore.restoreSession` 在 actor 内解码，主线程只接收结果 |
| M7 | 已处理 | receive 只应用投影，发布合并到主队列下一轮，积压整段应用完只重投影一次 |
| M8 | 未处理 | 订阅建立仍做 recover + 3 个 live 读；需要协议层配合 |
| M9 | 部分 | `ChatSidebarView` 不再订阅 AppState；键盘 inset 进入 sidebar factory 的路径未改（需真机验证布局） |
| M10 | 已处理 | 目标变化才写 defaults，草稿 1 s 合并保存 |
| M11 | 部分 | 连接监控状态未变不回调；前台跳过全量拉取的改动已按评审意见回退 |
| M12 | 已处理 | notices 未变化不重建表单，未变化 notice 直接跳过 |
| M13 | 已处理 | 见 M9 |
| M14 | 已处理 | `content` / `source` 与 `raw` 共享存储 |
| L1 | 已处理 | `MarkdownStreamSplit` 找安全边界，每批只重解析尾部 |
| L2 | 已处理 | 无新文本时睡到最早的 reveal 结束 |
| L3 | 已处理 | hunk 正则静态化，diff 解析与行数按代码记忆化 |
| L4 / L5 / L8 / L11 / L12 / L13 | 未处理 | 低频路径 |
| L6 | 已处理 | notice 与行的匹配一次建字典 |
| L7 | 已处理 | 事件去重窗口改环形缓冲 |
| L9 | 已处理 | 随 H1 完成 |
| L10 | 已处理 | 头像解码 NSCache |
| L14 | 已处理 | `me didSet` 去重 |
| L15 | 已处理 | dashboard 脏标记 |

合成基准（`PipelineBenchmarkTests`，release 构建，macOS，1000 条 item、300 个流式事件、正文约 8k 字）：

| 阶段 | main | 本分支 |
| --- | --- | --- |
| 解码 | 18 ms | 10 ms |
| 投影 apply | 160 ms | 46 ms |
| V2SessionModel.update | 59 ms | 45 ms |
| presentation stage+flush | 485 ms | 70 ms |
| 合计 | 720 ms | 173 ms |

即每个事件的主线程成本从约 2.3 ms 降到约 0.55 ms（解码已移出主线程）。这是单线程微基准，不含 SwiftUI 布局与绘制。

验证：SwiftPM `ClientCore` 247 个测试通过（需 Xcode 工具链：`DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer swift test`），
`xcodebuild` iPhone 18 Pro 模拟器 Debug 构建成功。没有在真机上用 Instruments 量化，也没有做 OAuth / 真实 Runtime 会话的联调。

## 1. 总体判断

NATIVE_CHAT.md 里描述的视图层优化（5 Hz 批次、glyph ledger、digest 比较、`MarkdownBlockLayout` 高度缓存、`TimelineScrollState`、drawer 的 render-only 位移）基本都已落地，而且做得很细。**剩下的卡顿主要来自视图层之前的数据管线和 shell 层**，它们没有被 5 Hz 批次保护，并且全部跑在主线程。

三个根因：

1. **工程级 `SWIFT_DEFAULT_ACTOR_ISOLATION = MainActor`**（`project.pbxproj:315,372`）。没有显式 `nonisolated` 的类型全部主线程隔离，包括 `V2RealtimeAPI`、`URLSessionWebSocketConnection`、`URLSessionHTTPTransport`、`V2TimelineItem`、`V2SessionEvent`。结果是**每一帧 socket 消息和每一个 HTTP 响应的 JSON 解码都在主线程**，而且这些 `Decodable` 类型因为被 MainActor 隔离，想挪到后台也编译不过。
2. **每个 token 事件触发 O(n) 的全量投影重建**（n = 当前会话 item 数，上限 1000），外加 3 次多余的 JSON encode/decode 往返，全在主线程。会话越长越卡，这正是 #83 的形态。
3. **`AppState.makeV2Services()` 每次调用同步读 Keychain**，而它被 `sessionRepository` / `nativeChatServices` 等计算属性包裹，直接出现在多个 View 的 `body`、`.task(id:)` 和 `Binding` getter 里。AppState 又是一个有约 20 个 `@Published` 的 `ObservableObject`，任何一个字段写入就会让整条 shell 重算，从而每次重算都附带 3 到 5 次 `SecItemCopyMatching`。

## 2. 发现清单

### High

**H1. socket 帧与 HTTP 响应在主线程解码**
- `$APP/API/V2/V2RealtimeAPI.swift:10,90-107,116-118`：`struct V2RealtimeAPI` 无 `nonisolated`，内部 `Task { for try await data in connection.messages() { decoder.decode(...) } }` 继承 MainActor。`isKeepalive` 为了读 `type` 先完整 parse 一次，随后又 parse 一次。
- `$APP/Network/WebSocketTransport.swift:24,33-54`：同样 MainActor，`Data(text.utf8)` 拷贝也在主线程。
- `$APP/Network/HTTPTransport.swift:9,37-65,106-115`：请求 encode、响应 decode 都在主线程。snapshot（100 条）、timeline page、全量 session inventory、dashboard 推送都走这里。
- 修法：Domain 层 wire 类型（`V2TimelineItem`、`V2SessionEvent`、`V2SessionSnapshot`、`V2SessionTimelinePage`、`V2RuntimeState/Notice/Capability*`、`V2DashboardSnapshot`、`V2Connector`、`V2Project`）标 `nonisolated` + `Sendable`；`V2RealtimeAPI`、两个 transport 标 `nonisolated`；repository 在 MainActor 上 `for await` 一个已经解码好的流，不要退化成每帧一个 `Task { @MainActor }`。

**H2. 每个 timeline 事件被解析或序列化 5 到 6 次**
- `V2RealtimeAPI.swift:117` keepalive 判断 parse 一次，`:97` 正式 parse 一次（`payload: JSONValue` 整树）。
- `$APP/Repositories/V2SessionProjection.swift:162-170` `payload(_:in:)`：把已解好的 `JSONValue` 用新建的 `JSONEncoder` 编回 `Data`，再 decode 成 `V2TimelineItem`。
- `$APP/Domain/Session/V2TimelineItem.swift:74-101`：`init(from:)` 先 `raw = JSONValue(from:)` 整树一次，再 `decodeIfPresent(JSONValue.self, forKey: .content)` 第二次建 content 树，`V2MessageContent` 又把 `rawContent` 存一份。一条消息正文在内存里有 3 份。
- `$APP/Repositories/V2SessionRepository.swift:603-609` `confirmEchoes`：对每个带 `item` 的事件再 encode + decode 一次整条 item，只为拿 `clientMessageId`；而 `V2SessionModel.update:227` 已经对全部 items 调过 `confirmEcho`，这步完全冗余。
- `$APP/Domain/Common/JSONValue.swift:11-26`：用 `try?` 级联做类型分派，object 要先抛 4 次 `DecodingError`（每次分配 codingPath 数组）才命中。工具输出这类大树成倍放大。
- 修法：`V2SessionEvent` 按 `type` 直接解成 typed payload（`.timelineItem(V2TimelineItem)` 等），`JSONValue` 只留给未知类型；删掉 `payload()` 的往返和 `confirmEchoes`；`V2TimelineItem` 只保留一棵树，`content` 从 `raw["content"]` 引用；`JSONValue.init` 改成按命中概率分派或经 `JSONSerialization` 转换。

**H3. 每个事件对整条 timeline 做多次 O(n) / O(n log n) 遍历（主线程）**
- `V2SessionProjection.swift:138-160` `merge`：单条 `item_updated` 也会建 1000 项字典、`values.sorted`、`Array(suffix)`。
- `$APP/Models/Session/V2SessionModel.swift:209-234` `update`：再建一次字典；对每一行 `row.update(item)` 做合成的 `V2TimelineItem ==`（深比较两棵 JSON 树）；`timeline.map(\.id) != rows.map(\.id)` 两次 map；`for item in data.items { confirmEcho }` 再扫一遍；`awaitingReplyID` 分支再扫两遍。这个 `V2SessionModel.timeline` 并行投影在聊天页只被 `ChatTimelineView.swift:185` 和 `SessionDetailsSheet` 用到，却每个 token 都维护。
- `$APP/Models/Chat/SessionTimelinePresentation.swift:84-91` `stage`：每次 `items.filter(\.isVisibleInChat)`。
- `$APP/Models/Chat/TimelineEntryPresentation.swift:184-193` `isVisibleInChat`：对 claude 的每条 message 计算 `displayText`，即 `TimelineText.message`（`:165-169`）对全文做 3 次 `range(of:)` + 一次正则替换和拷贝。**每个 token 都把会话里所有 Claude 消息正文扫一遍并复制一份。**
- 修法：`merge` 对单条增量走快速路径（items 已按 `orderSeq` 有序，二分定位原地替换或插入，只在 history/snapshot 时全量排序）；`V2SessionModel.update` 改增量或直接删掉该并行投影；`V2TimelineItem` 显式实现 `==` 只比 `id/revision/updatedSeq/contentHash`；`isVisibleInChat` 和 `displayText` 在解码时算一次缓存；`stage` 只对变化 item 重算。

**H4. 批次 flush 对所有行做深比较并重建 `TimelineRowStructure`**
- `SessionTimelinePresentation.swift:94-111` `flush` + `:23-45` `row.flush`：每批（≤4 Hz）对每一行做 `value == next` 深比较、再算一次 `displayText`、`received.hasPrefix(text)`、`String(received.dropLast())` 复制正文、**对每一行重建 `TimelineRowStructure`**。
- `$APP/Models/Chat/TimelineRowStructure.swift:16-28`：构造里 `startsVisibleTurn`（`TimelineTurnReview.swift:98-104`，又算一次 `displayText`）、`TimelineGrouping.reconnectMessage` 两次、一次正则、多次 JSON 下标。
- 代价：1000 行时每秒约 4000 次 structure 构造 + 4000 次深比较。
- 修法：flush 只处理 `(revision, updatedSeq)` 变化的 item；`displayText` 与 `structure` 在行模型里按 revision 缓存。

**H5. 流式期间每秒把全部缓存会话整体写盘，send 前还同步等待写盘**
- `V2SessionRepository.swift:596-601` 每次 `emit` 都 `schedulePersistence()`；`:126-141` 1 秒后 `flushCache()` 对 `entries` 里**所有**会话（≤8）无脏标记地重建 `V2SessionArchive` 并逐个保存。
- `$APP/Repositories/V2LocalArchive.swift:34-49`：`V2SessionArchive.init` 是 `@MainActor`，在主线程 `data.items.map(\.raw)` + 拷贝附件预览（上限 16 MB）。
- `$APP/Repositories/V2LocalStore.swift:30-55`：每次 `saveSession` 整体 encode、原子写、再 `trim()` 列目录并读每个文件的 resourceValues。
- `V2SessionModel.swift:178`：`sendDraft` 在发 HTTP 前 `await repository.flushCache()`，发送延迟里包含把 8 个会话写盘。
- `$APP/Views/Chat/Composer/ChatComposer.swift:91-92`：每次击键也走 `draftDidChange → schedulePersistence`。
- 修法：Entry 加 dirty 标记只写脏会话；流式期间把 debounce 拉到 5 到 10 秒，或改为 item 完成 / 退后台 / 切会话时写；`sendDraft` 只落盘当前会话的小记录；draft 单独存；`trim()` 仅在新增文件时执行。

**H6. `makeV2Services()` 在渲染路径同步读 Keychain，AppState 是 god-object**
- `$APP/Stores/AppState.swift:764-776`：每次调用 `keychain.readString` → `KeychainStore.swift:24-38` `SecItemCopyMatching`（一次到 securityd 的 XPC）。
- 直通它的计算属性：`sessionRepository`(742)、`nativeChatServices`(743)、`sessionModel(id:)`(745)、`deviceManagementService`(619)、`workspaceFilesService`(623)、`setVisibleSession`(372)。
- 出现在 body / `.task(id:)` / Binding getter 里的调用点：`ChatShellView.swift:25,54,98,164-166,181,193`、`ChatSidebarView.swift:45,49,142`、`App/MacCatalystWindowTitle.swift:24,29`、`PairDeviceSheet.swift:205,209,236`。
- `AppState.swift:15-43` 约 20 个 `@Published`，`RootView`、`ChatShellView`、`ChatSidebarView`、`NewSessionView`、设置页都 `@EnvironmentObject` 挂在上面；`isWorking`、`authError = nil`、`isRetryingServerConnection` 等任意写入都让整条 shell 重算。`syncDashboard`（`:318-338`）每个 dashboard tick 无条件写 6 个 `@Published`。
- 修法：services 变成稳定存储属性，token 内存副本，只在登录 / 刷新时 `provider.update`；`nativeChatServices` 直接返回 `cachedServices`；AppState 至少把 dashboard 投影与 auth/account 状态拆开，或迁移到 `@Observable`；`syncDashboard` 值变才赋值。

**H7. Sidebar 在 body 里反复 map/sort，排序比较器里每次解析 ISO8601**
- `$APP/Views/ChatShell/ChatShellView.swift:72-79` `sidebarSessions`：filter → map → sort，被 `:96` 和 `:97` 各调一次，每次 sidebar factory 跑两遍。
- `$APP/Models/Chat/SessionSidebarPresentation.swift:9-20`：每次构造都 `Date.ISO8601FormatStyle(...).parse`，失败再 parse 一次。
- `$APP/Models/Chat/ProjectSidebarPresentation.swift:15-20`：`sorted` 比较器里对 `$0`、`$1` 各构造一次 → O(n log n) × 2 次日期解析；`:27-48 projects()` 对所有 session 和 project 调 `timestamp()`；`:4-7 visible()` 对每个 project 线性扫全部 sessions，整体 O(P×S)。
- `$APP/Views/ChatShell/ChatSidebarProjects.swift:30-31,154,207` 每次 body 重算；同样模式见 `DeviceManagementModel.swift:34`、`DeviceOverviewContent.swift:300-301`。
- 配合 H6，每个 dashboard tick（运行中会话状态一变就有）都会重跑，会话数上百时侧栏可感知卡顿。
- 修法：时间戳在 DTO 解码或 `V2DashboardRepository.apply` 时解析一次缓存成 `TimeInterval`；sidebar 投影做成随 `dashboardRepository.onChange` 增量更新的 `@Observable`，视图只读结果；`visible()` 用预建的 `[projectId: [session]]` 字典。

**H8. Dashboard 每次推送把所有缓存会话重新 emit，连锁触发 H3 + H5**
- `AppState.swift:318-332` `syncDashboard` 每次 `onChange` 都 `sessionRepository.applyMetadata(sessions)`。
- `V2SessionRepository.swift:345-362` `applyMetadata`：对每个命中的 entry **无条件** `emit`，即使 `applyMeta` 因 `updatedSeq` 未变被 `:52` 拒绝。每次 emit 走完 H3 全部重建、唤醒 presentation、`schedulePersistence()`。
- `$APP/Repositories/V2DashboardRepository.swift:76-86` `apply`：`connectors`、`projects` 不做等值检查直接赋值触发 Observation；`:226-230 unique()` 每次重排。
- `AppState.swift:333 updateAgentConnections()` → `DeviceAgentModel.swift:27-30` 无条件赋值。
- 修法：`applyMeta` 返回 Bool，只有真正变更才 emit；`apply` 对三个数组做 `!=` 守卫；`updateConnection` 值相等不赋值。

### Medium

**M1. `StreamingGlyphReveal` 在 `isRevealing` 翻转时切换结构分支，整段文本销毁重建**
- `$APP/Views/Chat/Markdown/StreamingGlyphReveal.swift:57-68`：`!enabled` 走 `content`，否则走 `TimelineView { content.textRenderer(...) }`，两个不同结构分支。
- `enabled` 来自 `MarkdownBlockView.swift:108` `isStreaming && !hasSettled`，`isStreaming` 来自 `SessionTimelineRow.swift:48` 的 `row.isRevealing`；`SessionTimelinePresentation.swift:43,51` 只要 token 间隔超过 0.34 秒（工具调用、思考停顿）就翻 false，下一批再翻 true。
- 每次翻转，该消息**所有段落**的 Text 子树都拆掉重建（Textual 重新布局、selection overlay 重装、`BlockLayoutView` preference→state 回路重新收敛），然后 `MarkdownBlockLayout.updateCache:28` 让实测失效。长回复（50+ 段）在 ProMotion 上会明显掉帧。
- 修法：行一旦进入过流式状态就一直留在 `TimelineView` 分支（`paused: true` 停表），只有从未流式过的历史行才用裸 `content`。

**M2. 时间线内容树没有 Equatable 边界，一次结构性失效 = 所有行 body 重跑**
- `$APP/Views/Chat/ChatTimelineView.swift:321-392`：`ChatTimelineContent` 有 `.equatable()`，但一旦因任意行 `structure`、`notices`、`isRunning`、`pendingMessages`、history 标志变化重跑，就对每个 group 重建 `SessionTimelineGroupView`。
- `SessionTimelineEventView.swift:3-9` 和 `SessionTimelineRow.swift:4-10` 带闭包参数且不是 Equatable，SwiftUI 无法跳过 → 每行 body 重跑；`SessionTimelineEventView.swift:53,56` 每行重新构造 `TimelineEntryPresentation`（几十次 JSON 下标、多个 `String(localized:)`、`inlineSummary` 正则）。
- `SessionTurnActions.swift:8` → `TimelineTurnActions.swift:7-10` `copyText`：对每个已完成 turn 把所有回复 trim 后 `joined`，全文塞进 `ShareLink(item:)`。
- `SessionTurnReviewSheet.swift:13-16`：每个带文件变更的已完成 turn 重跑正则 + `TimelineTurnReview.build`（解析本轮所有 diff 并数行）。
- 触发频率：每来一条新 tool/reasoning 行、每次 status 变化、每次 notice 更新。Claude 的工具密集回合里是每秒多次。
- 修法：给 group/row/footer/actions 视图加 `Equatable`（按 id 列表或 `===` 比较，闭包排除在外）；`TimelineEntryPresentation`、`TimelineTurnReview` 结果缓存在行模型按 revision 失效；`copyText` 点击时再算，`ShareLink` 用 `Transferable` 延迟生成。

**M3. Textual：代码高亮每批整块重跑 Prism（JavaScriptCore）**
- `$TX/Internal/Highlighter/HighlightedTextFragment.swift:36-43`：`.task(id: content)`，流式时代码块每批内容都变，于是每批把整个代码块送进 `CodeTokenizer.shared`（`CodeTokenizer.swift:23-66`，单个 `JSContext` actor）重新 tokenize；完成后在主线程逐 token 拼 `AttributedString`（`:62-85`）。
- 一个 200 行的代码块在流式末段每秒 4 次全量 JS 分词。JSContext 单线程，多个代码块串行排队。
- 修法：流式中的尾块跳过高亮（纯文本），块完成后再高亮一次；或只在 `isStreaming == false` 时触发 tokenize。

**M4. Textual：`TextFragment` 每次 body 做整串 `AttributedString` 比较和 runs 扫描**
- `$TX/Internal/TextFragment/TextFragment.swift:36-48`：`.onChange(of: content, initial: true)` 要求每次 body 对 `AttributedString` 做 Equatable 比较；`content.attachments()` 和 `content.runs.contains { $0.link != nil }` 每次 body 都扫全部 runs。
- `$TX/StructuredText/StructuredText.swift:117-128`：`markupDidChange` 在主线程同步 `parser.attributedString(for:)`。App 主路径用自己的 worker 解析后喂块，所以此项只影响直接用 `StructuredText(markdown:)` 的调用点，需要 grep 确认。
- 修法：Textual 已 vendor，可以给 `TextFragment` 传入预先算好的 `hasLinks`/`attachments` 标志，或把 `onChange` 改为按 digest 比较。

**M5. 交互卡片 1 Hz 时钟，每 tick 新建 `ISO8601DateFormatter`**
- `$APP/Views/Chat/SessionInteractionCard.swift:19`、`SessionInteractionContent.swift:11`：每张卡一个 `TimelineView(.periodic(by: 1))`。
- `$APP/Models/Chat/SessionNoticeStore.swift:35-41` `isExpired`：每次调用分配一到两个 `ISO8601DateFormatter`，每 tick 至少被调 2 次 + 每个按钮一次。卡片既在底部 dock 也嵌在时间线 group 里（`SessionTimelineEventView.swift:40-42`）。
- 修法：notice 解码时把 `expiresAt` 解成 `Date`；只有有过期时间的卡才挂时钟；或用一个 `.task` 在到期时刻改一次状态。

**M6. 冷启动恢复：1000 条 item 在主线程逐条 encode + decode**
- `V2LocalArchive.swift:51-52` `projection(maximumItems:)` 是 `@MainActor`，`items.map { JSONDecoder().decode(..., from: JSONEncoder().encode($0)) }`，每条新建一对 encoder/decoder；`V2SessionRepository.swift:109-124` 启动路径调用。`V2LocalStore.read`（`:22-29`）已在 actor 里解过一遍 `[JSONValue]`，等于解两遍。
- 修法：archive 直接存 item 原始 `Data`，在 `V2LocalStore` actor 内解成 `[V2TimelineItem]`（依赖 H1 的 `nonisolated`）；至少先 `limitToLatest(100)` 再解。

**M7. 事件无合并：reconcile 期间堆积的帧逐条全量投影**
- `V2SessionRepository.swift:498-525` `receive` 循环内 `await reconcile`（recover GET + 3 个并发 GET，`:527-569`），期间帧在两层 `bufferingOldest(2048)` 排队，恢复后每帧走 `apply → confirmEchoes → emit`；同一 item 连续 `item_updated` 不 coalesce。
- 修法：在 `for try await` 内尽量 drain，同 id 只保留最新，批次结束 emit 一次。

**M8. 订阅建立成本高，`liveState` 重复读取**
- 打开会话：`load`（snapshot GET）→ ticket POST → WS → `session.subscribed` → `reconcile`：recover GET + state/capabilities/notices 3 GET（`V2SessionRepository.swift:440-496,527-569`；`V2SessionDetailService.swift:122-129`）。snapshot 已含 `state/effectiveCapabilities/notices`（`V2SessionTimeline.swift:17-28`）但不被采信为 fresh。`receive:521-524` 和 `applyMetadata:354-360`（stop/start 重建 socket）会再次触发整套流程。
- 修法：snapshot 在当前 `connectionID` 内获得且 recover 为空时直接 `applyLive` 并标 fresh；或 server 在 `session.subscribed` 帧里带 live state。

**M9. Drawer 的三个 page factory 在每次 AppState 发布和每次键盘 inset 变化时全部重跑**
- `$APP/Views/Components/SidebarDrawer.swift:136-169`：外层 `GeometryReader` 把含键盘的 `safeAreaInsets` 传进 `SidebarDrawerPages`，body 里调三个 closure factory。closure 不是 Equatable，`ChatShellView.body` 一重跑（H6 任意 `@Published` 写入）三个 factory 全执行（含 H7 两遍 sort 和 `:98` 的 Keychain 读）。交互式关闭键盘时 inset 逐帧变化，sidebar factory 也跟着重跑。
- 文档里"pan 不重跑 sidebar 数据"对 **pan** 成立（已逐行验证，见第 4 节），对 AppState 变化和键盘不成立。
- 修法：给 `SidebarDrawerPages` 传 Equatable 的输入 struct 或用 `EquatableView` 包 sidebar 子树；外层 `GeometryReader` 加 `.ignoresSafeArea(.keyboard)`，键盘只在 `mainContent` 内处理。

**M10. `NewSessionModel` 每个 dashboard tick 和每次击键都写 UserDefaults**
- `$APP/Models/Chat/NewSessionModel.swift:87-105`：`updateConnectors`/`updateProjects` 无条件赋值触发 Observation，`updateProjects` 无条件 `identifyProject()` → `:136 persist()`（JSON encode + defaults 写）；`AppState.syncDashboard:335-336` 每 tick 调用。
- `$APP/Views/Chat/NewSessionView.swift:67` + `ChatComposer.swift:91-92`：每次击键 `saveDraft()` 一次 JSON encode + defaults 写。
- 修法：赋值前比较；`identifyProject` 只在 `projectID`/`workspace` 变化时 persist；草稿 debounce 或失焦 / 进后台时保存。

**M11. 每次回到前台都做完整重同步**
- `$APP/App/AgentsAnywhereApp.swift:23-26` → `AppState.setAppInBackground(false)`（`:757-761`）→ 重开 WS + `beginAccountSynchronization()` → `/me` + `refreshDashboard()` 全量 HTTP。切出去 2 秒再回来也如此。`:302-310` 已有 `refreshDashboardIfStale` 但此路径没用。
- `ChatShellView.swift:25` 的 `NewSessionLoadKey` 包含 `network`，`NWPathMonitor` 抖动一次就触发 `newSession.refresh`（两个远程请求）；`V2ConnectivityMonitor.swift:28-32` status 未变也回调。
- 修法：前台路径用 `refreshDashboardIfStale`，`/me` 加时间门限；WS 重连后会收到 snapshot，可跳过 HTTP 全量；`ConnectivityMonitor` 相等不回调。

**M12. `V2SessionModel.update` 每个事件重建 notice 表单**
- `V2SessionModel.swift:216-217` → `SessionNoticeStore.update:131-139` → `SessionNoticeModel.update:47-61`：每个 notice 每次事件都 `NoticeInputForm(next)` 重新解析并比较，不看 `runtime.update:30` 的比较结果。
- 修法：`V2SessionRuntimeModel.update` 返回 notices 是否变化，未变跳过。

**M13. `ChatSidebarView` 仅为 `agentSetup` 和底部按钮整体订阅 AppState**
- `ChatSidebarView.swift:4,45,49,129,142`：`@EnvironmentObject appState` 让 sidebar body 在每个 `@Published` 写入时重算，行级 Equatable 入参的 diff 优势被抵消；`:278` `Array(sessions.enumerated())` 随之重建。
- 修法：`AgentSetupCoordinator`（已是 `@Observable`）作为参数直接传入，sidebar 本体不持有 AppState。

**M14. 内存：timeline item 的 JSON 树存两到三份**
- `V2TimelineItem.swift:39,46-47,75,89-91`：`raw` + `content.raw` + `source` 独立副本；8 个缓存会话 × ≤1000 条 × 工具输出 / diff 大小。
- 修法：同 H2，只保留一棵树。

### Low

- **L1** `ChatMarkdownView.swift:28-77`：每批对整条消息全量 Markdown 解析 + `inlineReference` 正则 + `GitDirectiveParser.enrich` 逐 run 重建 + `split` 逐 run 拷贝。全在 worker，主线程无感，但 4 Hz × 20k 字符会持续占一个核。可只解析最后一个未完成块，前缀复用上次快照。
- **L2** `SessionTimelinePresentation.swift:126-159`：reveal 期间 30 Hz 唤醒做 `flush` + `synchronizePending`（`messages × rows` 嵌套）。改为一次性 `Task.sleep(until: settlesAt)`；`synchronizePending` 仅在 pending 非空时执行。
- **L3** `SessionTimelineEventView.swift:237,255` + `TimelineDiff.swift:20`：展开的工具详情每次 body 重解析 diff，每个 `@@` 行重新编译 `NSRegularExpression`。静态 `let` 正则；结果放 `@State`/`.task(id:)`。
- **L4** `ChatAttachmentStore.swift:37-47,74-80,101`：`resolve` 读操作带副作用（`order.removeAll` O(256)），`cacheKey` 每次 `raw.hashValue` 深哈希；`SessionTimelineRow.swift:17` 每行每次 body 调用。
- **L5** `ChatMarkdownTable.swift:30`、`TableGridLayout.updateCache:78`：每个 cell 每次 body 深哈希，任何子视图变化重测所有 cell。
- **L6** `ChatTimelineView.swift:393-396` + `SessionTimelineEventView.swift:40-42`：notices 与 rows 的双向 O(notices × rows) 过滤。一次性建 `[targetID: [notice]]`。
- **L7** `V2SessionProjection.swift:98-102`：`eventOrder.removeFirst()` O(2048)。用环形索引或 Deque。
- **L8** `V2SessionRepository.swift:46-50`：`session(id:)` 在 View body 中调用并触发 `evict`（filter + sort）；调用点 `ChatShellView.swift:195`、`MacCatalystWindowTitle.swift:29`。
- **L9** `HTTPTransport.swift:162-192` + `AuthTokenProvider.swift:17-22`：请求构建在主线程，每个请求 await 一次 MainActor 取 token。修 H1 时一并处理。
- **L10** `AccountAvatarView.swift:19`：`UIImage(data:)` 在 body 中执行。在 `AppState.me didSet` 时解码一次。
- **L11** `QRCodeScannerView.swift:38-45,77-108,154`：相机 session 配置和 `stopRunning()` 在主线程，可能双重 `startRunning`。
- **L12** `ChatSidebarView.swift:151-158,363-364,423-428`、`ChatSidebarProjects.swift:135`、`DeviceOverviewContent.swift:296`：每行线性 `first` 查找和每行挂 `.alert`。
- **L13** `DeviceManagementView.swift:41-47,52,65,77,123`：`deviceProjects` 一次 body 算 3 次，`onChange(of: allSessions)` 整数组 `==`。
- **L14** `AppState.swift:17-22` + `V2RestorationStore.swift:22-25,39`：`me didSet` 每次 SHA256 + JSON encode + defaults 写；每次前台 `/me` 都触发。
- **L15** `V2DashboardRepository.swift:45-52,114-130`：dashboard 每次推送 500 ms 后整份写盘（无脏检查）；`refreshMissingProjects` 每次推送算一遍集合（有去重，网络有界）。
- **L16** 轮询 / 定时器清单（均有界，仅记录）：`AgentSetupCoordinator.swift:73-94` 配对中 2 秒轮询，后台 / 离线暂停；`V2RealtimeAPI.swift:78-89` 心跳 15 秒检查 / 45 秒超时；`AppState.swift:113-136,725` 账号同步与 socket 重连指数退避；`QRCodeLoginView.swift:269-274` 登录页 1.5 秒轮询（`mobileLoginStatus` 每次 `authError = nil` 发 `objectWillChange`）。未发现无条件常驻 Timer。

## 3. 建议的修复顺序

按"收益 / 改动范围"排序，每条可以是一个独立 PR：

1. **管线去冗余（H2 + H3 的 projection 部分）**：删 `payload()` 往返、删 `confirmEchoes`、`V2TimelineItem` 单树、`merge` 增量快速路径、`JSONValue.init` 分派顺序。纯数据层，有 `SessionProjectionTests` / `SessionRepositoryTests` 兜底，是唯一 per-token × O(n) 的主线程成本，收益最大。
2. **主线程解码下沉（H1 + M6 + L9）**：给 wire 类型和 transport 标 `nonisolated`。改动面广但机械，编译器会把遗漏点全部报出来。
3. **Shell 热路径（H6 + H7 + H8 + M9 + M13）**：`makeV2Services` 不读 Keychain；sidebar 投影预计算、时间戳解析一次；`applyMetadata` 只 emit 变化项。这组决定会话数多时侧栏和切换会话是否卡。
4. **Presentation 增量（H4 + M2 + M12）**：flush 只处理变化行；`displayText`/`structure`/`TimelineEntryPresentation` 按 revision 缓存；group/row 视图加 Equatable。
5. **流式视觉（M1 + M3）**：固定 `StreamingGlyphReveal` 分支；流式尾块跳过 Prism 高亮。
6. **持久化节流（H5 + M10 + L14/L15）**：dirty 标记、拉长 debounce、`sendDraft` 不全量 flush、草稿 debounce。
7. M5、M7、M8、M11 和 Low 项按需。

## 4. 已经做得好的（不要重做）

- 5 Hz 批次缓冲 + `AsyncStream(bufferingNewest(1))` 把 socket 频率和 UI 频率解耦；`ReplyPresentation.batchInterval` 让至多一个 batch 在动画。
- `GlyphRevealLedger` 用 `(count, born)` 条目，`TimelineView(paused:)` 真正停表；`MarkdownBlockSnapshot` 在 worker 上算 digest，主线程只比 `(id, digest)`；`MarkdownBlockView` 是 Equatable。
- Markdown 解析 `Task.detached` + `withTaskCancellationHandler`，取消的旧解析不会覆盖新文本。
- `MarkdownBlockLayout` 单调高度预留 + 实测缓存，没有 geometry→state 反馈；`ChatLayoutUpdate` 把几何回调合并到一次投递；`TimelineScrollState` 纯值状态机，`pendingBottomRequest` 去重。
- Drawer：pan 路径 `SidebarDrawerPanGesture.swift:30-48` → `SidebarDrawer.swift:328-337`（`Transaction(animation: nil)`）→ `SidebarDrawerMotion.move:705-709` 只写 `progress`；读 `progress` 的只有三个小 body（`:722,740,781`）；容器只读量化为 0/0.5/1 的 `restingProgress`；位移用 `GeometryEffect` + `ignoredByLayout()`，阴影是常量 radius + `opacity(progress)`；动画完成用 `completionCriteria: .removed`，无轮询。
- `SessionChatView` 用 `@StateObject` + `StableViewModel` 惰性工厂，`.equatable()` 按身份比较，`.id(session)` 只在切换会话时重建；首屏加载延后到 drawer settle 之后。
- Sidebar 用 `LazyVStack`，行是纯文本 + 矢量 asset，行级 value model 都是 Equatable。
- `V2LocalStore` 是独立 actor，编码 / 原子写 / 数据保护在主线程之外；缓存有界（8 会话 / 1000 条 / 64 MB 单文件 / 128 MB 总量）。
- 版本栅栏（`readVersion`/`catalogVersion`/`connectionID`/`generation`）处理晚到响应；登出取消所有 Task 并 finish continuation；回调都用 `[weak self]`；心跳看门狗 + 指数退避 + `permitsAutomaticReconnect` 避免重连风暴；进后台关闭全部 socket。
- `V2SessionReadCoordinator` 只对可见会话发 read receipt；`V2DashboardService.load` 和 `liveState` 用 `async let` 并发。

## 5. 未做的验证与建议的测量方法

- 全部为静态阅读，没有在真机跑 Instruments（Time Profiler / SwiftUI / Hangs），没有跑 iOS 测试 target。各项"代价"基于代码路径与数据规模（≤1000 条 item、流式 20 到 50 事件 / 秒）推断。
- 建议的复现场景：一个 ≥ 500 条 item、含长回复和多个代码块的 Claude 会话，账号下 ≥ 100 个会话。分别记录：流式输出时的主线程占用（看 `V2SessionProjection.merge`、`V2SessionModel.update`、`JSONDecoder` 的自上而下占比）；侧栏拖动前后一次 `ChatShellView.body` 的耗时（看 `SecItemCopyMatching` 和 `ISO8601FormatStyle.parse`）；工具调用停顿后恢复输出时的掉帧（M1）。
- 仓库已有 `Tests/ComposerDraftAudit` 和 `scripts/probe-drawer-updates.py` 这类回归探针，修完 H3/H4 后可以照同样方式加一个"1000 条 item 下单个 `item_updated` 的 emit 耗时"断言。
