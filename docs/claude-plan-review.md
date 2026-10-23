# 计划卡片与 Claude 审批

本页说明 Claude `ExitPlanMode` 的计划卡片和审批语义。Web、Desktop 展示计划、执行权限与修改意见；默认手动审批，自动权限以本机 Connector 创建、由 Server 转发的 notice 为准，不能用响应载荷升级为 bypass。

批准后更新 Claude 会话权限；提交修改意见时继续规划。普通工具审批保持原行为。卡片可展开阅读完整计划，不保存文件或引入编辑器依赖。Codex 原生计划、Markdown 文件编辑将在独立 PR 中提交；Android/iOS 仍使用现有通用交互卡片，没有新增专用计划界面。
