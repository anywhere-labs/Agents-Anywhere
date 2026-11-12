# Runtime 工作流 1.2

工作流响应中的 `state.catalog` 复用主协议的 `ProtocolModelCatalog`，模型和推理强度名称均使用 `displayName`。Server 在接收 Runtime 响应时校验目录，非法目录返回 `502 invalid_runtime_response`，不会保存或作为可选模型下发。Web 与 Desktop 的 `protocol:generate` / `protocol:check` 同时覆盖本目录的契约、校验和与生成类型。

在 `server/` 执行 `uv run python -m scripts.export_workflow_schemas --check` 可检查契约是否与 Server 模型一致；CI 会执行同一检查。更新模型后去掉 `--check` 重新生成契约，再在 Web 与 Desktop renderer 执行 `protocol:generate`。

在 1.1 基础上增加可选 `configuration: Record<string, string | boolean>`，为首条消息冻结 Agent 通用配置。未提供该字段时保持旧请求摘要；准备预留与正式创建必须使用同一配置。已有 1.1 产物保持不变。

响应允许 1.1、1.2；ACP 工作流使用 1.2。配置 revision 由准备结果中的 `catalogRevision` 一起约束，配置发生变化时拒绝消费旧准备。

生成：`cd server && PYTHONPATH=. uv run python scripts/export_workflow_schemas.py`。ACP 平台扩展由 Connector 的独立导出脚本生成。

创建请求也接受与普通新建会话相同的可选 `attachments` 内联附件列表（最多 10 个、合计 32 MiB），允许只发附件。未传或空列表保持原有请求摘要；Server 保存附件后向 Connector 传递稳定引用，重试不会改变同一附件的引用。
