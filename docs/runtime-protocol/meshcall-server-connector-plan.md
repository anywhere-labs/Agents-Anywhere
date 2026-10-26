# Server ↔ Connector MeshCall 创建链路

## 基线与范围

2026-10-26：分支 `feat/be+con+dsh/meshcall-workspace-create`，当前工作目录
`/Users/wang/code/jxx/Agents-Anywhere`，已 rebase 到 upstream/main `59145c1a`。
前置 `e1a62d3b` 与本次 MeshCall 实现整理为一个提交；前置内容尚未合入主线，不能将其开发版本当作发布基线。
按用户明确要求，所有端产品版本使用 2.1.0；未经用户明确要求不主动调整版本号。MeshCall 依赖仍为 0.3.0，契约与数据库 revision 独立编号。
原有 `web-next/AGENTS.md` 和 `docs/runtime-protocol/reliable-operations-plan.md` 本地改动单独保留，不纳入功能提交。
已授权原样移植前置 tests/ 改动，并仅调整本次协议所涉及的已有断言与 fixture；不新增测试目录或用例。

## 实施顺序

1. 固定 runtime-operations/1.0 契约和来源绑定。
2. Server 父进程监督一个回环 Router，所有 worker 共用；统一各启动入口。
3. bootstrap、WSS 代理、限时凭据、撤销、连接代次隔离与指定实例。
4. Server 持久调度、Connector 独立执行、DSH 本机操作回执。
5. 四端继续使用项目操作接口；内部状态映射 pending，成功与同步分开。
6. 静态检查、现有检查、临时目录功能探针及可用的真实 Runtime 验收。

## 范围与回滚

首期 workspace.create；原生 Codex/Claude 协议、终端、文件、Timeline 不迁移。
单 Server 部署多 worker，不提供 Router 集群。Router 由 AA 启动、监督与停止。
兼容策略与 DSH 既有迁移一致：新创建不回退旧 RPC，相关组件配套升级。
回滚先停止派发并保存回执，不把未核对操作交给旧执行器重做。

## 验收记录

实施中；源码、headless、故障注入、真实 Runtime/设备结果分别记录，不以模拟替代真实验收。

## 完成记录（2026-10-26）

- 已建立隔离 worktree 和分支，原工作树未提交改动保留。前置移植记录见上文。
- 已实现共享 Router 父进程监督、同源 WebSocket 入口、15 分钟限时凭据、提前
  60 秒换新、撤销检查、设备/连接代次服务隔离与指定实例调用；设备只可注册自身服务和调用自身 ping。
- 新创建只走 MeshCall；Server 原子保存请求并后台领取，Connector 持久接收后独立执行。
  身份及参数冲突、Runtime 配置代次、256 队列上限、4 Runtime 并发与同 Runtime 串行均已接入。
- 增加执行前准入，避免重启时 Runtime 尚未激活就把未执行任务标为未知；接受记录待就绪后续执行。
- DSH 增加 Operations 服务、命名空间隔离的 JSON 回执、结果确认；旧创建方法委托同一执行器。
  原生结果可能已产生但未落盘的间隙保留 unknown，不按目录/名称猜测成功。
- Server v2_46 迁移保留历史操作，兼容接管 metadata.create_all 已有结构；各端沿用产品版本 2.1.0，相关组件须配套更新。
- 用户追加授权仅调整已有契约断言和 fixture：Connector/DSH 权限清单、Server schema
  断言与既有项目创建 fixture；没有新增测试目录或用例。

### 原实现自动检查（rebase 前）

| 检查 | 结果 |
| --- | --- |
| Server 全量 pytest | 976 passed，14 skipped；跳过项均为仓库原有的已移除持久 notices 行为 |
| Server 后续专项（项目、迁移、多 worker、架构与契约） | 138 passed |
| Connector 全量 pytest | 1250 passed；已有 Codex serializer warning |
| DSH `yarn check` | 类型、构建、产物检查通过；206 passed |
| Web | 414 passed；typecheck、protocol:check 通过 |
| Desktop | main 142 passed、1 skipped；main/renderer typecheck、renderer protocol:check 通过 |
| Android | JDK 17，`:app:compileDebugKotlin` 通过 |
| iOS | 未编译：本机只有 Command Line Tools，没有完整 Xcode |
| 新增实现 Ruff、shell 语法、Python 编译、diff 空白检查 | 通过；仓库全量 Ruff 仍有既有历史问题 |

### 直接功能与故障注入

- 真实 Router：类型化 submit/get/ackResult、并发去重、参数冲突、错误来源拒绝、
  指定实例投递和设备横向调用限制。
- 实际双 worker Server + PostgreSQL + Redis：两个账号/设备正确投递；跨用户创建、
  查询、确认拒绝；设备越权注册、横向调用、凭据撤销后旧连接拒绝。
- 一个 QA 对象贯通 HTTP → Server → 共享 Router → Connector JSON 执行器 → 本机 Router
  → Python DSH 适配器 → 发布 Host / 官方 WorkspaceRegistry → WorkspaceSyncRunner / HTTP ingest
  → Server 项目投影 → 用户确认 → DSH 持久 ACK。
- 上述链路中 SIGKILL 共享 Router，并模拟 Server 未保存最终结果；自动重启和重新 bootstrap
  后恢复同一原生 ID，实际 Registry.create 调用计数仍为 1。
- 官方 DSH Registry / JSON 存储验证创建、并发去重、冲突、命名空间隔离、ACK 和 Host 重建恢复。
- Codex 0.163.0：使用配置的隔离原生存储，实际 project/create、project/list，并在 app-server
  重启后重复同一请求返回相同原生 ID；未调用模型。该观察不升级为所有 Codex 版本的永久幂等保证，
  实现仍保守处理原生执行中的未知结果。
- Connector 回执探针：持久 accepted 重启续执行、Runtime 延迟激活、running 转 unknown、
  等待方断开后完成、损坏存储拒绝、队列及并发上限；不以这些探针替代上述真实 Registry 链路。

### 验收边界与证据

DSH 使用真实官方 SDK 服务、Registry 和存储，以独立 Context 运行发布 Host；没有安装版 DSH
Desktop UI、浏览器或模型提供商参与。远程 Supervisor/配置发现使用受控 QA 宿主，实际创建、
跨语言 MeshCall、清单采集、HTTP ingest 与数据库投影均为真实实现。网络探针使用本机 HTTP/WS；
公网 TLS 终止与反向代理 WSS 未验收。Android 未安装到真机，四端交互未做 UI 验收；iOS 编译受环境限制。

本次未推送、未创建 PR、未部署生产，也未构建 Linux 发布制品。原实现的完整验证日志保存在
`/Users/wang/code/jxx/Agents-Anywhere-meshcall-operations/.local-dev/qa-meshcall/logs/`。共享 Router 和专用 QA Redis 在验收后停止，临时原生存储已清理；
专用 QA PostgreSQL 数据库保留便于复核。

## 主线同步与版本纠正（2026-10-26）

- 以本轮 `git fetch upstream main` 得到的 `59145c1a` 为基线，一次 rebase 重放前置及 MeshCall 改动，无冲突；最终整理为一个功能提交。已包含主线 #431、#432、#433。
- 产品版本全端使用 2.1.0，Android versionCode 恢复主线值 10；移除本分支新增的 2.2.0 / 2.3.0 发布说明，将内容合并至 2.1.0。数据库 v2_45 / v2_46 和 MeshCall 0.3.0 不随产品版本回退。
- Connector 现有专项检查：113 passed（MeshCall host、Runtime control、Codex binary、日志、契约与架构）。
- Server：仅运行无数据库的架构与协议检查，使用 `--noconftest`，27 passed；未连接数据库，未重新运行完整 Server 集成或故障注入。
- Web / Desktop renderer / DSH 类型检查通过；Web / Desktop renderer 协议一致性检查通过。
- 版本直接核对通过；87 个变更 Python 文件语法、变更 JSON 解析、启动脚本 shell 语法及 Git 空白检查通过。
- 本轮未重新进行 Android/iOS 编译、真实 Runtime 或四端真机验收；前述原实现的运行证据保留历史范围。未推送、创建 PR 或部署。

## Android 真机发现项修复（2026-10-26）

- 新建项目编辑区整体滚动，目录列表使用有界高度；历史待确认操作较多或路径较长时，仍能访问 Agent 和目录选择，底部提交按钮固定保留。
- Android 保留现有操作响应的 `syncState`，将“已创建并同步，待确认”和“已创建，等待同步”分开展示；未修改 Server 契约。
- 创建与恢复共用项目选择逻辑，同时绑定设备、项目和 Runtime 实例并保存选择；清单刷新优先使用项目所属实例，创建编辑期间不套用旧项目的 Agent。
- 小米 2304FPN6DC / Android 16 真机：三条长路径历史操作可滚动访问 Agent、目录；已同步状态显示正确；从 DSH 选择创建 Codex 项目、恢复 Codex 操作后均正确选中 Codex。原生 Codex 项目和持久操作回执已核对，未发送模型会话。
- Debug 构建及 58 项现有单元测试通过；完整 Android lint 仍被未改动的 `AgentMarkdownText.kt:162` 中 `RememberReturnType` 错误阻塞。未修改测试、产品版本或其他端代码；版本保持 2.1.0 / Android versionCode 10。
- 本地截图、APK 哈希、检查日志和回执位于忽略目录 `.local-dev/qa-meshcall-ui-20261026/`。本次修复不包含全链路日志补齐，亦未进行推送或发布。
