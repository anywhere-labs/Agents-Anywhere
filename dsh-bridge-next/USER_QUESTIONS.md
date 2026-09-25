# DSH 用户问答

已接入 DSH 的 `ask_user_question`、计划审阅和权限审批。沿用平台既有 `inputRequest` v1、notice、接管权限和回应接口，由各端已有的问答／审批组件显示。

## 流程与分工

1. 官方工具调用 `ctx.userQuestions.ask()`，Agent 暂停等待。插件在 Host 内订阅官方 Typert Gateway 的 `$events`，接收 `user-questions/request`。它是普通事件消费者，不覆盖官方问答服务或替换官方 UI 的回答者。
2. 插件过滤不可见会话；普通问答和 `plan-review` 转换为平台 `interactionType: input_request` 的 notice。权限请求转换为 `interactionType: approval`。等待状态使用现有 `waiting_approval`。
3. DSH Connector 通过已有 `RuntimeHost.notice_upsert()` 发布问题，前端复用原来的问答组件。没有接管时仍遵守平台只读规则。
4. 平台原有 `/sessions/{sessionId}/runtime/notices/{noticeId}/respond` 调用 `interaction.respond`。Python 仅转发到插件 `session.respondInteraction`，所有原生解释、校验和等待管理都在插件。
5. 插件检查会话归属、问题是否仍等待、答案完整性，再使用官方 Connection 的公开进程内 Fetch carrier 向 Gateway `$events/result` 回答。这个 Fetch 不访问网络。官方工具收到答案后产生普通工具结果，Agent 继续执行，结果沿已有 Timeline 流同步。

`interaction-stream.ts` 负责两类交互共用的官方事件流及回应；`question-form.ts` 负责现有表单格式和答案校验；`questions.ts` 和 `approvals.ts` 负责待回答状态和 notice。Python 的 `runtime.py` 和 `bridge/sync.py` 只做转发。

事件流适配已验证的两种公开签名：DSH `0.1.5-rc.2` 的 `(endpoint, payload, signal)`，以及 `0.1.7-rc.2` 的 `(endpoint, payload, uplink, peer, signal)`。新版使用空上行流和官方进程内 operator 身份。按函数声明参数数量选择签名，不在失败后猜测其他参数重试。未知签名保持不可用，并写入 `interaction.stream_failed` 诊断；同一次故障仅记录一次，恢复后记录 `interaction.stream_recovered`，不记录问题或答案正文。

## 既有表单规则

| DSH | 平台 | 回答时 |
|---|---|---|
| `id`、`question`、`header` | 原 ID、`prompt`、`header` | 保留问题 ID |
| `options[].label/description` | `options[].id/label/description` | 按内部 `o_0` 等 ID 还原原始 label |
| `multiSelect`（工具入参为 `multi_select`） | `multiple` | 单选最多一个；多选可选多个 |
| 自由输入 | `allowCustom: true`、`customText` | 转为 DSH `custom` |
| 回答集合 | `{answers: {[questionId]: {optionIds, customText?}}}` | 转为 DSH `{answers: [{id, selected, custom?}]}` |

每个问题都必须回答。单选可以选一个选项或填写自定义答案，二者不能同时提交；多选可以同时提交选项和自填内容。不支持逐题跳过。缺失答案、重复/未知选项及错误类型会被拒绝，问题保留等待，供用户修正。

“取消”取消整组问答，向官方 Gateway 提交 `UserQuestionError / ASK_CANCELLED`；不是伪造一条普通用户消息，也不是自动选择默认选项。后续 Agent 如何处理工具取消遵循官方行为。

## 多端、断线与恢复

- 官方 Gateway 的 `eventId` 是一次问答的身份；notice ID 由平台会话 ID 和此 ID 确定。正在等待的问题在连接恢复时由官方重放，沿用原 ID。
- 官方 Gateway 仲裁多端回答，先到者生效，其他端收到 `cancel` 控制帧并撤掉表单。该控制帧也可能代表原生中断，故插件把它展示为已关闭，不猜测究竟是回答还是取消。
- 插件自身拒绝同一问题的重复提交、跨会话提交；已处理的问题不会再次调用原生工具。RPC 确认是官方回应通道的确认，不额外承诺平台侧的 exactly-once 语义。
- Connector 断线不会取消 DSH 问题。重连的首次同步包含当前问答，`session.getNotices` 也能恢复表单。
- 插件问答消费者重载时释放旧订阅，不发送取消。官方仍在等待的请求会重放给新消费者；整个 DSH Host 重启后，已经不存在的进程内等待不会从历史日志伪造恢复。
- Gateway 暂不可用时问题保留，回应明确失败，可重新连接重试。原生轮次结束会清理仍未回答的旧问题。保留最多 128 个已关闭记录，用于前端当前状态核对，不写新数据库。
- 问答/能力通知复用既有平台发布方法；只有插件与 Python 之间的私有批次白名单增加这两个已有通知名，平台协议及后端接口不变。Timeline 仍遵守已有 30 Hz 缓冲、顺序与 ACK。

## 请求类型覆盖

| 原生请求 | AA 适配 |
|---|---|
| `user-questions/request` 普通问题 | 单选、多选、自由输入、选项说明，复用 `inputRequest` 表单 |
| `user-questions/request` 的 `plan-review` 意图 | 完整计划正文、批准选项、修改意见和整组取消，复用同一表单 |
| `approval/request` | 复用通用审批卡片，允许一次或拒绝，不修改持久权限策略 |

当前核对的 DSH Remote allowlist 中，需要回答的 waterfall 事件就是上述问答和审批两类。`exit_plan_mode` 的计划审阅沿用问答意图；其他设置、登录、插件和命令等 emit 事件不属于这两类可作答交互。本适配不把它们伪装成审批请求。未知事件或不支持的意图交回原生客户端。`session.interaction.approval` 是平台已有的通用交互门控能力，同时控制问答和审批提交。

## 验证与试用

```sh
cd dsh-bridge-next
corepack yarn check
# 可选：用另一套已安装的 DSH 依赖验证真实 Gateway（该目录需有 package.json 和依赖）
DSH_INTERACTION_RUNTIME_ROOT=/path/to/dsh-package corepack yarn tsx --test tests/integration/interaction-gateway.test.ts
cd ../connector
uv run pytest tests/test_dsh_provider.py tests/test_dsh_contracts.py tests/test_dsh_bridge_client.py tests/test_dsh_event_sync.py -q
```

自动验证使用真实官方 Agent、工具、UserQuestions、Gateway、Connection 和编译后的插件，仅模型适配器为固定输出。覆盖完整回答、输入校验、取消、中断、多端回答、消费者重载及 Connector 重连。跨语言探针使用临时 SQLite 和现有后端 ASGI 路由，验证 notice、接管权限、作答与恢复输出。不会启动开发服务器或调用付费模型。

链接安装后构建插件，手动重启 DSH Host 和正在运行的 Python Connector。在平台接管一个 DSH 会话，要求它调用 `ask_user_question` 询问单选、多选和自填问题，即可测试。历史里旧的问答记录只展示为工具历史，不重新弹出表单。
