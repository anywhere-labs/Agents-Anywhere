# ACP 录制回放

真实 Agent 的 ACP 交互录制，在不安装 Agent 的情况下回放，检查方言与事件翻译（`test/runtime/recording-replay.test.ts`）。
格式与 v2 `connector/tests/fixtures/acp-recordings` 相同：每行 `{direction, message}`，`outgoing` 是 AA 发给 Agent，`incoming` 是 Agent 发给 AA。

| 文件 | Agent | 场景 | 来源 |
| --- | --- | --- | --- |
| `hermes-allow.jsonl` | Hermes（`git.42456cf`） | 允许一次写入审批，Agent 写文件后回复 | 复制自 v2 |
