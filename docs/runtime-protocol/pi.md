# Pi Runtime

本分支把 Pi 作为原生 Runtime 注册到标准 Connector，不再需要额外的
`pi-agents-anywhere` Python 包、`pi-aa-connector` 入口或桌面 `.pth` hook。
Codex、Claude、DSH 保持原有顺序和实现，Pi 追加到 registry。

## 安装与配置

1. 工作设备另行安装 [Pi](https://github.com/earendil-works/pi)，确保 Connector
   启动环境能找到 `pi`。当前 Windows、macOS、Linux 均已升级/保持 Pi 1.1.0
   并通过真实基础 RPC 验证。Node 要求为 22.19+；本次实际使用的版本分别为
   24.14.0、22.19.0、24.21.0。Linux 登录 PATH 中的 Node 20 不是 Pi 的专用运行时。
2. 使用本分支的 Connector，或重新构建包含它的桌面版。在工作设备下添加
   Pi Runtime。仅复制仓库不会修改已安装的官方桌面版。
3. 使用现有 Pi 模型配置与登录方式。本集成不安装 Pi、不登录模型账户、不
   把模型密钥放入 AA Runtime 配置。

示例配置（占位/默认值，不含真实账户）：

```json
{
  "executablePath": "pi",
  "sessionsDir": "~/.pi/agent/sessions",
  "defaultCwd": "~",
  "requestTimeoutMs": 60000,
  "idleTimeoutSeconds": 600,
  "permissionMode": "ask-writes"
}
```

指定现有 `sessionsDir` 会将该目录中的历史同步到连接的 AA Server。如果只想
同步新会话，应先选择空的专用目录；不要为了测试拷贝全部历史与模型凭据。
Windows 支持 npm `pi.cmd` 解析为 Node + CLI 参数数组；不要把完整 shell 命令
填进 `executablePath`。桌面进程的 PATH 可能与终端不同。

## 保留的能力与安全边界

- Pi 原生 JSONL 会话读取、时间线投影、模型/权限/命令目录。
- JSONL 严格按 LF 分帧，持续消费 stdout；文本与工具输出流式投影。
- `agent_settled` 才表示自动工作结束，不能把 prompt 接受响应当成完成。
- `ask-writes` 默认审批、拒绝不执行、图片和文本/文件附件处理。
- 每会话 Pi RPC 子进程、空闲回收与原生文件续接。
- 重连通过通用 `on_backend_reconnect()` 回调重报真实会话状态，不重启会话。
  首次调用不受系统刚启动时 monotonic 时间较小的影响，之后保留防抖。

工具审批不是 OS 沙箱。Pi 扩展代码仍拥有进程的文件和网络权限；只加载可信
扩展。`full-auto` 不是默认模式，不能为了绕开审批而自动启用。

本分支使用原生注册，不应再叠加旧外部 CLI/hook。旧桌面环境的迁移必须单独
备份并验证，不能直接删除既有 `.pth` 或运行另一份持有同一设备身份的 Connector。

## 时间线同步与会话状态

- 每个会话文件在 Connector sync state 中保存检查点
  `pi/timeline-sync/<文件路径>`：文件的 mtime/size 和每个条目的指纹。
  轮询扫描在 ingest 成功后才写检查点；单纯读取快照、上传失败都不算已同步，
  下次轮询会重试。一轮结束时的同步交给 Connector 发送队列后即写检查点（与
  Claude 相同），以保持它排在本轮流式条目之后；若该请求之后被服务端永久拒绝，
  要等会话文件再次变化才会重传。检查点持久化，Connector 重启后未变化的会话不再重传。
- 已流式发布的条目 id 只在内存中。每轮第一个流式条目发出前先删除该会话的
  检查点，提交时如果还有未校准的流式条目也不保存检查点。这样 Connector 在一轮
  中途重启后会整份替换，不会把用户消息追加到已流式发布的回复之后。sync state
  定期落盘，在下一次落盘前崩溃仍可能保留旧检查点。
- 默认只发送新增或变化的条目（`complete=false`）。以下情况发送整份替换：
  没有有效检查点（首次同步或版本变化）；已发布的条目从当前分支消失
  （`/tree` 切换分支、仅在流式阶段出现的条目）；条目位置变化；新条目排在
  已发布条目之前。平台的增量写入不会删除条目，已有条目保持原位，新条目
  追加在末尾，所以这些情况只有整份替换才正确。外部 Pi 终端推进的会话按增量同步。
- AA 发起的一轮里，用户消息在本轮开始时先流式发布，带上客户端的 clientMessageId
  （替换客户端的乐观显示），之后才是回复和工具调用，等待审批期间顺序也正确。
  用户消息和助手消息一样按消息时间戳生成 id，流式阶段与落盘后的历史 id 一致。
  这次修改改变了用户消息的 id 规则，已同步的会话在文件下次变化时会整份替换一次。
- 带附件的消息：Pi 收到的是附件说明加图片块，AA 时间线显示用户原文和附件
  （`content.attachments`，含 fileId、文件名、类型、大小），客户端据此显示缩略图和
  文件卡片。Pi 发出这条用户消息时，Connector 把它和刚发出的那次发送对上（Pi 存的
  文本以发送的文本开头，图片缩放会追加提示），按消息时间戳记一条回执
  `pi/client-message-receipts/…`，历史投影按时间戳取回执，不按文本猜测，所以文字
  相同的两条消息各自保留自己的附件。带附件的回执随会话保留；不带附件的只用于
  乐观发送去重，保留最近 200 条。Pi 没有收下的发送（下发选择或 prompt 失败、扩展
  命令或输入处理器直接处理掉）会从待匹配列表删除，不会把附件借给下一条同样文字的
  消息。已知局限：同一毫秒的两条用户消息共用一个时间戳，只有第一条能取到回执；
  同样文字的 follow-up 与 steer 被 Pi 重新排序时附件可能对调；回执写入后、sync
  state 落盘前 Connector 崩溃会丢失这条消息的附件显示（Pi 收到的内容不受影响）。
- 流式阶段 Pi 还没有给消息分配 entry id。自定义消息、`!` 命令、分支摘要
  在这一阶段使用本轮内唯一的临时 id，结束后由整份替换换成正式 id。
- 中断：Connector 先向 Pi 发送 `abort`，再把这一轮打开、尚未答复的对话框按取消
  答复（与在 Pi 终端里按 Esc 相同），通知标记为 `cancelled`。Pi 的 `abort` 要等这一轮
  结束才响应，而等待对话框的一轮只有对话框被答复后才会结束；审批扩展的确认框也带上
  这一轮的中断信号。此前在等待审批时中断会一直挂起，直到有人答复。
- 轮次结束的 `outcome`：用户中断或 `stopReason=aborted` 为 `interrupted`，
  `stopReason=error` 为 `failed`，其余为 `completed`。Pi 进程在一轮中途退出时
  补发 `failed`（切换权限重启时为 `interrupted`）。
- 扩展对话框使用平台已有的交互类型：`confirm` 为 `confirmation`（确认/取消）；
  `select`、`input`、`editor` 为 `input_request`，带 inputRequest v1 表单
  （单个问题：`select` 只能选给出的选项，`input`/`editor` 填写文本），Pi 的方法名
  在 `context.method` 中。答复按表单校验，无效答复返回请求错误、对话框保持打开。
  v1 表单没有默认值和多行标记：`input` 的 placeholder 和 `editor` 的预填内容写在
  问题说明里，提交的文本整体替换预填内容；网页端会把说明显示成一行。
- 一轮中打开、到这一轮结束仍未答复的扩展对话框已被 Pi 取消，通知标记为
  `cancelled`；带 `timeout` 的对话框超时后标记为 `expired`。会话随后回到
  `idle`，可被空闲回收。
- Pi 没有跨进程写锁。AA 的 Pi 进程仍在运行时，外部 Pi 终端可能续写同一会话文件。
  每次向空闲的活进程发消息、执行命令或修改选择之前，Connector 用文件最后一条记录的
  id 调用 `get_entries`（`since`）；进程不认识它就重开进程、从文件重新加载，避免 AA
  的下一轮从旧位置分叉。文件尾 8 MiB 内找不到完整记录时无法判断，也重开。Pi 不支持
  `get_entries` 时不做此检查。
- 进程的关闭和重新启动（切换权限、外部写入后重开）在同一把启动锁内完成，其间
  不会有其他请求用旧的权限模式启动进程。被替换掉的进程，其迟到的事件和退出回调
  一律忽略。请求取用会话时先记一次活动，空闲回收不会在它使用期间关闭会话；万一
  已被回收，这个会话对象不再启动进程，请求改为重新打开会话，不会留下不在注册表
  中的 Pi 进程。新会话启动时取不到 `get_state`（没有会话文件就没有流式和同步路径）
  按启动失败处理。
- 一轮之外写入的消息（扩展命令的 `sendMessage`）不流式发布，命令结束后从文件发布，
  只有正式 id，不会短暂出现两次。
- `externalSessionId` 必须位于 `sessionsDir` 内，否则请求被拒绝，不会传给
  `pi --session`。AA 创建的会话 id 与文件路径的对应关系持久化在
  `pi/session-index/<会话 id>`，重启后无需扫描目录。
- inventory 用文件路径派生的 id 指代会话；状态和通知查询也按文件路径匹配运行中的
  会话，所以 AA 创建、正在运行的会话不会被扫描报告为 `idle`。通知始终使用该
  会话的平台 id。
- 超过 64 MiB 的会话文件不解析历史，但仍保留在 inventory 中，报告为
  `unavailable`（`history_too_large`），标题只从文件开头 1 MiB 读取。它不会被
  标为缺失，也不会同步时间线。

## 在 AA 中调整模型、思考等级与命令

- 模型目录中支持推理的模型带有思考等级（reasoning items），等级按 Pi 的
  `getSupportedThinkingLevels` 计算（`thinkingLevelMap` 中为 null 的等级不提供，
  `xhigh`/`max` 需显式映射）。选择 id 为 `<provider>:<model>#thinking=<level>`，下发时
  依次执行 `set_model`、`set_thinking_level`，并读回 Pi 收敛后的实际等级（不支持推理的
  模型为 `off`）；只选模型（`<provider>:<model>`）时保留会话当前等级，由 Pi 按模型
  收敛。正好等于某个目录模型 id 的值总是按模型处理。会话状态的 `selections.model`
  回报同样的组合 id，`selections.thinkingLevel` 仍单独给出。模型 id 本身含
  `#thinking=` 时（目录尚未加载，或另一个模型的 id 恰好等于"模型#thinking=等级"）
  选择 id 有歧义，不支持这种命名。
- 扩展可以调用 `pi.setModel` 切换模型，Pi 不发事件；每轮结束和扩展命令结束后，
  Connector 用 `get_state` 重新读取模型与等级。
- Pi 每次 `set_model`/`set_thinking_level` 都会写入会话文件，客户端发消息前也可能
  重复下发同一选择；没有变化的选择不再发送给 Pi，切换权限重启进程后也只补发
  真正不同的模型和等级。等级事件在主机 I/O 后排队处理，可能晚于读回结果；还有
  未处理的事件时，即使缓存中的等级相同也照常下发（Pi 只在等级变化时写入文件）。
- 有的客户端（Android）修改一项选择时，会把状态回显的全部选择一起发回。`model`
  中的等级与 `thinkingLevel` 不一致时，以与当前等级不同的那一个为准（即用户这次
  改动的那一项），先切模型再设等级。
- 模型目录和权限目录标出默认项（`default: true`）：默认模型和等级取自不带会话的
  utility 进程的 `get_state`，即新会话会使用的 Pi 配置，等级按模型用 Pi 的
  `clampThinkingLevel` 收敛；默认权限为运行时配置的 `permissionMode`。新建会话
  表单据此预选，而不是选目录中的第一个模型和最低等级 `off`。
- 没有运行进程的会话（空闲回收或 Connector 重启后），状态中的模型和等级按 Pi
  恢复会话的规则从文件当前分支读取：最后一次模型切换或助手消息的模型，最后一次
  等级切换。
- 会话命令来自 Pi 的 `get_commands`（扩展命令、提示模板、skill），都声明接受一个
  自由文本参数（`/命令 参数`，允许多行）。服务端命令 id 只接受
  `^[A-Za-z][A-Za-z0-9_-]*$`，而 Pi 的 skill 名为 `skill:<name>`：这类名字的命令 id
  把不合规字符换成 `-`（如 `skill-pdf`），标题仍是 Pi 的名字；执行时 Connector 把 id
  换回 Pi 的名字（`/skill:pdf 参数`）。换名后与已有 id 冲突的命令不列出。另提供内置的 `compact`，对应 Pi 的
  `compact` RPC，参数作为压缩说明；只能在会话空闲时执行，压缩结束后立即发布
  时间线中的压缩标记。
- 扩展命令的处理函数结束后 Pi 才响应这次 prompt，处理函数可能在等用户回答对话框。
  Connector 最多等 10 秒，之后按"已接受"返回（服务端命令和发消息的超时都是 30 秒），
  在后台继续等待。从发出起就算作进行中，期间会话不会被空闲回收或重开。命令结束后
  立即发布它写入的内容；之后才失败的命令或消息、自动压缩失败（`compaction_end`
  的 `errorMessage`）以会话通知（`type=notification`、`severity=error`）告知用户，
  下一次发送时关闭。
- 扩展命令的处理函数抛错时，Pi 仍把这次 prompt 当作已处理，只发出 `extension_error`
  事件（Pi 的终端界面会显示它）。Connector 把它同样作为会话通知（"/命令 失败：原因"；
  其他扩展事件出错显示扩展文件名）。打开的通知也随 `get_session_notices` 返回，
  之后打开会话的客户端同样能看到；通知按会话保存，空闲回收进程后仍然保留，
  Connector 重启后不保留。

## 有界历史同步

`connector/server/ingest_batching.py` 将增量 `timeline.sync` 按实际 UTF-8 JSON
字节数拆为不超过 8 MiB 的请求。保留 ID、顺序、metadata；所有批次接受后才
提交同步检查点。网络或 5xx 失败后从第一个未被接受的页继续，已接受的页不重发。
HTTP 200 中的 rejected 也视为失败。

**`complete=true` 是整份替换，不是“最后一页”。** 完整替换快照和单个不可拆分
条目不拆分、不截断，超过页大小时单独整份发送；本地不设上限，只有服务端返回
413 才算超限，这和拆分前的行为一致。被拒的通知只跳过它自己，同批其他通知
照常送达；轮询会话进入 30 分钟冷却，源变化或重启可重试。不虚假确认历史。
超过服务端上限的完整快照仍需要分阶段提交协议才能上传。

## 验证

```sh
cd connector
uv sync
uv run pytest -q
uv run python scripts/probe_pi.py
uv build --wheel
```

测试应使用空 HOME/agent/data 目录，避免读到现用配置。Pi 测试里的 fake Pi 是
POSIX 可执行脚本，完整套件在 Linux/WSL 执行。Git 属性确保其 shebang 使用 LF。
审批 TypeScript 测试可使用 Node 22+，相对资源路径兼容 Windows/WSL。

`probe_pi.py` 是空 agent 目录中的离线检查：读取版本/help，加载本包审批扩展，
发送 `get_state` 并回收子进程。不发送 prompt，不连接 AA Server，不读取真实
模型凭据，不产生模型调用费用。`--no-mcp` 仅在该版本 CLI/help 支持时添加；
旧版仍保留空目录、禁用扩展/工具/上下文文件及离线开关，不降低隔离要求。

本次证据：
- Linux Connector 全套：1199 passed、2 个 Darwin 专属路径测试 skipped。
- macOS 26.5.2 / arm64 全套：1201 passed，无失败、无跳过，包含 Darwin 路径用例。
- Windows 原生 registry/重连与实际审批 TypeScript：7 passed；新增探针参数兼容用例 2 passed。
- 三端当前 Pi 1.1.0 真实基础 RPC：成功，子进程已回收；Mac/Linux 各重复两轮。
  历史 0.87.1 记录保留，Linux 旧启动器的目录覆盖/Node 识别限制已更正。
  详见 [最新版本升级验证](../features/pi-and-bounded-ingest/pi-latest-upgrade-verification.md)。
- Linux 实机采用既有非 root Pi 运行用户与空目录；默认 registry 四种类型各一次。
  详见 [Linux 真实 Pi 验证](../features/pi-and-bounded-ingest/linux-real-pi-verification.md)。
- macOS wheel 构建与资源清单验证通过；Mac/Linux 实机临时验证目录均已清理。
- 过程中的失败与修复见 [Mac 验证记录](../features/pi-and-bounded-ingest/mac-verification.md)。
- Windows 本机真实联调：本地 AA Server（SQLite）+ 本分支 Connector + Pi 1.1.0 +
  真实模型调用 + Web 客户端（无头 Edge），逐项验证模型/等级/权限调整、审批、对话框、
  命令、附件、流式、中断、插话、压缩、空闲回收、外部会话、Connector 与服务端重启，
  见 [AA 真实联调记录](../features/pi-and-bounded-ingest/aa-e2e-verification.md)。
  macOS 26.5.2 / arm64 上按同样方式补跑，结果在同一记录中。
  正式桌面安装包、Android/iOS、PostgreSQL/Redis 部署未验证。

来源与 MIT 声明见
[`connector/runtimes/pi/UPSTREAM.md`](../../connector/connector/runtimes/pi/UPSTREAM.md)。
