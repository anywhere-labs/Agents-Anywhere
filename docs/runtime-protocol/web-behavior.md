# Web Behavior Target

状态：草案。

本文档定义 Web 应如何消费 Agent Runtime Protocol v1。

## 原则

- Web 不得从运行时名称推断行为。
- Web 不得把 Server 目录缓存当作事实来源维护。
- Web 可以在本地记住用户最近一次的模型/权限选择，但仅限新会话。
- 既有会话的消息发送不得携带模型/权限 selection id。
- 命令不是消息。

## 设备运行时展示

运行时类型和运行时实例承载不同的事实；Web 不得混用。

- 设备列表里的运行时类型表示"这个 connector 支持该类型"。它不带可用性，
  也没有错误状态，因此永远不要用警告或错误颜色渲染。本地程序是否在运行
  不属于类型列表。
- 只有已配置的实例才有可用性和错误状态。可用性表示"已配置且在运行"。
  一个配置过但从未启动的实例是中性状态，不是失败。
- connector 在用户配置或启动实例时（`runtime.validateConfig` /
  `runtime.start`）判定真实可用性，绝不在 `runtime.discover` 时判定。
  配置或启动失败的原因会记录在实例上，Web 在实例上渲染该原因。
- `runtime_unavailable`、`runtime_not_started`、`runtime_not_configured` 和
  `connector_offline` 表示"尚不可用"，应带 connector 给出的原因渲染为警告，
  而不是故障。
- `starting` 和 `stopping` 是真实状态。Web 应展示过渡过程，而不是从已停止
  直接跳到运行中。
- `instancePolicy` 和 `maxInstances` 限制同时运行的实例数。已保存的配置不会
  隐藏一个本可添加的运行时类型。Connector 在启动时检查容量，达到上限时
  Server 返回 HTTP 409 和 `runtime_conflict`。停止实例会释放它的运行位，
  但不删除其配置。

## 新会话

流程：

```text
Open new session
  -> read runtime model catalog
  -> read runtime permission catalog
  -> preselect local recent selection if still present and enabled
  -> otherwise choose first enabled option
  -> create_and_start with selections + first message
```

协议中没有运行时默认值。默认选择是前端行为。

第一个目标不支持创建空白新会话。

## 既有会话

初次加载：

```text
Load session snapshot
  -> read SessionMeta
  -> read SessionState
  -> read SessionTimeline
  -> read SessionNotice
  -> render timeline/notices
```

打开选择器：

```text
Open model selector
  -> live read runtime model catalog

Open permission selector
  -> live read runtime permission catalog
```

变更选择器：

```text
User chooses selection
  -> PATCH session runtime selection
  -> runtime accepts or rejects
  -> Web may update optimistically
  -> Web reconciles from runtime.state.updated or GET /runtime/state
```

运行时也可能在没有用户直接操作的情况下更新选择项。Web 必须把 RuntimeLive
状态更新视为权威。

## 消息输入框

对既有会话：

```text
POST /sessions/{id}/runtime/messages
```

载荷应包含：

- content
- attachments
- client message id

载荷不得包含：

- model selection id
- permission selection id

## 命令

当输入以 `/` 开头时，Web 应通过实时 RPC 列出命令：

```text
GET /sessions/{id}/runtime/commands
```

前端负责：

- 过滤
- 模糊匹配
- 排序
- 键盘导航
- 补全
- 展示禁用原因

协议不包含 `autocomplete`。

执行命令：

```text
POST /sessions/{id}/runtime/commands
```

命令执行返回普通的 RPC 结果。如果运行时改变了 Timeline、状态、选择项或通知，这些变化通过正常的运行时事件到达。

如果命令目录查询或执行失败，Web 必须显示错误，不得把 `/xxx` 输入作为普通消息发送。

选择带参数的命令会插入可编辑草稿；显式提交会保留完整的 `raw` 输入。命令的
`metadata.ui` 决定走原生命令执行，还是打开受支持的模型/reasoning/权限选择器。
没有该元数据的命令在 idle/error 状态下保留旧式单行执行。只有明确声明时才允许
多行输入。附件保留在草稿中。

Web 区分 accepted、completed 和 unknown 执行结果，展示原生文本，并且即使
HTTP 200 也把 `ok: false` 视为失败。失败和不确定的结果都会保留输入；unknown
结果绝不自动重试。迟到响应不能清空更新的草稿，也不能影响另一个会话，包括
用户离开又回到原会话的情况。

在会话切换、命令菜单重新打开、重连、运行时状态/可用性变化以及
`session.commands` 目录 revision 变化时重新拉取目录。导航时立即隐藏上一个
会话的目录。命令可用性仍然要求生效能力、在线可写的会话，以及命令自身的
原生状态限制。

## 会话 RuntimeLive UI

Web 应从 RuntimeLive 状态渲染忙碌/阻塞标签。操作可用性（包括 interrupt 和
steer）来自会话级生效能力。Timeline 和通知解释正在发生什么，但不得取代
RuntimeLive 状态或生效能力。
- 选择项
- 状态原因
- 错误
- 元数据

它不包含：

- 活跃 turn id
- 命令列表
- 目录数据
- Timeline 条目

## 快照与恢复

快照用于初次加载和显式恢复，不是周期性刷新。常规更新应通过 WebSocket/事件恢复流转。

序列缺口不应强制使用快照，除非 Server 明确标记恢复不可能。Timeline 条目只做 upsert；隐藏取代删除。
