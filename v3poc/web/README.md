# v3 PoC · Web 与移动端渲染包

这个目录是 v3 PoC 的 Web 一半：同一份对话组件（`src/conversation/`）同时用于

- **Web demo**（`index.html` → `src/web/`）：侧栏、顶栏、对话、输入框，数据由本地回放脚本提供；
- **移动端渲染包**（`renderer.html` → `src/renderer/`）：只画对话，打包成一个自包含的 HTML 文件，放进 iOS / Android 的 WebView，原生控件（液态玻璃顶栏、输入框、审批区、「到底部」按钮）盖在上面。

契约在 `../protocol/`（会话模型 `timeline.ts`、渲染桥 `bridge.ts`），演示数据在 `../fixtures/`。

## 运行

```bash
cd v3poc/web
npm install
npm run dev            # http://localhost:5173/ 是 Web demo，/renderer.html 是渲染包（浏览器里自带回放宿主）
npm run typecheck
npm run build          # = build:web（dist/）+ build:renderer（单文件，复制到 ../ios/AAv3PoC/Renderer/renderer.html）
npx vite preview       # 预览 dist/：/ 和 /renderer/renderer.html
```

调试参数：

- Web demo：`?session=s-release` 打开别的会话，`?theme=dark`，`?approvals=host`（审批只标「等待你确认」，不画按钮）。
- 渲染包（没有原生宿主时）：`?scheme=dark|light`、`?approvals=inline|host`、`?top=62&bottom=96`（模拟原生遮住的高度）、`?scale=1.2`（Dynamic Type）、`?speed=2`、`?stress=…`（压力模式，见「性能」）。

## 目录

| 路径 | 内容 |
| --- | --- |
| `src/timeline/store.ts` | `watch` 的客户端：快照，然后按 id 整条替换；乐观发送（`client_msg_id`）；记住见过的审批请求，用来显示「已由 X 在 Y 上处理」 |
| `src/timeline/mock-host.ts` | 按 `fixtures/build.py` 顶部写的脚本语义回放：`seq` 在 id 第一次出现时分配；`stream` 每 333 ms 推一次整条；`until: answer` 暂停到有人回答，回答把请求从 `pending` 移到 `answered`；`reply` 里的 `$TURN` / `$X`。另外实现了发送（忙时排队）、停止、改设置、回退、加载更早的消息 |
| `src/conversation/` | 对话组件：`turns.ts`（item → 轮次 → 段落）、`thread.tsx`（消息、气泡、附件、操作）、`steps.tsx`（思考 / 工具 / 计划 / 子 Agent）、`confirmation.tsx`（审批）、`markdown.tsx`（Streamdown）、`virtual.tsx`（长会话的内存上限，见「性能」）、`env.ts`（对话对外的全部动作：回答、打开、复制、回退、分叉、触感） |
| `src/web/` | Web demo：`app.tsx`、`app-sidebar.tsx`、`composer.tsx`、`context-meter.tsx`、`sessions.ts`（每个会话一个 store + MockHost，切走后继续在后台回放） |
| `src/renderer/` | 渲染包：`main.tsx`（`window.aaRenderer.receive`、`ready`）、`bridge.ts`（发给 `webkit.messageHandlers.aa` 或 `aaHost`）、`surroundings.ts`（viewport / appearance / chrome）、`document-scroller.tsx`（文档滚动）、`dev-host.ts`（浏览器里的回放宿主）、`stress.ts`（压力模式，见「性能」） |
| `src/components/ui/` | shadcn（base-nova）与 AI Elements 的基础组件，按 shadcn CLI 装进来的原样 |

## 渲染包要点

- **滚动的是整个文档**，不是内部的 overflow 容器：iOS 上必须由 WKWebView 自己的 UIScrollView 滚动，状态栏点击回顶、橡皮筋回弹、玻璃滚动边缘效果才会生效。stock 的 Message Scroller 只能滚一个元素，所以 `document-scroller.tsx` 按它的行为对 `window` 重写了需要的部分：打开时停在末尾（布局稳定前隐藏，避免跳动）、读者在末尾时跟随流式输出、读者往上滚就放开、上方插入更早的消息时保持位置、对方发出新消息时回到末尾、防抖 100 ms 上报 `scroll {atEnd, atTop}`、读者滚到顶部附近且 `has_more` 时发 `loadOlder`。没有自己的「到底部」按钮（原生画）。
- 内边距跟随 `viewport.top/bottom`；背景是 CSS 变量 `--aa-page-bg`（浅色 `#fff`，深色 `#000`，对应 `UIColor.systemBackground`）；字体是系统字体栈。
- **字号**：AI Elements 的正文是 `text-sm`（16px 根字号下 14px），按桌面设计；iOS 正文是 17pt。渲染包把根字号设为 `16 × 17/14 × textScale` px，所有 rem 尺寸一起等比放大，样式仍是 AI Elements 原样；`renderer.css` 只把步骤行里的等宽文字缩到约 15px，并让表格横向滚动而不是把短单元格挤成两行。Web demo 保持默认尺寸。
- 渲染包不联网、不带凭据：附件图片用 `aa-app://file?path=<编码后的路径>`，链接和文件路径都发 `open`，从不自己跳转；复制发 `copy`；点按发 `haptic`。
- 产物是一个文件，约 15.6 MB（体积不是约束，打进 App 的本地文件）。为了启动快，构建是先分包（CommonJS）再合成一个文件：入口和它立刻要用的部分在启动时执行；Shiki（引擎、全部语法和主题）、Mermaid、KaTeX 等以文本形式放在 `<script type="text/aa-chunk">` 里、排在入口后面，第一次用到时才 `new Function` 执行（见 `vite.renderer.config.ts`）。数学公式和 Mermaid 只在回复里出现 `$` 或 mermaid 代码块时才加载。无头 Chrome 里从开始加载到发出 `ready` 约 60 ms，CPU 降速 4 倍约 280 ms。

## 性能：长会话的内存上限

iOS 压力测试（`.local-dev/v3poc/ios/stress/r2-*`）里，30 Hz × 3 路推 6 分钟后 DOM 到 5.5 万节点、WebContent 从 485 MB 涨到 1.6 GB；打开 3000 条的快照要 6.6 秒、39.9 万节点。现在 DOM 和 JS 堆不再随会话变长而增长，每次推送的开销也和会话长度无关。Web 和渲染包用的是同一套机制。

**瓶颈**（桌面 Chrome 的 CDP 指标和 CPU profile）

- 每次推送都会让**每一轮**重新渲染：`Turn` 虽然是 memo，但传进去的 `state` 每次都是新对象，子 Agent 步骤的 Map 每次也重建，所以 memo 不起作用。每 10 秒的脚本时间随会话长度线性增长（6 分钟内从 0.7 秒涨到 2.9 秒），其中 React 的渲染占大头。每次渲染还会对编辑重新跑一遍 LCS diff。
- 每个 item 平均要约 134 个 DOM 节点，而且画出来之后一直留着。快照有多少条，就画多少条（3000 条快照一共 200 轮、72 万 px 高）。

**做法**

- **只重画变了的轮次**：`TurnCache` 让没变的轮次沿用原来的对象；`Turn`、`StepGroup`、`StepRow` 的 props 在推送之间保持不变；编辑的 diff 按字符串缓存。现在一次推送只重画正在流式输出的那一轮。
- **屏幕外的轮次不保留 DOM**（`conversation/virtual.tsx` 的 `LazyTurn`）：离视口超过 1.5 屏的轮次，换成一个和上次实测高度一样的空块。回到附近时再画，因为高度不变，滚动条不会跳。正在运行的轮次和等审批的轮次始终保留。手动展开或收起的步骤组会记住状态，重新画出来时保持原样。
- **store 只保留约 200 条**（`timeline/store.ts` 的 `WINDOW`、`trimHead`）：
  - 超过 200 条的快照只留最后 200 条。
  - 读者停在末尾时，每秒检查一次，以整轮为单位放掉最前面的部分。
  - 被放掉的部分在 store 里记为 `has_more: true`，再加一个下限 `floorSeq`。下限以前的条目再推过来会被忽略，只能通过 `loadOlder` 取回：渲染包里是滚到顶部附近自动取，Web 上是「加载更早的消息」按钮。
  - 读者往回翻历史时不裁剪，否则刚加载的页会被马上放掉；这时只靠 `LazyTurn` 控制 DOM 数量。
- **长输出只画一部分**：终端和工具输出只画最后 200 行，读文件和 diff 只画前 200 行，下面注明「前面/后面 N 行没有显示」，点「显示全部」（或「显示最后/前 2000 行」）最多展开到 2000 行。已有复制按钮的行为不变。工具输出不再逐字显示（每次推送都会重新分割整段文本）；Markdown 的渐显还是 Streamdown 自带的。
- **滚动**（`renderer/document-scroller.tsx`）：
  - 读者位置用二分查找来定，不再遍历所有轮次。
  - 尺寸变化在一帧内只处理一次。
  - 「到底部」改成逐帧追赶：如果离末尾超过两屏，先跳到最后一屏，再缓动到底；末尾还在变就继续追，直到连续两帧都在末尾，或者读者自己开始滚动为止。
  - 还修了一个原有问题：页面刚加载的 600 ms 内，程序发起的滚动会被当成读者在滚，导致一开始就不再跟随，压力测试里一直停在顶部附近。
- **内存警告**：原生发 `{type:'memoryPressure', level:'warning'|'critical'}`（`protocol/bridge.ts`）后，保留 DOM 的范围从 1.5 屏缩到 0.5 屏（`critical` 时 0.1 屏），store 的窗口从 200 条降到 120 条（`critical` 时 60 条），并立即裁剪一次，同时清掉 diff 缓存。这个级别会一直保持到渲染包重新加载。

**测量**

压力模式：`renderer.html?stress=items:3000,chars:3000,hz:30,parallel:3`（参数含义见 `src/renderer/stress.ts` 文件头）。内容按 `ios/AAv3PoC/Model/StressContent.swift` 移植。宿主跑在 Web Worker 里，所以页面的堆里只有渲染包自己留下的东西；每次推送都经过结构化克隆，和原生 `evaluateJavaScript` 一样要复制一份。

测量环境：无头 Chrome（系统安装版），视口 402×874，移动端模拟。对照组是改动前的代码，换上同一个 Worker 压力宿主后构建；改动前后的启动时间（发出 `ready`）相同，都约 60 ms，CPU 降速 4 倍时约 250 ms。原始数据和脚本在 `.local-dev/v3poc/web/perf/`。

打开 3000 条的快照：

| | 改前 | 改后 |
| --- | --- | --- |
| 收到 → 画出 | 3.27 s | 0.23 s |
| 同上，CPU 降速 4 倍 | 6.78 s | 0.45 s |
| DOM 节点 | 388,752 | 2,629 |
| JS 堆（强制 GC 后） | 243 MB | 22 MB |
| 页面高度 | 72 万 px（200 轮） | 10.6 万 px（14 轮，更早的靠 `loadOlder`） |

30 Hz × 3 路推送 6 分钟（读者在第 60 秒往上滚 3000 px，停 10 秒后收到 `scrollToEnd`）：

| 时间 | DOM 节点 | JS 堆 MB | 收到 → 画出 平均 / p95 ms | 每 10 秒脚本 ms | 每 10 秒布局 ms |
| --- | --- | --- | --- | --- | --- |
| 30 s | 5,673 → 1,726 | 44 → 42 | 14.5 / 23.4 → 10.9 / 18.0 | 732 → 636 | 2,010 → 501 |
| 60 s | 10,360 → 2,920 | 41 → 58 | 14.7 / 22.9 → 10.4 / 17.2 | 836 → 471 | 2,645 → 424 |
| 120 s | 20,230 → 2,817 | 70 → 39 | 15.4 / 23.4 → 9.5 / 17.1 | 1,194 → 379 | 2,408 → 334 |
| 180 s | 29,746 → 1,019 | 95 → 56 | 15.7 / 23.7 → 9.9 / 17.0 | 1,550 → 525 | 2,300 → 505 |
| 240 s | 39,444 → 3,018 | 86 → 54 | 17.5 / 25.2 → 11.1 / 17.8 | 1,931 → 493 | 2,717 → 475 |
| 300 s | 48,903 → 2,337 | 108 → 64 | 18.6 / 26.1 → 11.2 / 17.9 | 2,448 → 610 | 2,558 → 561 |
| 360 s | 58,802 → 2,457 | 116 → 50 | 19.1 / 26.9 → 9.5 / 16.5 | 2,874 → 389 | 2,314 → 345 |

- 改后 DOM 一直在 1,000 到 3,000 个节点之间，堆在 38 到 65 MB 之间来回（没有强制 GC，所以呈锯齿状），都不随时间增长。改前两者都线性增长。
- 桌面 Chrome 在两种情况下掉帧率都接近 0（最高约 1%），这一项复现不了 iOS 上 80% 的掉帧；要看掉帧，还得在真机上测。
- 「到底部」：改前在 70 ms 内到达末尾，改后约 300 ms 到达，因为加了缓动；两种都在 3 秒后仍然停在末尾。逐帧检查：改后跟随时，每一帧画出来离末尾都不超过 24 px；改前因为上面提到的加载期问题，前 70 秒一直没有跟随。
- 往回翻时，取回更早的条目后，读者正在看的那一轮在画面上的位置不变（逐帧在画出之后测量）。

## AI Elements：原样用的和改过的

原样使用（组件和结构按文档的 Usage 写，样式不改）：

- **Chat**：Web 上 `MessageScrollerProvider autoScroll` + `MessageScrollerItem`（对方的轮次 `scrollAnchor`）+ `MessageScrollerButton`。
- **Message / Bubble**：用户消息 `Message align="end"` + `Bubble variant="muted"`；Agent 回复是不带气泡的 `Message`，操作放在 `MessageFooter`，每个操作是带 Tooltip 的 ghost 图标按钮。
- **Tool / Terminal / Reasoning / Plan / Subagent / Queue**：都是 Trace。工具调用是 `TraceLine`，有内容时是 `TraceCollapsible`；状态按文档映射到 `running` / `error` / `pending`；终端在流式输出到达时展开（Terminal › Open While Running），思考在写的时候展开、写完收起，读者手动开合后以读者为准（Trace › Open State）。
- **Code Block**：Markdown 里的代码块（带复制按钮，高亮来自 Streamdown 的 Shiki 插件），读文件的结果（行号从实际起始行开始），编辑的 diff（`CodeBlockLine` 的 `added` / `removed`）。
- **Confirmation**：工具行下面的 outline `Item`，在 Trace 之外。
- **Checkpoint 的 Marker**：上下文压缩用 `Marker variant="separator"`，「已由 X 在 Y 上处理」用普通 `Marker`。
- **Attachment**：用户消息里的图片（竖排卡片）和文件，输入框里待发送的附件。
- **Prompt Input + Model Selector**：`InputGroup` + `InputGroupTextarea` + `block-end` 里的附件按钮、选择菜单、发送按钮；菜单是 `DropdownMenuRadioGroup`。
- **Context**：`HoverCard` + `Progress`。

改过的地方和原因：

| 位置 | 改动 | 原因 |
| --- | --- | --- |
| 数据层 | 不用 AI SDK 的 `useChat` / `UIMessage`，用自己的 store | v3 的数据是 Effi Cloud 形状的 `watch`（item 整条替换），不是 AI SDK 的消息流 |
| Markdown | 用 Streamdown（自带样式、未闭合 Markdown 修复、逐词渐显，插件 code / math / mermaid / cjk 全开）；代码块按 Code Block › Markdown 的写法交给 AI Elements 的 Code Block，mermaid 仍由 Streamdown 画；链接改成发 `open`；界面文字译成中文 | 和 AI Elements 一致；整个应用只有一份 Shiki（`@streamdown/code`），Code Block、读文件、diff 都用它 |
| 工具调用 | 照 Effi Cloud：两段文字之间的步骤（思考、工具、子 Agent、计划）合成一组，运行中显示「运行中 · 时间 · N 个工具」并展开，结束后折叠成「用时 … · 想了 N 次，运行了 N 条命令…」，展开后标题是「收起」，只有一步时不加组标题；有待审批的步骤时组总是展开；步骤和详情都和正文左对齐（去掉 Trace 内容的竖线和缩进） | 用户要求和 Effi Cloud 一致 |
| Streamdown 全屏按钮 | 渲染包里关掉表格和图表的全屏（复制、下载保留） | 原生有自己的全屏方式 |
| 渲染包的滚动 | 自己实现文档滚动，不用 Message Scroller | 见上；Web 上仍用 Message Scroller 原样 |
| Confirmation 的按钮 | 按 ACP 请求自带的选项画（拒绝 / 本会话都允许 / 允许），不是固定的 Deny / Approve | ACP 有 `allow_once` / `allow_always` / `reject_once` / `reject_always`；排序保持「拒绝在左，允许是主按钮」 |
| 审批在原生画时 | 工具行下面一个 outline `Badge`「等待你确认」 | `chrome.approvals = 'host'` 时按钮在原生审批区 |
| 工具行文案 | 「运行了 / 查看了 / 修改了 file +9 −4」，借用 Effi Cloud 的说法；diff 计数放在 `TraceDescription` 里并着色 | 中文界面；和 Effi Cloud 一致 |
| 执行命令的详情 | 代码块头部显示工作目录，内容是 `$ 命令` 加输出 | 行上的命令会被截断，展开后要能看到完整命令 |
| Context 触发器 | outline 按钮里加了一个小圆环，再写百分比 | 顶栏需要一眼看出用量 |
| 发送按钮 | 用 `aria-disabled` 代替 `disabled` | stock 的 `InputGroup` 只要里面有 disabled 元素就把整个输入框变灰（`has-disabled:opacity-50`），空输入框时整个输入区会看起来不可用 |
| Web 的排队消息 | 画在输入框上方（Queue 模式），不在对话里 | Message Scroller 在「条目数不变、换了一个条目」时会去锚定第一个没处理过的锚点，排队气泡变成正式轮次正好触发它，视图会跳到顶部；渲染包用文档滚动，没有这个问题，排队消息仍画在对话末尾 |
| 用户消息的操作 | 鼠标设备上悬停才显示（触屏一直显示） | 每条消息下都常驻图标太吵 |
| 新的一轮（渲染包） | 回到末尾跟随，不做 Message Scroller 的「把这轮顶到上方并留出空间」 | PoC 先求稳；Web 上保留原样的锚定 |

## 对协议的建议（还没改契约）

- `bridge.ts` 没有告诉渲染包「我是谁」。`control.answered[].by` 是账号名，渲染包没法把自己的回答显示成「你」。建议在 `appearance` 或新增的 `identity` 消息里带上当前账号名（dev 宿主暂时用 fixture 里的账号）。
- 子 Agent 的步骤里如果有文字（`text` item 带 `subagent_id`），现在画成子 Agent 内的灰色段落；契约里没写明这种 item 是否会出现，最好写清楚。

## 没有验证的

- 没有在真机或模拟器的 WKWebView 里跑：`aa-app://` 图片加载、`webkit.messageHandlers.aa` 往返、状态栏点击回顶、惯性滚动时跟随 / 放开的手感、`viewport` 变化（键盘弹出）时的位置，都只在桌面 Chrome 的移动模拟里看过。
- Android（`window.aaHost`）完全没有测。
- 剪贴板：Web 上直接写剪贴板；渲染包里代码块的复制按钮会同时调用 `navigator.clipboard` 和发 `copy`，WKWebView 里前者可能失败（按钮不会变成对勾），以宿主为准。
- 内存上限只在桌面 Chrome 里测过。iOS / Android 的 WebContent 进程内存、真机掉帧、`memoryPressure` 由原生真正发出的情况都还没测。轮次很长（一轮超过一屏）时，这一轮本身不会被拆开。
- `older` 分页只回放了一页合成的历史（被窗口放掉的条目会如实取回）；`rewind` 只在 mock 里实现（截断后重发快照）；`fork` 在 Web demo 里只打印日志。
