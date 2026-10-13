# Pi Runtime 来源

本目录的 Pi RPC、会话投影、流式、附件和审批实现基于：

- 项目：<https://github.com/Seryta/pi-agents-anywhere>
- 基础提交：`9ec8eb089eb7e4564ed6efe0ebdbe0a5e1252710`
- 许可证：[MIT](LICENSE)，保留原作者声明。

在该基础上包含已验证的流式/工具输出、附件、权限审批、Windows npm shim
启动和工作线程版本探测/缓存修复。没有携带用户配置、会话或部署身份。

迁入 AA 的适配：

1. Python 包从 `pi_aa` 移为 `connector.runtimes.pi`。
2. 原生注册 `PiProvider`，使用标准 `anywhere-cli`，不带独立 CLI 或 `.pth` hook。
3. 通用 `on_backend_reconnect()` 生命周期替代外部 client monkeypatch。
4. 修正首次重报状态的时间哨兵：初值为 `None`，系统刚启动不足 60 秒时也
   必须执行第一次重报；之后保留 60 秒防抖。附有低 monotonic uptime 回归测试。
5. 审批 TypeScript 与许可证显式进入 wheel；测试使用本目录实际资源。
6. 导入格式和等价的 subprocess 输出捕获写法遵循宿主项目规则。

保留 `PI_AA_PERMISSION_MODE` 等既有环境变量及会话元数据键以兼容现有集成。
本模块不提供操作系统沙箱；外部扩展与模型账户仍属于本机 Pi 的信任边界。

当前验证范围与使用说明见仓库 `docs/runtime-protocol/pi.md`。
