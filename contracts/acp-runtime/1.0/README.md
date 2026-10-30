# ACP Runtime 平台扩展 1.0

ACP 协议只在 Connector 与 Agent 之间传输；本目录定义平台侧配置、表单回答和来源回放替换的形状。`schema.json` 中的各 `$defs` 独立使用。

- 配置是完整快照，布尔值不得转换成字符串；未知选项不执行；选项 ID 按 Agent 原样保存。
- 表单回答为 `{kind:"form",values:{...}}`；动作单独使用 accept、decline、cancel；空字符串与取消不同。
- 来源投影替换必须 complete=true；本 schema 的存在不代表 Server 已发布该能力，未实现原子替换前不得发送该事件。

契约导出及 SHA-256 清单使用 `connector/scripts/export-acp-contracts.py`。
