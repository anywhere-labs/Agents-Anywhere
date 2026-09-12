# DSH Bridge Next 验证记录

## 陈旧 endpoint 的 pid 复用误判（2026-09-12）

Windows 实机报告「本机连接被占用，无法启动」。`<DSH_HOME>/agents-anywhere/bridge/endpoint.json` 残留了当天 15:03 首次启动写入的记录（`pid 7444`），该 pid 随后被系统复用为无关系统进程；`processExists()` 只执行 `process.kill(pid, 0)`，因此每次重试都在 `RuntimeServer.open` 抛 `Another DSH bridge owns this DSH_HOME endpoint`（`BRIDGE_IN_USE`），只有手工删除该文件后重启才恢复。删除后 18:45 重新发布端点，Connector 随后接入并完成 10 个会话的首次同步。

管理租约（由 endpoint 目录 realpath 推导的确定性回环端口）才是归属权威：活着的桥接会持有该端口，因此能进入 `open()` 就已证明本路径没有活着的桥接，文件里记录的 pid 不构成证据。现已移除该存活门并始终接管陈旧发布；`dispose()` 仍按 token 与 pid 匹配后才删除端点。

新增回归用例：以另一个存活但无关的进程 pid 伪造陈旧 endpoint，断言桥接仍能启动、端点被替换且可完成 RPC。该用例在未修改的 `b4133309` 上以与实机相同的错误失败，修复后通过。

插件全量 133 项、通过 112 项（含新增 1 项）；未修改的 main 为 132 项、通过 111 项，两边失败集合完全相同（21 项，均为 Windows 本地的 `ERR_INVALID_URL_SCHEME` 等既有环境问题，CI 在 ubuntu 上运行）。类型检查的三处错误（TS2344、两处 TS2717）在未修改的 `b4133309` 上同样复现，与本改动无关。

## 桥接日志页与实机定位（2026-09-08）

插件新增「手机连接 → 桥接日志」：固定读取本插件两份运行日志，最近 200 条，每两秒刷新，可暂停；不依赖 Connector 所有权、账号或安装检测成功。DSH 日志分类与文件均记录错误码、读取阶段、会话 ID 和去除异常正文后的堆栈，Python 同时记录插件发出的 `runtime.error`。

类型检查、构建、产物及真实 Client factory 的 DOM 交互检查通过；插件 94 项测试通过，Connector 相关 24 项通过。首次本地全量运行遇到一个临时管理端口占用，重跑 94 项通过。上一轮回退 CI 的 endpoint 等待超时已延长；后续远程状态单独核对。

用户重启后的真实日志显示：历史会话读取报 `SESSION_QUERY_PERSISTENCE_FAILED`，cause 在 DSH `SessionLogScanner.consumeEventLine`；插件首次 inventory 尚未完成就关闭事件连接，重连后在同一会话再次失败。日志页已在真实环境显示这些错误，故障修复与恢复验收另行记录。

## 单会话读取失败隔离（2026-09-08）

生产读取始终使用 `ctx.sessionQuery.readSession`。对实机日志指向的会话，用已安装 DSH 官方读取实现进行只读复核，确认原生序号校验在第 730 条事件记录预期 9044、实际 9041；不是插件自行解析 JSON 失败，也没有改写该原生文件。

插件现在将单个会话的读取错误记录为 `unavailable / read_failed`，继续其他会话的 inventory、快照和实时事件。已存在的 AA 历史保留，不用空或部分快照覆盖；显式刷新、重新扫描或新的原生事件允许重试。列表本身无法读取和传输/ACK 失败仍通过原有断连校准处理，不能伪装成成功同步。

类型、构建、发布产物及 Client factory DOM 检查通过；插件 **95 项通过**。新增官方持久化序号错误回归，覆盖初始 inventory、已同步会话后续读取失败、健康实时事件、原生文件不被修改及修复后的重试。完整 Python → 已认证 AA Server 探针也包含坏历史会话，确认 AA 新建、重复提交去重、两轮消息的生成中增量和最终结果到达后端，过程中保持同一桥接连接；后续 lost ACK 与重连校准继续通过。

用户重启后，15:36 的真实插件进程完成 51 个会话的首次同步；检查时 207 个批次均收到 Connector ACK，坏会话记录为读取失败，未导致同步流关闭。真实模型新回复和用户随后提出的页面现象继续单独确认。日志页提交 `87679039` 的 [Linux CI](https://github.com/anywhere-labs/Agents-Anywhere/actions/runs/34199519011) 三个任务全部通过；本节隔离修复的远程检查另行更新。

## 当前分支：恢复 DSH 图片与配置，保留读取隔离

2026-09-08，分支 `codex/dsh-features-with-sync-fix`。用户确认恢复图片及模型/effort/权限、Agent 模式配置。以回退前实现为基础恢复完整协议链，保留独立桥接日志、单会话读取失败隔离、Python 启动互斥和 ID 历史、Desktop 安装信息职责。配置状态读取复用已捕获的官方快照；后续读取失败也按会话处理。

本地完整插件检查 **105 项通过**，包括类型、构建、产物和真实 Client factory 的 DOM 检查；Connector DSH/生命周期 **85 项通过**；Server 相关及全部迁移 **175 项通过**，有一条 TestClient 弃用提示。图片端到端测试加入坏历史会话，继续覆盖真实 Python Connector、已认证 AA Server、图片发送与纯文本续聊、持久化回执和冷重启。测试使用受控模型适配器，不能替代真实模型及手机验收。

图片与配置恢复提交 `0d54cb3e` 的 [Linux CI](https://github.com/anywhere-labs/Agents-Anywhere/actions/runs/34201788031) 三个任务全部通过。后续 RPC 恢复和服务端能力修复的远程结果另行记录，不能用此 run 代替。

后续补齐通用 RPC 错误边界：取消及超时释放请求槽位，未知异常返回 `INTERNAL_ERROR`，过大请求/响应不关闭已鉴权连接。同步的读取、投影、回执和配置错误按会话隔离；超大条目撤销该快照，其他历史及实时事件继续。全局同步/交付失败只替换订阅，保留同一 RPC 连接；ACK 等待有上限，模型目录失败不关闭消息发送，启动占用失败解除后可在原 Server 对象重试。

用户随后提供会话能力三项均为 true，但第二条消息仍被拒绝的证据。服务端页面读取实时能力，操作入口读取持久化缓存，存在不同判断来源。现已共用实时读取逻辑；回归覆盖旧缓存拒绝/实时允许、旧缓存允许/实时拒绝、连续两条消息，以及能力读取超时后恢复。同样保留附件 MIME 元数据，避免从 Runtime 投影为 Session 能力时丢失限制。

本轮完整插件检查 **110 项通过**；Connector DSH/生命周期 **86 项通过**；Server 相关与迁移 **186 项通过**，会话能力及操作回归 **42 项通过、4 项跳过**。跳过项是已有的废弃通知持久化测试；Server 仍有一条 TestClient 弃用提示。完整 Python/AA Server 探针验证后端交付失败后的重新校准保留同一个桥接客户端。

用户在 16:19 重启 DSH 和 CLI 后确认 DSH 已可用；CLI 后续记录两次 PNG 下载。随后出现的后端 WebSocket `1012` 与 Server 的 `StatReload` 日志一致：修改 Server 测试文件触发开发服务器重启，Connector 随后自动重连。该现象来自开发启动器的热重载，不应作为 DSH 桥接故障处理。手机、Windows 和长期运行仍保留独立验收范围。

## 历史排查：回退 DSH 图片与配置扩展

2026-09-08，分支 `codex/dsh-before-images`。用户报告：CLI 已连接 AA，AA 发往 DSH 的 RPC 能产生效果，但 DSH session 没有自动同步、数据没有正确回传。因此按要求撤回 `742d09be` 的 DSH 图片与同期模型/effort/权限、模式配置实现，回到 `65ad5d9f` 的文本运行时。

`8535885b` 已提前将新配置模块调用加入 `sync.ts`，而旧 NativeRuntime 并没有这些模块；回退时也撤回这组依赖。保留 `1e923c9a` 的 Host 实时发布通道、测试传输取消修复、Python 启动互斥与 ID 历史，以及 Desktop 安装信息职责。通用客户端功能和 AA 新会话偏好没有回退。

实际回传验证包含：原生已保存 session 自动进入 AA；原生新会话首条用户消息触发导入；AA 发起创建和续聊后，模型保持运行时 AA 已收到部分文本；最终结果持久化；响应丢失与重连后恢复完整历史。使用官方 DSH AgentLoop、真实 Python 适配器和原有 AA ASGI app 的临时测试环境。保留流式结果验证，没有退回只检查 RPC 成功的测试。

本地检查：插件 92 项、Connector 81 项、Server 相关 76 项通过；插件类型检查、构建和产物检查通过。远程结果见 [回退分支的 CI](https://github.com/anywhere-labs/Agents-Anywhere/actions/workflows/dsh-bridge-next.yml?query=branch%3Acodex%2Fdsh-before-images)。本地未自动重启用户的 DSH、CLI 或开发服务，真实环境是否恢复仍需加载回退构建后确认。

当时的手动验收顺序：重新加载 DSH Host 和 CLI（已有配对用 `uv run anywhere-cli start`），确认原生 session 自动出现在 AA，再从 AA 新建/续聊，检查运行中增量及结束状态，最后检查断线重连。当时图片、AA 侧 DSH 模型/effort/权限切换暂停提供，现已恢复。

以下保留前两轮的历史检查记录；当前功能及检查范围以上面的恢复记录为准。

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
  tests/test_effective_capabilities.py \
  tests/test_database_migrations.py -q
uv run --frozen pytest tests/test_backend_mvp.py \
  -k 'capabilit or send_message or running_tool_item or patch_session_selections or steer or interrupt or runtime_command or interaction_respond' -q
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

## 图片与配置扩展的手动验收清单

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

## 单一 Runtime Control 协议（2026-09-08）

本地活跃分支为 `v2`。Server 和 Python Connector 移除了协议版本协商及
命名实例门禁，使用空参数发现 Provider；DSH 插件已重新构建并刷新内部
Connector 源码。插件界面和安装信息职责未随本次协议调整变更。

本地检查：插件 110 项及类型、构建、打包验证通过；Connector 164 项通过；
Server 234 项基础、实例与迁移检查，加 42 项会话能力操作检查通过，4 项既有
通知测试跳过。新增覆盖发现挂起/失败时继续处理命名 RPC、同连接重试、旧
连接结果隔离、并发响应对应正确请求及 `v2_33` 迁移保留数据。

Connector 全量检查有 720 项通过、1 项旧参数签名约束失败；随后新增的两项
发现恢复检查也通过。Server 扩展全量检查仍有 project/workdir 旧样例和模块
依赖约束失败。代表性失败已在修改前的 `5180078d` 上复现。本次没有将这些
既有失败改为跳过；上面的通过数字只代表所列验证范围。

当前 CI 的完整命令见 [工作流](../.github/workflows/dsh-bridge-next.yml)。本地
迁移测试使用临时 SQLite，实际运行仍要求 PostgreSQL。重启现有 `local-up.sh`
会自动应用 `v2_33`，然后需完全重启 DSH 以加载新的插件 Python 进程。本轮
未启动或重启真实服务，也未宣称已完成原环境的 409 实测验收。
