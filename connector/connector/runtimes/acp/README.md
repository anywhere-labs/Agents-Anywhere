# 通用 ACP Runtime

此目录是 Connector 的 ACP 适配层。`domain` 保存领域对象，`application` 编排准备、创建、交互、恢复与同步，`infrastructure/acp` 使用官方 Python SDK，`profiles` 注入 Agent 专属配置与行为。生产传输使用 stdio v1。

默认 PiProvider 保留 `runtimeType=pi`，托管安装并启动 `@openma/pi-acp` 发布包，使用隔离的模型网关配置及 AA 工具权限扩展。它覆盖通用 AcpProvider 的签名组件启动流程，直接运行上游发布包，不要求选择组件发行。

通用 AcpProvider 仍保留签名组件安装、激活和回退机制，正式发布源与信任公钥尚未配置。受控组件探针使用临时密钥，不属于生产信任。

当前执行链路、配置、能力边界与检查入口统一维护在 [ACP Runtime 与 Pi 当前实现](../../../../docs/runtime-protocol/acp-runtime-implementation.md)。
