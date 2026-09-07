# DSH 用户问答

已接入 DSH `0.1.2-rc.1` 的 `ask_user_question`。只转换 DSH 的问题和答案，沿用平台既有 `inputRequest` v1、notice、接管权限和回应接口。后端、平台 RuntimeProtocol、Web、Desktop、Android、iOS 均不需要改动。

## 流程与分工

1. 官方工具调用 `ctx.userQuestions.ask()`，Agent 暂停等待。插件在 Host 内订阅官方 Typert Gateway 的 `$events`，接收 `user-questions/request`。它是普通事件消费者，不覆盖官方问答服务或替换官方 UI 的回答者。
2. 插件过滤不可见会话和 `plan-review` 等不支持的意图。普通问答转换为平台 `interactionType: input_request` 的 notice。等待状态使用现有 `waiting_approval`。
3. DSH Connector 通过已有 `RuntimeHost.notice_upsert()` 发布问题，前端复用原来的问答组件。没有接管时仍遵守平台只读规则。
4. 平台原有 `/sessions/{sessionId}/runtime/notices/{noticeId}/respond` 调用 `interaction.respond`。Python 仅转发到插件 `session.respondInteraction`，所有原生解释、校验和等待管理都在插件。
5. 插件检查会话归属、问题是否仍等待、答案完整性，再使用官方 Connection 的公开进程内 Fetch carrier 向 Gateway `$events/result` 回答。这个 Fetch 不访问网络。官方工具收到答案后产生普通工具结果，Agent 继续执行，结果沿已有 Timeline 流同步。

`question-stream.ts` 负责官方事件流及回应；`question-form.ts` 负责现有表单格式和答案校验；`questions.ts` 负责待回答状态和 notice。Python 的 `runtime.py` 和 `bridge/sync.py` 只做转发。

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

权限审批和 `exit_plan_mode` 本轮不接入，仍交给 DSH 原生界面。`session.interaction.approval` 是平台已有的通用交互门控能力，本次仅用它开放问答提交，不意味着已实现工具权限审批。

## 验证与试用

```sh
cd dsh-bridge-next
corepack yarn check
cd ../connector
uv run pytest tests/test_dsh_provider.py tests/test_dsh_contracts.py tests/test_dsh_bridge_client.py tests/test_dsh_event_sync.py -q
```

自动验证使用真实官方 Agent、工具、UserQuestions、Gateway、Connection 和编译后的插件，仅模型适配器为固定输出。覆盖完整回答、输入校验、取消、中断、多端回答、消费者重载及 Connector 重连。跨语言探针使用临时 SQLite 和现有后端 ASGI 路由，验证 notice、接管权限、作答与恢复输出。不会启动开发服务器或调用付费模型。

链接安装后构建插件，手动重启 DSH Host 和正在运行的 Python Connector。在平台接管一个 DSH 会话，要求它调用 `ask_user_question` 询问单选、多选和自填问题，即可测试。历史里旧的问答记录只展示为工具历史，不重新弹出表单。
