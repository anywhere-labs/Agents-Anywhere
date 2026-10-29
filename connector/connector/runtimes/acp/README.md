# 通用 ACP Runtime

此目录是 Connector 的 ACP 适配层。`domain` 保存领域对象，`application` 编排准备、创建、交互、恢复与同步，`infrastructure/acp` 使用官方 Python SDK，`profiles` 注入 Agent 专属配置与行为。生产传输使用 stdio v1。

默认 PiProvider 保留 `runtimeType=pi`，托管安装并启动 `@openma/pi-acp` 发布包，使用隔离的模型网关配置及 AA 工具权限扩展。PiProvider 直接实现 RuntimeProvider，使用通用 ACP 执行与同步服务。

运行环境由 npm 安装器管理。

当前执行链路、配置、能力边界与检查入口统一维护在 [ACP Runtime 与 Pi 当前实现](../../../../docs/runtime-protocol/acp-runtime-implementation.md)。
