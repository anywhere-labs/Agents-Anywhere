# 旧存储移除 (`v2_3`)

历史说明：`v2_3` 是一个中间 schema，在这个阶段 notices 成为了持久化 Interaction 存储。当前的 `v2_7` schema 已经移除了持久化 runtime notices，并把它们视为 runtime 拥有的实时事实。完整部署迁移请看 [main 到 v2](./main-to-v2/README.md)。

Schema revision `v2_3` 会让 `notices` 成为唯一的持久化 Interaction 存储。Connector 的 approval prompt 现在以 `notice.upsert` interaction 的形式进入 Server；`approval.requested` 会被拒绝。反向响应通道是 runtime 协议里的 `interaction.respond` Connector RPC，不是持久化契约。

## 升级行为

在 `approvals` 表被移除之前，每一行 Approval 都会被转换为稳定的 Approval Interaction notice，或与其合并。迁移会把 Connector 请求身份保存在 `context.approvalSource` 下，包括 `requestId`，所以部署后 pending interaction 仍然可以被处理。

然后迁移会移除：

- `approvals` 表；
- 已归档的 v1 catalog/settings 表；
- `connectors.runtime_capabilities`；
- `sessions.runtime_settings_override`。

必要的 v1 源值已经由 `v2_2` 归档到 `legacy_import_archive`。这个归档仍然是持久化数据。移动端兼容响应里可能仍然包含 `approvals` 字段，但它是从打开状态的 Approval Interaction notices 投影出来的，不再单独存储。

启动 Server 前，先运行正常的显式迁移命令：

```bash
uv run python -m agent_server.infra.db.migrations upgrade
```

这里故意不支持 downgrade，因为 downgrade 会重新创建已经被替代的事实来源。
