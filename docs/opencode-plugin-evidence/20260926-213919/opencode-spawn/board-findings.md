# Connector 重复 spawn / 连接始终未完成 — 根因与修复

## 结论
- 重复 uv 树 = 插件自身的孤儿（同时并存），非 Desktop/自建。
- 连接始终不完成的根因**不是**"多 Connector 抢同一 connectorId"，而是机器级 OS 租约被 AA Desktop Connector 占用，我们的 conn_958d… 的 connector.start 必被 connector_already_running 拒绝 → 服务端永远 offline / runtime_types=0。

## 真机硬证据（2026-09-27 06:16）
- 23 个 uv 树，全部 ParentProcessId=9016(OpenCode)，CreationDate 05:53:32 / 05:58:06×2 / 05:58:19 / 06:03:23×2 / 06:06:58–06:08:19 一批；06:08:19 之后 8 分钟无新增（blocked 生效）。
- 每个树链 uv→anywhere-cli→python→python，命令行均 