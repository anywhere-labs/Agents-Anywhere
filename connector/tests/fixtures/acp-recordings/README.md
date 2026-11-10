# ACP 录制样本

真实 Agent 的 ACP 交互录制，用于在不安装 Agent 的情况下回放、检查方言和 Timeline 投影（`tests/test_acp_dialect_replay.py`）。

- 每行一条 JSON-RPC 消息：`direction` 为 `outgoing`（AA 发给 Agent）或 `incoming`（Agent 发给 AA）。
- 录制时由 `scripts/verify-acp-agent.py --record <目录>` 生成，本机路径已替换为 `<root>`、`<bin>`、`<home>`。
- Agent 升级或接入方式变化时，重新录制并检查测试。

| 文件 | Agent | 场景 |
| --- | --- | --- |
| `hermes-allow.jsonl` | Hermes（`git.42456cf`） | 允许一次写入审批，Agent 写文件后回复 |
