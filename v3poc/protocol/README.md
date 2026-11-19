# v3 会话模型与渲染桥（PoC 草案）

这个目录是 v3 PoC 的契约。Web demo、移动端渲染包和 iOS demo 都按它实现。数据形状**照搬 Effi Cloud 的 `cloud.v1.Conversations`**（`effi-evo/docs/cloud/CONTRACTS.md` 第五节）：字段名、snake_case 写法、ACP 形状的工具调用和设置项都保持一致，这样两个产品的 AI Elements 渲染可以共用。

| 文件 | 内容 |
| --- | --- |
| `timeline.ts` | Session、Message（item）、Control、`watch` 事件、侧栏数据 |
| `services.ts` | `aa.v3.Sessions` 的调用接口（PoC 里没有实现，demo 用 fixtures 回放代替 `watch`） |
| `bridge.ts` | `aa.render/1`：原生 App 和 WebView 渲染包之间的消息 |

## 和 v2 的区别

v2 的 Timeline 是一串扁平条目：`type` 加上原样转发的 `content` JSON，用 `orderSeq`、`updatedSeq`、`revision`、`contentHash` 排序和去重。每个客户端自己分组、猜工具调用该怎么显示、把审批和工具配对，四个端各写一遍。

v3 采用 Effi Cloud 的三份状态，每份都整体推送：

```text
Session  ─ 标题、Agent、设备、目录、设置项（ConfigOption：模型 / 权限 / 推理强度…）
Message  ─ 一个 item：用户消息，或 Agent 回复里的一步
           助手 item 只有一个 part：text | thinking | tool | plan | subagent | compaction
           同一轮的 item 有相同的 turn_id，按 seq 排列
Control  ─ 现在的情况：running / idle、待确认请求、排队的消息、已处理记录、上下文用量
```

- **整条替换，没有版本号，也没有增量**：`watch` 先发快照，之后每次变化推送那一条的完整内容，客户端按 id 替换。流式输出时服务端每 333 ms 推一次正在生成的 item 全量；每个 watcher 的队列对同一个 item 只保留最新值，所以慢设备会跳帧，但不会越积越多。断线就重新 `watch`。
- **一轮回复按 item 存**：做完的工具调用不会再推。按 Effi Cloud 的实测，80 个工具调用的一轮回复，单个客户端收到的流量从 29.8 MB 降到 0.41 MB。
- **审批在 Control 里**：`control.pending[]` 通过 `tool_call_id` 指向对应的工具 item；先答者生效，其他设备看到 `control.answered` 里的「已由某某在某设备上处理」。流式输出不会改动 Control。
- **设置项是通用列表**：客户端按 `ConfigOption` 渲染选择器，不再按 Agent 名字写死模型和权限选项（符合 AA 的「能力驱动」规则）。
- **发送是幂等的**：`send` 带 `client_msg_id`。客户端先在本地显示，推回来的 item 带同一个 key 时整条替换；Agent 正在做事时，按 `delivery` 选择插话还是排队。

## 架构对应关系（提议）

| Effi Cloud | AA v3 | 说明 |
| --- | --- | --- |
| 控制面 effi-cloudd | Server | 账号、设备、权限、签发隧道、推送通知；**不保存任何会话数据** |
| MeshCall Router | MeshCall Router | AA 的 DSH 插件已经在用 MeshCall；`#441` 的 RPC 迁移当时定在 v3 做 |
| 实例里的 agentd | Connector | ACP 宿主（`claude-code-acp`、`codex-acp`），会话同步，终端，文件，git |
| `meshcall/web` + 生成的 TS 客户端 | Web、Desktop | 经隧道直接调用 Connector |
| — | iOS、Android | 原生持有连接，把 `watch` 事件原样转给 WebView 渲染包 |

## 原生与 WebView 的桥（aa.render/1）

```text
原生 App（持有连接、缓存、凭据）                WebView 渲染包（只负责画，和 Web 同一份代码）
        │ watch（原样转发 WatchEvent）  ┌──────────────────────────────┐
        ├────────────────────────────▶ │ 会话 store（同 Web）           │
        │ older / viewport /          │ AI Elements 对话组件（同 Web）  │
        │ appearance / chrome /       └──────────────────────────────┘
        │ scrollToEnd / memoryPressure
        │ ◀─────────────────────────── ready / scroll / loadOlder / answer
        │                               open / copy / rewind / fork / haptic
  液态玻璃顶栏、输入框、审批区、「到底部」按钮、Sheet
```

- 渲染包不带凭据，也不联网。附件走宿主的 URL scheme（iOS 上是 `aa-app://file?path=…`）。
- `viewport` 是原生控件遮住的上下高度。渲染包只给内容加内边距，滚动的仍是整个文档，也就是 WKWebView 自己的 UIScrollView，这样状态栏点击回顶、橡皮筋回弹和玻璃滚动边缘效果才能生效。
- `chrome.approvals = 'host'` 时，审批按钮由原生审批区画，时间线里只标出「等待你确认」；Web 上直接在工具调用下面画 Confirmation。
- 「到底部」按钮由原生画，渲染包只上报 `scroll.atEnd`。
- 系统内存吃紧时（iOS 的内存警告、Android 的 `onTrimMemory`），原生发 `memoryPressure`（`warning` 或 `critical`）；渲染包释放屏幕外各轮的 DOM，把更早的条目从内存里放掉（之后靠 `loadOlder` 取回），并从此保留得更少。

## 已定：数据只在电脑上（2026-11-17）

- **Connector 所在的电脑是唯一的事实来源**：会话、item、Control 都由 Connector 保存在本机，和 Effi Cloud 的 agentd 存在实例卷上一样。
- **Server 完全不保留会话数据**：只负责账号、设备、权限、签发隧道和推送通知，会话内容只经过 Router 转发。这样端到端加密可以照 Effi Cloud 的方式一直开着，Router 只看到密文。
- **手机和 Web 只是远程控制，可以留缓存**：缓存的是最近一次 `watch` 收到的快照和之后的 item（按 id 整条替换，直接落盘即可）。电脑离线时，客户端显示缓存并标出「设备离线，显示的是上次的内容」，不能发送和审批；电脑重新上线后，重新 `watch`，用新快照整体覆盖缓存。
- 推送通知的内容也不能经过 Server 明文保存。通知正文要么由 Connector 端到端加密、由 App 的通知扩展解密，要么只推「有新动态」这类不含内容的提醒。

## 已定：移动端由原生持有连接（2026-11-17）

- iOS 和 Android 由原生持有 MeshCall 连接、`watch` 流和缓存，把 `WatchEvent` 原样转给 WebView 渲染包。WebView 不联网，也不接触凭据。
- MeshCall 需要新写 **Swift SDK** 和 **JVM SDK（Kotlin 优先，Java 也能调用）**。它们要和 Go、Python、TS 三个运行时行为一致：协议帧、隧道、Noise 端到端加密、重连、错误码，以及代码生成出的类型化客户端。SDK 在 `meshcall` 仓库里单独开发；Android 用 JVM SDK。
- PoC 里不实现连接：iOS demo 用 `MockSessionHost` 回放 fixtures。不过它的接口按「一个 `watch` 流加上 `send` / `answer` / `stop` / `set_config` 这些调用」来组织，以后可以直接换成 Swift SDK 生成的客户端。

## 已定：DSH 通过 ACP 适配脚本接入（2026-11-17，由其他人负责）

- DSH 里内置一个插件，插件和外部的一个启动脚本之间走 RPC。
- 这个脚本对 Connector 来说就是一个普通的 stdio ACP Agent，和 `claude-code-acp`、`codex-acp` 一样被拉起。Connector 不需要为 DSH 写特殊分支。
- DSH 自己的进程不受影响：脚本退出或崩溃都不会拖垮 DSH，反过来也一样。
- 因此 v3 的 Connector 只需要实现一种 Agent 接入方式：ACP。
