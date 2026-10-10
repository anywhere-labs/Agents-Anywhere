# macOS SSH 隔离验证

## 环境与范围

- 源码分支：`codex/sync-fix-pi-runtime`，基线 `7df5b31f`。
- 实机：macOS 26.5.2，Apple Silicon / arm64。
- 隔离测试 Python：3.12.15；既有 Node：22.19.0；既有 Pi：0.87.1。
- 通过已保存的可信 SSH 主机密钥校验后连接；仅本次连接覆盖地址，未修改
  SSH 配置、关闭主机校验、修改代理/全局路由或升级 Mac 的 Pi。
- 源码复制到独立临时目录；工具、Python、venv、缓存及日志均在该目录中。
  415 个源码文件与本地快照逐一校验。没有复制 `.git`、凭据、用户历史或模型配置。
- 测试使用空 HOME、agent 和数据目录；不运行 AA Server、不启动第二个
  Connector，不发送真实模型 prompt，不修改或重启现用服务。

## 最终结果

| 检查 | 结果 |
|---|---|
| Connector 完整 pytest | **1201 passed，0 failed，0 skipped，1 warning** |
| Darwin 路径身份用例 | 两项均实际执行并通过，不再以平台原因跳过 |
| Pi 0.87.1 离线 RPC | `get_state` 成功，子进程已回收 |
| Pi CLI/help 与审批资源 | 必需选项存在，审批资源文件存在 |
| Wheel 构建 | 成功 |
| Wheel 内容 | Pi provider/runtime、approval.ts、MIT LICENSE、有界 ingest、Codex/Claude sessions 包齐全 |
| 分发安全 | 无自动 `.pth`，无 auth/models/connector 等私有配置文件 |
| Linux 回归 | **1199 passed，2 个 Darwin 专属用例 skipped，1 warning** |
| Windows 回归 | 新增探针兼容用例 2 passed；Pi 1.1.0 离线 RPC 仍成功 |

实际审批 TypeScript 的合成矩阵属于测试套件；离线 RPC smoke 不等于真实模型
会话中的审批/流式/附件闭环已验证。此次没有进行正式桌面包安装或 UI 验收。

## 验证过程中的问题与处理

1. 默认包源下载大型 SDK 超过首轮 600 秒准备限时。当时尚未运行测试。
   保留该记录后，按仓库配置切换依赖镜像，复用隔离目录续装成功。未修改
   全局包源；这次准备失败不作为代码测试失败或通过计数。
2. 第一份上传包过度过滤了名称为 `sessions` 的源码包，导致 44 个收集错误。
   修正为按源码清单上传，并对 Codex/Claude sessions 模块增加完整性检查。
   没有上传用户会话，也没有用忽略模块/测试来绕过错误。
3. 完整源码首次测试 1199 项通过，但 Pi smoke 退出：旧版 Pi 0.87.1 不认识
   `--no-mcp`。本机安装的公开 CLI/help 和发行代码确认：`--offline` 与
   `PI_OFFLINE` 可用，其余隔离开关也可用。
4. 新增 `test_pi_probe_compatibility.py`，模拟旧/新 CLI，旧 CLI 用例先出现
   行为性红测。探针现在仅在 help 支持时添加 `--no-mcp`；继续保留空 HOME/
   agent、`--no-extensions`、`--no-tools`、`--no-context-files`、`--offline`
   与 `PI_OFFLINE=1`。没有关闭隔离措施，也没有升级目标 Pi。
5. 修复后重跑 Mac 全套与真实离线 RPC，得到上表最终结果；Windows 1.1.0
   probe 和 Linux 全套回归同步通过。

## 变更与回滚边界

本次额外源码改动仅为 `connector/scripts/probe_pi.py` 的可选参数兼容，以及
相应合成回归测试/文档。没有改 Pi Runtime 默认权限或服务端协议。

Mac 验证目录仅包含本次生成的代码、工具与测试产物。通过后清理该独立目录，
不删除 Mac 的既有项目、模型配置、历史或服务数据。脱敏的通过结果已留档；
不把原始远端日志、地址、账号、密钥或临时目录真实路径提交到仓库。

验证完成时尚未 commit、push 或部署；后续按用户指示创建本地提交，不推送远端。
回滚只涉及本次源码变更，不涉及现用 Connector 或用户数据。Mac 首次状态重报修复与大历史同步补丁仍不能证明
此前 Windows 进程停滞的未知原因已经被完全消除。
