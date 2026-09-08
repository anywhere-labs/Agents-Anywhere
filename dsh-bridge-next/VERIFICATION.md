# DSH Bridge Next 验证记录

## 当前分支：回退 DSH 图片与配置扩展

2026-09-08，分支 `codex/dsh-before-images`。用户报告：CLI 已连接 AA，AA 发往 DSH 的 RPC 能产生效果，但 DSH session 没有自动同步、数据没有正确回传。因此按要求撤回 `742d09be` 的 DSH 图片与同期模型/effort/权限、模式配置实现，回到 `65ad5d9f` 的文本运行时。

`8535885b` 已提前将新配置模块调用加入 `sync.ts`，而旧 NativeRuntime 并没有这些模块；回退时也撤回这组依赖。保留 `1e923c9a` 的 Host 实时发布通道、测试传输取消修复、Python 启动互斥与 ID 历史，以及 Desktop 安装信息职责。通用客户端功能和 AA 新会话偏好没有回退。

实际回传验证包含：原生已保存 session 自动进入 AA；原生新会话首条用户消息触发导入；AA 发起创建和续聊后，模型保持运行时 AA 已收到部分文本；最终结果持久化；响应丢失与重连后恢复完整历史。使用官方 DSH AgentLoop、真实 Python 适配器和原有 AA ASGI app 的临时测试环境。保留流式结果验证，没有退回只检查 RPC 成功的测试。

本地检查：插件 92 项、Connector 81 项、Server 相关 76 项通过；插件类型检查、构建和产物检查通过。远程结果见 [回退分支的 CI](https://github.com/anywhere-labs/Agents-Anywhere/actions/workflows/dsh-bridge-next.yml?query=branch%3Acodex%2Fdsh-before-images)。本地未自动重启用户的 DSH、CLI 或开发服务，真实环境是否恢复仍需加载回退构建后确认。

当前手动验收顺序：重新加载 DSH Host 和 CLI（已有配对用 `uv run anywhere-cli start`），确认原生 session 自动出现在 AA，再从 AA 新建/续聊，检查运行中增量及结束状态，最后检查断线重连。图片、AA 侧 DSH 模型/effort/权限切换暂不在当前功能范围内。

以下保留前两轮的历史检查记录，不代表回退后仍提供图片与配置扩展。

## 历史基线：图片与配置扩展

日期：2026-09-08。基线：`feat/benson-0905` 的 `5c99b42d`，官方 DSH `0.1.2-rc.1`，macOS、Node 22.23.2、uv 0.12.3、Python 3.12。

## 已执行的自动化检查

| 范围 | 结果 | 附加检查 |
| --- | --- | --- |
| 插件 | 105 项通过 | Host/Client/脚本类型、构建、官方 UI headless 导入与生命周期、Connector 源码打包 |
| Connector | 68 项通过 | DSH、Runtime 归属、控制进程与测试传输取消 |
| Server | 76 项通过 | 图片 MIME、会话锁、设备/Runtime 删除、配置、插件 OAuth、设备存储 |
| Web | 219 项通过 | TypeScript、协议生成一致性 |
| Desktop renderer | 205 项通过 | TypeScript、协议生成一致性 |
| Desktop 主进程 | 90 项通过 | TypeScript 编译后运行 Node 测试，未启动 Electron |

合计 763 项测试。Server 测试有一条 Starlette/httpx TestClient 弃用提示，不影响本次结果。此记录是上述提交的验证快照；后续职责调整需要重新检查，不能沿用本表宣称新代码已经通过。

插件事件与问答探针通过 ASGI 调用原有 Server，在各自的临时目录创建 SQLite 数据库；正常启动 Server 仍要求 PostgreSQL。测试请求一旦进入后端，不随客户端取消而被直接取消，测试关闭时等待后端请求完成。生产数据库和连接池没有因本轮测试修复而修改。

## Python Connector 职责调整

分支：`codex/connector-owned-lifecycle`。`cf058b32` 建立 Python RPC 占用检查；`70a60905` 完成入口适配与职责收敛：Python 检查实际 Connector PID、写启动来源和 ID 历史，Desktop 只写安装信息，插件只读共享文件。安装信息的校验和发布没有移入 Python。

后续本地检查：插件 102 项、Connector 84 项、Desktop 主进程 85 项通过，包含插件类型/构建/打包与主进程 TypeScript。原先测试 Host 自持启动锁、写 ID 的用例已替换为真实 Python CLI/RPC 进程竞争和入口错误处理，所以测试数量不直接对应旧基线。

覆盖 CLI、Desktop、插件互相拒绝；冲突返回 `-32009` 后 RPC 查询和重试仍可用；进程异常退出后允许新启动；无关 PID 不形成占用；ID 顺序去重；Desktop 写安装信息不覆盖 Python 的运行记录和历史；插件检测不写文件；失败保留私有绑定且重试不重复注册。`connector.stop` 停止后端连接后，仍存活的 RPC 进程继续占用。

首次 Linux CI [34192099034](https://github.com/anywhere-labs/Agents-Anywhere/actions/runs/34192099034) 针对 `7c841c2e`：Web/Desktop 通过，插件/Python 任务失败，原因是旧共享写锁测试竞争和 SQLite 测试迁移使用 `ALTER COLUMN`。前者已由 Python 进程测试替代；后者改用 Alembic batch 迁移，并检查迁移后 `runtime_id` 非空及原数据保留。Server 的 76 项相关测试加完整迁移测试，共 175 项本地通过，仍有一条 TestClient 弃用提示。生产运行继续要求 PostgreSQL。

当前分支的 Linux CI 将上述新范围纳入检查，同时重新检查 Web 219 项和 Desktop renderer 205 项。远程结论以 [该分支的工作流记录](https://github.com/anywhere-labs/Agents-Anywhere/actions/workflows/dsh-bridge-next.yml?query=branch%3Acodex%2Fconnector-owned-lifecycle)为准；本地通过不代表远程已经通过。

## 复现命令

先在仓库根目录准备 `uv sync --project connector` 和 `uv sync --project server`，并在三个 JavaScript 项目各执行一次 `corepack yarn install`。仓库忽略依赖锁文件，干净环境安装时生成自己的本地锁；CI 明确关闭 immutable install。

在 `dsh-bridge-next/`：

```bash
corepack yarn check
```

在 `connector/`：

```bash
uv run --frozen pytest tests/test_dsh*.py tests/test_runtime_owner.py tests/test_connector_control.py tests/test_connector_ownership_rpc.py -q
```

在 `server/`：

```bash
uv run --frozen pytest \
  tests/test_attachment_mime_policy.py tests/test_session_refresh_lock.py \
  tests/test_connector_deletion.py tests/test_runtime_deletion.py \
  tests/test_runtime_config.py tests/test_plugin_onboarding.py \
  tests/test_device_data_storage.py tests/test_device_runtime_repository.py \
  tests/test_database_migrations.py -q
```

在 `web-next/`：

```bash
corepack yarn test
corepack yarn typecheck
corepack yarn protocol:check
```

在 `desktop-workbench/`：

```bash
corepack yarn workspace agents-anywhere-desktop-renderer test
corepack yarn renderer:typecheck
corepack yarn workspace agents-anywhere-desktop-renderer protocol:check
corepack yarn test:main
```

[DSH Bridge Next CI](../.github/workflows/dsh-bridge-next.yml) 在 Linux 上运行这些检查，不启动真实 DSH、开发服务器、Docker 或 Electron。GitHub 中的对应 run 才是远程检查结果，不能用本地通过代替。

## 图片与配置扩展的历史验收清单

启动方法见 [README](./README.md#本地构建与安装)。由开发者手动启动当前源码版本的 Server/Web 和链接安装的 DSH 插件；扫码前确认手机能访问连接中使用的服务器地址。只监听回环地址或二维码仍含 `127.0.0.1` 时，先跳过手机步骤。

- [ ] 插件登录、自建服务授权、设备上线、添加 DSH Agent、Web 完成页可达。
- [ ] AA 选择模型 A / effort，与 DSH 默认模型 B 不同时，首条真实请求使用 AA 的选择。
- [ ] 会话内改模型/effort/权限后回显正确；下一次新建仍恢复 AA 已保存的新会话偏好。
- [ ] 修改 Runtime 默认模式只影响后续新建；原会话和正在执行的 turn 保持原生行为。
- [ ] 文本和纯图片新建/续聊、运行中中断、`ask_user_question` 回答/取消、多端收起可用。
- [ ] 断线与重启恢复后，历史、图片引用、当前选择及待回答问题一致，无重复首条消息。
- [ ] 手机扫码与真实手机会话交互通过；Windows 进程退出/恢复和长期运行另行记录。
- [ ] 使用当前源码依次从 CLI、Desktop、插件启动，验证其他入口显示冲突；结束占用方 Connector 进程后重试成功，设备 ID 不重复登记。
- [ ] Desktop 发布实际安装信息后，插件重新检测；仅检测不改写共享文件。Windows 实机另验 PID 身份检查与进程退出。

普通文件、DSH 原生图片反向上传到 AA、工具权限审批应答，以及检测到 AA Desktop 后的专门交接流程仍未开放。权限预设切换不等于回答工具审批。完整配置验收矩阵见 [配置方案第 11 节](./RUNTIME_CONFIGURATION_PLAN.md#11-验收条件与容易遗漏的逻辑)。
