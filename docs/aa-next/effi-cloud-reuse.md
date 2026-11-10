# Effi Cloud 直接复用与 AA 本机场景差异（T48）

依据：用户要求很大程度直接参考 Effi Cloud；D3 已确定 TS-only，D4 已确定独立本机信任。方案不是在 AA 重建一个 Cloud，而是给现有 agentd/客户端增加本机宿主和信任适配。目标与待批政策见[主方案](architecture-proposal.md)，历史评估见 [T81](meshcall-daemon-evaluation.md)。

本轮源码核对固定在 Effi Cloud [`46221a4ac213176673073ecfacc009e8c0621dd2`](https://github.com/anywhere-labs/effi-evo/commit/46221a4ac213176673073ecfacc009e8c0621dd2)。T81 运行验证固定在 `34e8ad2`，不能把测试成绩自动算到新基线；真正抽取共享代码时固定同一 release 并重跑两种宿主测试。源码链接需要对应仓库权限。

## 直接以 Cloud 实现为底座

表中「直接复用」指保留业务模型/行为和实现，不代表可以跳过授权入口检查、安全评审、发布许可或版本固定。

| Cloud 实现与源码入口（固定基线） | AA 直接沿用 | AA 必要增量 |
| --- | --- | --- |
| [ACP 与会话内核](https://github.com/anywhere-labs/effi-evo/tree/46221a4ac213176673073ecfacc009e8c0621dd2/cloud/agentd/src/conv) | manager、conversation、agent-pool/process、parts 映射、排队/插话、权限先答先得、回退/分叉和恢复 | 以本机认证主体替代 Router principal，补 AA 既有 Runtime/工作流差异；不另写状态机 |
| [同步队列](https://github.com/anywhere-labs/effi-evo/blob/46221a4ac213176673073ecfacc009e8c0621dd2/cloud/agentd/src/conv/sync.ts) | 首快照、item 整条替换、control 整体推、333 ms 合帧、每 watcher 合并 | 授权视图隔离、重置旧分页/迟到任务和慢 watcher 硬上限；不加全局 rev/epoch/CRDT |
| [本地持久化](https://github.com/anywhere-labs/effi-evo/blob/46221a4ac213176673073ecfacc009e8c0621dd2/cloud/agentd/src/conv/conversation.ts)与[目录管理](https://github.com/anywhere-labs/effi-evo/blob/46221a4ac213176673073ecfacc009e8c0621dd2/cloud/agentd/src/conv/manager.ts) | 会话 JSON、原有目录/类型、临时文件 rename、幂等表与重启恢复 | 注入本机 stateDir；关键写入失败/确认边界、同步落盘与故障测试；默认不迁 SQLite |
| [附件管理](https://github.com/anywhere-labs/effi-evo/blob/46221a4ac213176673073ecfacc009e8c0621dd2/cloud/agentd/src/conv/attachments.ts) | 本地 attachment_path、上传后引用、发送拷贝、删除/回退/分叉清理、大小限制 | 路径与授权检查；在 E2EE Instance 上传/下载内传输，禁止改回 AA Server transfers |
| [MeshCall 接入](https://github.com/anywhere-labs/effi-evo/blob/46221a4ac213176673073ecfacc009e8c0621dd2/cloud/agentd/src/mesh.ts)及[加密](https://github.com/anywhere-labs/effi-evo/blob/46221a4ac213176673073ecfacc009e8c0621dd2/cloud/agentd/src/e2e.ts) | 注册/重新取 token/指数退避/targeted 服务、MeshCall Noise E2EE，不另造传输或密码算法 | 本机强制 E2EE、独立 pin、客户端持钥认证、逐操作授权；坏钥匙禁止静默自动换钥匙恢复信任 |
| [服务封装](https://github.com/anywhere-labs/effi-evo/tree/46221a4ac213176673073ecfacc009e8c0621dd2/cloud/agentd/src/services)与[接口约定](https://github.com/anywhere-labs/effi-evo/blob/46221a4ac213176673073ecfacc009e8c0621dd2/docs/cloud/CONTRACTS.md) | Conversations/Terminals/Instance/Workbench/Agents 的已有 DTO、方法及代码生成 | 从 Cloud 部署命名抽出公共边界；新增配对/授权/删除契约，不为改名重写业务方法；2.x 兼容差异单列 |
| [Unix 终端](https://github.com/anywhere-labs/effi-evo/blob/46221a4ac213176673073ecfacc009e8c0621dd2/cloud/agentd/src/terminals/tmux.ts) | tmux 持久会话、node-pty attach、多端回滚、输出合批/背压 | 本机显式授权和 OS 安装；Windows 适配 ConPTY，不能假定 tmux 可用；机器重启不保证旧进程还在 |
| [Web 隧道/生成客户端](https://github.com/anywhere-labs/effi-evo/tree/46221a4ac213176673073ecfacc009e8c0621dd2/cloud/web/src/mesh) | typed client、隧道状态和重连经验、契约生成工具 | 移除自动从 issuer 更新信任 key，接入本地 pin/设备认证；Android/iOS 共用协议与向量，原生 SDK 另验证 |
| [MCP 与工作台工具](https://github.com/anywhere-labs/effi-evo/tree/46221a4ac213176673073ecfacc009e8c0621dd2/cloud/agentd/src/mcp) | 复用终端/工作台/对话工具语义及调用现有服务的方式 | Effi/数字员工用独立配对身份和最小 scope，禁止把云团队成员默认映射成主机执行权 |

Cloud 的同一 Agent 多会话共享 ACP 进程、快照及幂等语义继续使用；资源隔离和进程故障恢复按已有方式补测试，不能因 AA 本机迁移就新增一套并行引擎。AA 既有功能先映射到 ACP 标准及上游适配器；已支持能力直接复用，上游升级经兼容验证后跟进。DSH/Pi、Codex 原生 IPC、Plan/Goal 等差异逐项记录，优先采用上游支持/扩展，只为必要缺口增加薄的 TS 桥接；功能取舍由负责人决定，不能以兼容为由重建整套自定义 Agent 协议。

## 只替换宿主边界

`main.ts/config.ts` 变成 Cloud 容器与 AA 用户级服务两种入口，共用服务和内核。AA 注入 stateDir/home、日志、凭据/身份、授权、Runtime 启动、终端后端与生命周期；本机 UI 经 OS 保护 IPC 调同一业务服务，不经过账号或 Router 才能使用本机。

Cloud 的 `home.ts`、容器 PID 1/VS Code supervisor、cgroup/proc 路径、容器宽权限、控制面模型环境变量和新增加的 IDE 模型 relay 是部署特定策略。AA 不自动 chown 用户目录，不覆盖已有模型配置，不关闭工作区信任，不启动无认证 IDE/明文 HTTP 网关。模型 relay 即使存在于 Cloud，也不能自动纳入 E2EE 的保护承诺。

控制面签发和网关代码只复用发现/票据/撤销的接口经验；不搬 Docker 生命周期，也不要求 AA 控制面改 Go。Cloud 已做到「业务在实例」，AA 沿用此归属，删除 2.x 云端 Timeline/附件镜像，而不是把现有 Server 存储改成另一种同步数据库。 本机入口必须在控制面/Router 不可达或远程租约到期后仍可使用，不能把 Cloud 的云登录依赖带入 AA 本机启动路径。依据 M72，云端验收首先量化 CPU/内存及所需实例规格的大幅下降，转发流量是次级成本指标；复用时不能把 Cloud 的业务快照/内容处理重新搬进 AA 控制面。

## 真正新增的工作边界

1. **本机独立信任**：D4 所要求的首次本机同意、双方 pin/客户端身份、加密握手绑定、授权/撤销/恢复；Cloud 现有控制面公钥分发与 principal 不满足这部分。
2. **跨平台本地宿主**：用户级服务、OS IPC/密钥库、双启动互斥、睡眠/升级、Windows 终端、本地离线入口。
3. **ACP 优先与四端适配**：现有功能先核对 ACP/上游能力覆盖，复用标准与实现；必要差异明确记录，在同一契约上接入 Desktop/Web/Android/iOS。
4. **#266 完整闭环**：云字段白名单、日志/通知/模型路径约束、自助删除/注销，以及旧库/附件/Redis/备份清理和防复活切换。

先在 Effi Cloud 共享边界内验证这些改动，不为了复用把 AA 强行引入 Cloud 容器安全假设。当前只定方案，不复制业务代码、不执行迁移；私有源码分发与依赖许可仍须在抽取前确认。

复用也要服务于设备资源效率：检查 Cloud 的历史扫描、定时刷新、后台轮询和缓存生命周期，按订阅/可见性启停与合并，优先采用已有事件/watch。记录客户端、agentd、适配器合计内存和空闲 CPU、后台唤醒及耗电，保留必要的安全检查与恢复机制。更低内存和更少额外耗电同样是性能收益，不要求每一项收益都表现为操作更快。
