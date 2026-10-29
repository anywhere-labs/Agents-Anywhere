# Runtime 协议与实现

本目录的当前 ACP/Pi 说明以工作树源码为依据。通用 Runtime 接口以 Connector 的 Python 定义和 `contracts/` 为准；早期重构设计中的示例签名与迁移步骤不再作为现行契约。

## 当前实现入口

| 内容 | 文档或源码 |
| --- | --- |
| ACP 适配、默认 Pi 启动、权限与能力边界 | [ACP Runtime 与 Pi 当前实现](acp-runtime-implementation.md) |
| Connector 开发和运行 | [Connector README](../../connector/README.md) |
| Provider、实例生命周期与 Runtime 调用 | [provider.py](../../connector/connector/runtime_protocol/provider.py)、[supervisor.py](../../connector/connector/runtime_protocol/supervisor.py)、[protocol.py](../../connector/connector/runtime_protocol/protocol.py) |
| Runtime → Connector 回调 | [host.py](../../connector/connector/runtime_protocol/host.py) |
| 会话、状态、能力与 Timeline 类型 | [models.py](../../connector/connector/runtime_protocol/models.py)、[timeline.py](../../connector/connector/runtime_protocol/timeline.py) |
| 工作区准备与异步创建 | [工作流类型](../../connector/connector/runtime_protocol/workflows.py)、[公共契约](../../contracts/runtime-workflows/1.2/manifest.json) |
| API、有效能力与实时同步 | [API 索引](../api/README.md)、[能力](../api/capabilities.md)、[实时 API](../api/realtime.md) |
| Timeline 工具身份与多来源同步 | [身份说明](timeline-identity.md) |

默认 Runtime 为 Codex、Claude、DSH、Pi。Pi 的 Provider 身份为 `pi`，通过通用 ACP 适配启动托管安装的 `@openma/pi-acp`；通用签名组件机制独立于默认 Pi 执行路径。

## 早期重构参考

以下文件保留了通用 Runtime 重构的设计与迁移背景，其中的 draft、target、实施记录及验证结果属于相应阶段。查阅行为或接口时应先查看上面的当前定义。

- 接口设计：[Connector → Runtime](connector-to-runtime.md)、[Runtime → Connector](runtime-host-client.md)。
- 结构与行为设计：[Connector 结构](connector-structure.md)、[Server API / 数据库](server-api-db.md)、[Web 行为](web-behavior.md)、[行为迁移](behavior-migration-targets.md)。
- 重构记录：[Runtime 实例](runtime-instances-v2-rewrite.md)、[Codex 重构目标](codex-runtime-refactor-target.md)。
- 执行计划：[迁移顺序](migration-sequence.md)、[实施顺序](implementation-order.md)、[执行依赖](execution-dependencies.md)。

旧独立 Pi Runtime 的接入计划、客户端计划和阶段实现记录，以及 ACP 的重复实施约定、组合记录和上游钩子调查已删除；有效内容合并到当前 ACP/Pi 说明。
