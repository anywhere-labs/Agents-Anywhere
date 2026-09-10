# Runtime：发现、读取与实时同步

## 当前实现

2026-09-08：图片与配置功能已恢复；保留桥接日志和单会话历史读取失败隔离。读取继续使用官方 `ctx.sessionQuery`，不会直接解析、修复或改写原生日志。当前验证状态见 [验证记录](./VERIFICATION.md)。

插件 Host 独立挂载 `agentsAnywhereRuntime`，要求官方 `sessions`、`sessionQuery`、`workspaceRegistry` 服务就绪。官方 `sessionController` 服务存在时提供消息发送和配置；目录与附件能力按对应官方服务分别声明。是否登录、是否打开手机连接弹窗、是否发现 AA Desktop，都不会决定 runtime 端口是否启动。

```text
平台 → Connector RuntimeProtocol → Python DSH 适配器
  → 本机鉴权 JSON-RPC → 插件 host/dsh-runtime
  → DSH 官方 SessionQuery → 原生 Session / SessionPersistence
```

- `server.ts`：仅监听 `127.0.0.1`，随机端口和随机 token；负责鉴权、8 MiB 帧限制、独立取消及超时、连接与卸载清理。单请求失败返回结构化错误，不关闭已鉴权连接。
- `router.ts`：会话查询、当前状态、分页捕获、订阅、图片/文本请求与配置目录；纯读取不调用 Agent create/resume。
- `native.ts`、`visibility.ts`、`sync.ts`：官方事件与读写、侧栏过滤、初始校准及实时推送。
- `sessions/source.ts`：官方会话清单、明确的归档/不可见/缺失状态及即时可用性检查。
- `history.ts`、`tools.ts`：原始事件转换为统一 Timeline。Python 不解释 DSH 原始消息。
- `identity.ts`：沿用共享协议的会话 ID、Timeline ID 和内容哈希算法；握手传入 runtime instance 的 `sessionNamespace`，区分平台归属。

官方 API 与声明按 npm `0.1.2-rc.1` 验证。完整日志通过 `sessionQuery.readSession` 读取，不使用仅代表当前模型上下文的 `readSurface`。不创建新的会话内容数据库。

## 发现与添加

发现文件为 `$DSH_HOME/agents-anywhere/bridge/endpoint.json`，未设置环境变量时位于 `~/.dsh` 下。插件也支持绝对路径 `dshHome` 配置，此值会传给自己启动的 Connector；外部 Connector 使用相同的 `dshHome` 配置。

文件包含版本、回环地址、端口、进程 ID 和连接 token；在 POSIX 上以 `0600` 发布。进程级 OS 租约保护端点所有权与崩溃后的旧记录回收；卸载只删除自身的记录。另一实例不能覆盖仍有效的端点。

Connector 先验证发现文件、进程与回环地址，再执行限时鉴权和 `ping`。临时探测连接不会关闭现有连接。添加时沿用平台的单实例一键配置，启动读取 capability set，并独立尝试预热可用的模型/权限目录；目录失败不会中断其他运行时操作。

## 会话列表与详情

列表通过 `sessionQuery.listSessions()` 合并 live 和 persisted 会话，使用官方顺序，并按官方侧栏规则排除子代理、归档和非当前空会话。按页批量调用 `readTitleSnapshots`，标题读取失败时保留错误标记。详情与分页也校验可见性，不把 live 标记当作正在运行。

`session.getState` 返回 sourceState；归档时返回 blocked，不尝试加载 Agent。发送前再次检查来源。明确归档状态通过现有通知同步到 AA，AA 元数据操作不会修改 DSH。插件不推送 DSH 项目名称或分组，后端沿用 CWD 分类和末段命名。

状态读取不再无条件重列会话清单，也不再每次重放整份日志：只有从未观察过的会话 ID 才触发一次清单刷新；配置与最后轮次结果按日志身份缓存（live 会话取内存事件末尾 seq，持久化会话取官方 revision），日志没变时直接复用。空白可见性判定同样只对它读取时的那份日志有效，日志变化即失效。大日志（数万事件）的一次完整读取约需两秒，缓存把它限制为“日志变化后的第一次”。

未实现功能的空占位目录已移除；`sessions/` 承载实际使用的来源状态模块，其余文件按当前职责保留，后续有实现再拆分目录。

详情先取得官方校验过的完整 raw log，再执行纯转换。消息类型与处理如下：

| DSH 原始记录 | 统一 Timeline | 处理方式 |
|---|---|---|
| 真正用户的 `user/message` 文本 | `message`，role=user | 保留消息来源 |
| 插件注入的 user-role 消息 | 不输出 | 环境、技能等内部注入不进入 Timeline |
| assistant 文本 | `message / markdown` | 流式片段和最终消息使用相同 ID、顺序 |
| reasoning | `system / reasoning` | 与普通文本分开 |
| image | 附件引用及必要的占位 | AA 发送的图片通过持久化回执恢复平台附件 ID；原生图片保留原生引用，不伪造平台文件 ID |
| `tool-call`、`tool/call`、`tool/result` | 同一条 `tool` | 以 callId 合并输入、结果、错误与最终状态 |
| bash / pwsh | `tool / command` | 保留 command；没有事实依据时不猜退出码 |
| write / edit / str_replace_editor | `tool / file_change` 或通用工具 | 有合法原生 diff meta 时使用上下文片段，绝不读取当前磁盘拼历史 |
| web_search | `tool / web_search` | 保留查询和结果 |
| subagent / subagent_fork / send_message 等 | `tool / agent_call` | 保留动作和输入 |
| MCP | `tool / mcp` | 保留完整注册工具名 |
| ask_user_question / exit_plan_mode | `tool / input_request` | 历史只读，不发起新交互 |
| run_code 子调用 | 独立 `tool` | 保留 rootCallId、parentItemId |
| approval/asked、approval/decided | 同一条 `tool / permission` | 合并审批历史，不重新弹审批框 |
| turn/start、turn/end | 状态/结束通知 | 投影内用于归并，后端不保存轮次标记 |
| compaction | `marker / compact` | 原始历史保留，不以压缩后上下文覆盖聊天记录 |
| 其他内部信息事件 | 不输出 | 不生成兜底 notice |

请求配置、系统提示词和模型 replayState 不输出到时间线。损坏或不兼容的原生日志由官方读取层拒绝，再转成稳定错误；不会伪装成空历史。

读取、投影、图片回执和配置状态异常按会话隔离；快照不能完成时撤销该捕获，保留 AA 已接收的历史。全局清单或交付失败只替换同步订阅，Connector 延迟后重新订阅；普通 RPC 继续使用同一连接。会话刷新、后续原生事件和新的清单均可触发重试，不需要重启进程来清除错误。

主动读取的历史按同一捕获分页，每帧最多 1,000 条且内容小于 7 MiB；单条超限明确失败。游标绑定连接、会话和捕获，120 秒后过期。Python 收齐所有页才返回完整快照；指定 limit 截断时 complete=false。事件订阅的初始历史每页最多 250 条，收齐后通过现有 timeline.sync 完整替换；随后只推增量，断线重连重新校准，不再定时扫描 DSH。详见 [事件同步方案](./RUNTIME_SYNC_PLAN.md)。

## 验证与本地试用

```bash
cd dsh-bridge-next
corepack yarn check
cd ../connector
uv run pytest tests/test_dsh_contracts.py tests/test_dsh_provider.py tests/test_dsh_bridge_client.py -q
```

测试在临时目录组装官方 Session、JSONL、SessionQuery 与编译后的插件，再运行真实 Python Provider/Runtime；覆盖空闲会话、持久化会话、1,005 条跨页历史、内容哈希、鉴权、探测共存、依赖服务卸载/恢复和端点清理。无需 GUI 或模型密钥。

链接安装的插件完成构建后，手动重启 DSH Host 以加载新后端；正在运行的旧 Connector 也需要重新启动以加载新的 Python 适配器。在 Web 设备页面或 onboarding 点击 DeepSeek Harness 的“一键配置”，然后查看该设备已有的 DSH 会话与历史。

纯文本新建/续聊、实时消息、工具状态与中断已接入官方 Agent 服务。`ask_user_question` 已接入平台现有问答表单，包含回答、取消、多端收起和断线恢复，见 [用户问答](./USER_QUESTIONS.md)。下一阶段处理附件、模型/权限目录和权限审批。Windows 实机、长时间运行及真实模型界面验收仍需手动进行。
