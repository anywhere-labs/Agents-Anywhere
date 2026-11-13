# 平台协议 1.1

在冻结的 1.0 上增加可发现的 Runtime 类型和 1.1 事件版本识别；工作区准备与异步创建另见 `contracts/runtime-workflows/1.1`。Web、Electron 的类型由此目录生成到 `v1_1`，仍可读取 1.0 事件。

生成：`PYTHONPATH=server server/.venv/bin/python server/scripts/export_protocol_schemas.py --version 1.1`。生成 1.0 时导出器会保留原有枚举和常量；此次检查确认其 JSON 产物字节不变。

## 模型请求重试提示

Claude CLI 的非终止 API 重试通过现有 `system` 时间线条目、`content.kind = notice` 传递，扩展元数据为：

- `code = model_request_retry`：客户端按此码本地化展示，不展示原始上游错误或地址。
- `state`：`retrying`、`completed`、`failed` 或 `interrupted`。
- `reason`：确认 HTTP 429 时为 `rate_limit`，其他暂时失败为 `unavailable`；上游错误被网关转换为 502 时不猜测原始原因。
- `attempt`：CLI 报告的当前重试次数；可选 `maxAttempts`、`retryInMs` 分别为 CLI 报告的最多重试次数和本次等待毫秒数，缺失时不编造。

一个回合使用同一条目 ID、固定排序与递增 revision 更新重试进度，回合结束时同一条目更新为对应终态。该提示不产生审批、不阻塞现有中断操作；客户端不把重试次数显示成完成百分比，等待时长是本次重试间隔，不是逐秒倒计时。旧客户端可显示条目的兜底文本。
