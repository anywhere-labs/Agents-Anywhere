# T81 评估验证记录

日期：2026-11-10（UTC）。本次只提交方案文档，测试在隔离的临时源码副本运行，不修改 Effi Cloud 或 AA 的业务代码。

## 基线与方法

- AA：`3b5a15d5`。
- Effi Cloud：`34e8ad2ac38be3baf4c065bde4a0579c7efb7b47`；从 main 取得源码，使用其 agentd 依赖（MeshCall vendor `0.4.0-dev.9334405`）。
- MeshCall：`93344059ada65735c6cc08fdf3247ea9fb808d6b`。
- 测试环境：Linux、Node `22.23.4`、Go `1.26.0`、tmux；创建独立临时状态目录，主要会话路径使用假 ACP Agent，不向真实模型发送对话。

## 本轮结果

| 检查 | 结果 | 覆盖范围 |
| --- | --- | --- |
| agentd TypeScript 编译 | 通过 | 最新 main 源码配合固定 vendor 依赖 |
| agentd 定向单元测试 | 32 通过，0 失败/跳过 | 同步合并/慢 watcher、密钥保存与权限、Router Token 重连、会话与审批/恢复、临时终端 |
| MeshCall Router 定向测试 | 9 通过 | 单实例 scope、吊销关闭连接/HTTP 调用、TTL 不踢活连接、换钥匙、拒绝/重连、hello、取消签发、仅转发密文调用 |
| agentd 隧道端到端 | 23 通过，0 失败/跳过，退出码 0 | 含父测试在内的 Node test 计数；实际 Router + 假控制面 + agentd 子进程，含密文中继抓帧、拒绝明文/错钥匙、多端终端、审批/插话/回退/分叉、会话重启、TTL/撤销/Router 重启 |
| 文档检查 | 通过 | 本地 Markdown 链接 40 个有效；`git diff --check` |

可复跑的定向命令（分别在固定基线的 `cloud/agentd`、`meshcall-router` 目录中）：

```bash
npm run build
node --test --test-concurrency=1 dist/test/unit/sync.test.js dist/test/unit/e2e-key.test.js dist/test/unit/router-link.test.js dist/test/unit/conversation.test.js dist/test/unit/terminals-mesh.test.js
go test ./internal/router -run 'Test(Tunnel|EndToEnd|KeyChange|ExpiredTunnel|IssuerGivingUp)' -count=1 -v
go build -o /tmp/t81-meshcall-router ./cmd/meshcall-router
```

端到端测试需在干净环境中运行，不能继承 Cloud 当前实例编号、控制面地址或模型认证变量。先准备独立临时家目录、构建 Router 和 node-pty 原生模块，再用 `env -i` 显式设置最小 PATH、临时 HOME/TMPDIR 和 `MESHCALL_ROUTER_BIN`，执行：

```bash
node --test --test-concurrency=1 dist/test/e2e/e2e.test.js dist/test/e2e/router-link.test.js
```

首轮依赖用 `--ignore-scripts` 安装，缺 node-pty 原生模块导致子进程退出；在临时副本执行 `npm rebuild node-pty` 后解决。第二轮 22/23 通过，dev 测试因继承当前设备编号被本地 Router 拒绝注册；清空环境后完整重跑得到上述 23/23。未为通过检查修改上游测试或业务源码。本次为文档评估，未运行 AA 全量测试。

## 仍未验证

- AAV3 本机配对、客户端设备证明、独立 pin、主动撤销和密钥恢复：尚未实现，本轮只有差距评估。
- Windows/macOS 守护进程安装、Windows 终端、系统休眠、Android/iOS 原生隧道与后台重连。
- 真实 Claude/Codex 模型调用、AA 原生 IPC/DSH/Pi 功能对齐，以及真实 OAuth 回调。
- 断电耐久性、超大历史和慢消费者容量上限、生产成本、可用性目标。
- 旧数据清理/账号注销、任何生产部署和线上抓包；Cloud 历史验证记录只作来源证据。

以上限制不妨碍形成复用评估，但必须在 T48 定稿及实施验收中继续处理。
