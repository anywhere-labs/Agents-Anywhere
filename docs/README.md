# Agents Anywhere v2 文档

从使用、部署或开发的入口开始。当前稳定产品线是 2.0；API namespace 为 `/api/v2`，数据库修订号独立演进。

| 目标 | 文档 |
| --- | --- |
| 安装客户端、登录、连接设备 | [安装与首次使用](getting-started.md) |
| 查看 2.0.0 安装包和发布边界 | [2.0.0 发布说明](releases/2.0.0.md) |
| 部署自己的服务 | [Docker](../docker/README.md)、[Server](../server/README.md) |
| 升级已有部署或从 v1 迁移 | [升级指南](upgrading.md) |
| 源码运行与 headless 验证 | [开发指南](development.md) |
| Desktop 开发、打包、签名 | [Desktop Workbench](../desktop-workbench/README.md) |
| 接入无图形界面的机器 | [Connector](../connector/README.md) |
| Android 构建 | [Android](../android/README.md) |
| 架构和 API | [Server 架构](server-architecture.md)、[API](api/README.md) |
| Runtime 和本机协议 | [Runtime protocol](runtime-protocol/README.md)、[本机协议](../contracts/local-machine/2.0/README.md) |

`docs/migrations/main-to-v2/` 保留早期迁移设计与历史基线。其旧版本号、移动端完成度和 Redis 策略不能替代当前升级指南。带 proposal、plan、target、gap 的文档描述设计或特定时间点的差距，使用前应与源码和契约核对。
