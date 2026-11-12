# 通用 ACP Runtime

此目录是 Connector 的 ACP 适配层。`domain` 保存领域对象，`application` 编排准备、创建、交互、恢复与同步，`infrastructure/acp` 使用官方 Python SDK，`profiles` 注入 Agent 专属配置与行为。生产传输使用 stdio v1。

默认 PiProvider 保留 `runtimeType=pi`，优先复用本机 Pi 安装的 SDK、原生配置与认证，由 `@openma/pi-acp` 发布包及固定兼容层提供 ACP 入口；显式受管模式保留隔离模型网关。历史浏览通过独立只读索引完成，原会话继续需确认已退出 CLI，审批守卫在首次加载、重载与恢复时均先于用户事件处理器。PiProvider 与 HermesProvider 都是通用 `AcpAgentProvider` 的薄封装。

运行环境由 npm 安装器管理。HermesProvider 使用 `runtimeType=hermes`，启动本机的 `hermes acp`，配置和认证都来自 Hermes 自身。

每个 Agent 由 Agent 定义（`domain/agents.py`）、方言（`domain/dialect.py`）和公共引擎组成，`provider.py` 把定义装配成 RuntimeProvider。新增 Agent 时在 `profiles/<agent>/definition.py` 写定义和方言，并在 `providers.py` 注册。

当前执行链路、配置、能力边界与检查入口统一维护在 [ACP Runtime 与 Pi 当前实现](../../../../docs/runtime-protocol/acp-runtime-implementation.md)。
