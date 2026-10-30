# 更新日志

## 未发布

- 在 Codex、Claude Code 和 DSH 会话中可统一使用 `/plan`、`/plan <任务>` 与 `/plan off`；新会话首条任务即可进入原生规划，裸 `/plan` 只设置创建意图，不消耗空模型回合。（[723a442d](https://github.com/congwa/Agents-Anywhere/commit/723a442d)、[7c5c63ff](https://github.com/congwa/Agents-Anywhere/commit/7c5c63ff)）
- Web、Desktop、Android 和 iOS 新增流式计划卡片，在输入区直接「同意并执行／提交修改意见／暂不执行」，不再弹出审批窗口；完整计划可随时打开、复制与导出 Markdown，Web 和 Desktop 支持与聊天并排阅读。（[723a442d](https://github.com/congwa/Agents-Anywhere/commit/723a442d)、[4124be5d](https://github.com/congwa/Agents-Anywhere/commit/4124be5d)）
- 计划按不可变版本保存，设备离线仍可查阅；旧版本批准、重复执行和结果未知后的自动重发会被阻止，批准计划继续使用用户当前权限设置。（[723a442d](https://github.com/congwa/Agents-Anywhere/commit/723a442d)）
- 升级 Server 时执行数据库迁移 `v2_45`；启用统一 Plan 需使用配套的 Connector、客户端及 DSH Bridge，DSH 还需组合原生 Plan 插件。（[723a442d](https://github.com/congwa/Agents-Anywhere/commit/723a442d)）
