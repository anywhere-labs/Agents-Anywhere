# 通用 ACP Runtime

此目录是 Connector 的 ACP 适配层。`domain` 保存领域对象，`application` 编排准备、创建、交互、恢复与同步，`infrastructure/acp` 使用官方 Python SDK，`profiles` 注入 Agent 专属配置与行为。生产传输使用 stdio v1。

默认 PiProvider 保留 `runtimeType=pi`，优先复用本机 Pi 安装的 SDK、原生配置与认证，由 `@openma/pi-acp` 发布包及固定兼容层提供 ACP 入口；显式受管模式保留隔离模型网关。历史浏览通过独立只读索引完成，原会话继续需确认已退出 CLI，审批守卫在首次加载、重载与恢复时均先于用户事件处理器。PiProvider 直接实现 RuntimeProvider，使用通用 ACP 执行与同步服务。

运行环境由 npm 安装器管理。

当前执行链路、配置、能力边界与检查入口统一维护在 [ACP Runtime 与 Pi 当前实现](../../../../docs/runtime-protocol/acp-runtime-implementation.md)。
