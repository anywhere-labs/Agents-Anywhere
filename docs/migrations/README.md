# 迁移文档

这个目录包含运维侧和客户端侧的迁移指南。迁移指南只描述已经发布、或已经有代码支撑的行为变化。重构计划和目标架构文档仍然放在 `docs/runtime-protocol/` 和 `docs/api/` 下。

## 当前迁移文档集

- [main 到 v2](./main-to-v2/README.md)：说明如何把当前 `main` 部署模型，整体迁移到 v2 的 Server、Connector 和客户端契约。
- [事件恢复 v2](./event-recovery-v2.md)：说明持久化事件恢复契约。
- [旧存储 v2.3](./legacy-storage-v2_3.md)：记录 v2.3 历史阶段如何移除旧的 Server 存储。后续版本的变化由 main-to-v2 指南覆盖。

阅读时先从 main-to-v2 总览开始。里面的部署文档和验收文档是发布门槛；各组件文档说明代码和数据应该怎么改。
