# 更新日志

## 未发布

- 在 Codex、Claude Code 和 DSH 会话中可统一使用 `/plan`、`/plan <任务>` 与 `/plan off`；新建会话里的裸 `/plan` 只设置创建意图，不消耗空模型回合。（[723a442d](https://github.com/congwa/Agents-Anywhere/commit/723a442d)）
- Web、Desktop、Android 和 iOS 新增流式计划卡片、完整计划阅读器及「同意并执行／提交修改意见／暂不执行」审阅入口，支持复制与 Markdown 导出。（[723a442d](https://github.com/congwa/Agents-Anywhere/commit/723a442d)）
- 计划按不可变版本保存，设备离线仍可查阅；旧版本批准、重复执行和结果未知后的自动重发会被阻止，批准计划继续使用用户当前权限设置。（[723a442d](https://github.com/congwa/Agents-Anywhere/commit/723a442d)）
- 升级 Server 时执行数据库迁移 `v2_45`；启用统一 Plan 需使用配套的 Connector、客户端及 DSH Bridge，DSH 还需组合原生 Plan 插件。（[723a442d](https://github.com/congwa/Agents-Anywhere/commit/723a442d)）
