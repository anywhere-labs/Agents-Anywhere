# 跨侧契约 bug 修复报告：连接器探活 vs 插件桥握手（discovery-only）

角色：实现（原 implementer 宿主报 Agent not found，由本角色顶替）。范围：仅 opencode-plugin/**。
事实基线：head 92685cd0（两侧同一提交引入）；本机宿主 OpenCode PID 9016（未触碰），插件经 index.ts 指向 src。

## 1. 根因（file:line）
- 连接器探活：connector/connector/runtimes/opencode/discovery.py:358-404 