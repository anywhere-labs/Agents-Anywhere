# 统一 ACP 接入方案（提案）

- 状态：阶段 1–4 已实施（未发布）；阶段 5 待接入下一个 Agent
- 日期：2026-11-09
- 范围：以 Connector 为主；统一错误码一项涉及 `contracts/` 和四端（见第 9 节）

本文是设计记录。当前行为以 [ACP Runtime 当前实现](acp-runtime-implementation.md) 和源码为准。

## 实施记录

与方案相比，实施时做了以下调整：

- 定义字段按实际需要收敛：启动前检查用 `check`、`version`，没有实现 `min_version`；可选目录用 `settings`（实例配置键 → 环境变量）；没有单独的 `authentication`、`model_discovery` 字段，模型目录始终来自会话配置项。
- 安装、补丁、后台准备和原生历史统一由 `prepare_launch` 与 `runtime` 两个钩子承担，没有单独的 `history` 字段。Pi 的后台准备与原生历史运行时原样保留，由 `runtime` 钩子装配。
- 方言实际钩子：`capabilities`、`supports_steer`、`adapt_configuration`、`translate_update`、`acceptance_evidence`、`interaction`、`before_prompt`、`verify_session`、`prepare_resume`、`configure`、`extension`、`classify_error`，以及属性 `steer`、`guarantees`、`echoes_user_prompt`。`extension_notification` 没有实现，目前没有 Agent 需要。
- 图片输入能力检查（读取模型配置项的 `_meta.aa.modelInputModalities`）对所有 Agent 生效，不再是 Pi 专用。ACP 的 `thought_level` 统一归为推理强度。
- 错误事实只包含稳定错误码和文案，没有加入发生阶段和能否重试，以免改动工作流失败结构。
- 2.2.0 尚未打 tag，各端版本号都是 2.2.0，因此统一错误码并入 2.2.0 的接口变化，没有再升 MINOR。
- 待决问题 3 已定：回放样本为 JSONL，每行一条带方向的 JSON-RPC 消息，本机路径替换为占位符，存放在 `connector/tests/fixtures/acp-recordings/`。

## 1. 背景

Connector 的通用 ACP 层（`connector/connector/runtimes/acp/`）目前有两个 profile：

| Profile | 接入方式 | 代码量 |
| --- | --- | --- |
| Pi（`profiles/pi/`） | 第三方 `@openma/pi-acp` 加 AA 补丁、npm 安装、审批守卫、原生历史 | 约 2900 行 |
| Hermes（`profiles/hermes/`，[#591](https://github.com/anywhere-labs/Agents-Anywhere/pull/591)） | 启动本机自带的 `hermes acp` | 约 430 行 |

接入 Hermes 时发现两类问题：

1. **同一段通用行为在两个 profile 里各写了一遍**：把用户消息写进 Timeline、确认「消息已被接纳」。
2. **只实现标准 ACP 的 Agent 不能直接接入**：通用层缺了上面这段逻辑，也不会自动声明命令、附件等能力，接新 Agent 仍要写一个完整的 Client 子类。

各家 Agent 的差异又不可能都用纯数据描述：运行中追加没有 ACP 标准方法，错误识别、配置项归类、私有通知的含义都要靠代码解释。

## 2. 目标与非目标

**目标**

- 标准 ACP Agent 只需要一份 Agent 定义即可接入：对话、审批、表单、模型与推理强度、附件、中断、恢复。
- 各家差异集中在可选的方言钩子里，公共引擎不再为某个 Agent 改动。
- 执行状态、事件身份、历史重放和「消息已接纳」只由公共引擎决定。
- 客户端只消费统一的 Timeline 条目和错误事实，不理解任何 Agent 的原始通知。

**非目标**

- 不允许经 Server 下发或修改启动命令、参数和环境变量（第 4 节）。
- 不注册用户自定义的新 Agent；可用 Agent 由随 Connector 发布的注册表决定。
- 不处理 ACP v1 没有定义的持久接纳回执。

## 3. 现状盘点

### 3.1 通用层已经能直接处理的

| 功能 | ACP 方法 | 说明 |
| --- | --- | --- |
| 握手与版本检查 | `initialize` | 只启用 v1 |
| 新建会话、发消息、中断 | `session/new`、`session/prompt`、`session/cancel` | 消息用稳定的 `clientMessageId` 去重 |
| 流式输出 | `session/update` | 消息、思考、工具调用投影为 Timeline |
| 审批 | `session/request_permission` | Agent 提供的选项原样转为 AA 审批卡 |
| 表单 | `elicitation/create`（form） | 转为 AA 表单交互 |
| 模型与推理强度 | `session/set_config_option` | 按 `category`（`model`、`thought_level`）映射，与配置 ID 无关 |
| 恢复 | `session/resume`，否则 `session/load` | `session.recover` 能力按握手结果推导 |
| 关闭 | `session/close` | Agent 声明支持时才调用 |
| 同步 | — | 事实与 outbox 写入同一事务，按序发送，收到 ACK 后删除 |

### 3.2 现在需要 profile 写代码的

| 行为 | Pi | Hermes | 标准 Agent 现状 |
| --- | --- | --- | --- |
| 用户消息写进 Timeline、确认接纳 | 自己实现 | 自己实现（与 Pi 基本相同） | 用户消息不进 Timeline，接纳要等整轮结束 |
| 声明命令、附件、追加等会话能力 | 在 `_meta.aa.capabilities` 里写死 | 同左，附件按 `promptCapabilities.image` | 一个都不声明 |
| 权限选项 | AA 自加 `aa-permission` | `edit_approval_policy`（category `mode`）改为 `permission` | 无法识别 |
| 运行中追加 | 扩展方法 `_session/steering` | 文本命令 `/steer` | 不可用 |
| 发送前校验 | 图片输入能力、`/bash` 审批 | — | — |
| 私有通知与怪癖 | 审批守卫加载校验、守卫异常 | 过滤审批卡片自身的更新 | — |
| 启动 | npm 安装、补丁、SDK 绑定 | 查找本机命令，运行 `--check` | — |
| 原生历史 | 只读索引、继续任务、与 CLI 交接 | 无 | — |

Pi 与 Hermes 的 ACP 方法对照见附录。

## 4. 安全约束

- `profiles/__init__.py` 规定 profile 是「Composition-time Agent definitions; never user-supplied executable code」。
- Runtime 实例配置可以经 Server 修改（`/api/v2/connectors/{connectorId}/runtimes/{runtimeId}/config`），Web 设备页就在用这个接口。

因此：

- 启动参数和注入的环境变量只能由随 Connector 发布的 Agent 定义决定。
- 实例配置不得出现自由填写的命令、参数或环境变量字段；定义注册时由测试检查配置 schema。
- 可执行文件路径（如 `cliPath`）能否远程修改，见待决问题 1。

## 5. 架构

```text
Agent 定义（启动方式、配置、能力上限）
        │ 装配
        ▼
公共会话引擎 ──── 进程与连接 ──── stdio JSON-RPC ──── Agent
  │  握手、认证、new / load / resume、prompt / cancel / 配置
  │  执行状态、接纳判定、交互、历史重放
  │
  ├─ 方言钩子（可选）：解释该 Agent 的扩展和差异
  │
  ▼
事件归一化：标准 ACP 更新 + 方言翻译 → Timeline 条目 / 统一错误事实
  ▼
事务与 outbox → Server → 四端
```

分工的原则：**Agent 定义决定怎么启动，方言解释各家差异，公共引擎掌握执行状态，客户端只看统一的事件和错误。** 方言不能修改会话生命周期、事件身份、接纳判定和历史重放。

### 5.1 Agent 定义

Agent 定义是随 Connector 发布的类型化 Python 对象（数据类），在 `default_runtime_providers()` 中注册。固定配置用字段表达，确实不同的行为用钩子表达。它取代现在的 `AgentProfile` 与各 profile 里的 Provider 样板代码。

| 分组 | 字段 | 说明 |
| --- | --- | --- |
| 身份 | `runtime_type`、`display_name`、`description` | 例如 `hermes`、`Hermes` |
| 启动 | `executable` | 命令名和候选路径，按顺序查找 |
| | `arguments` | 固定的启动参数 |
| | `check`、`version` | 启动前检查与版本查询；失败时在启动 Agent 之前明确失败 |
| | `settings` | 可选目录：实例配置键 → 传给 Agent 的环境变量，例如 `hermesHome` → `HERMES_HOME` |
| | `prepare_launch` | 可选钩子：安装依赖、打补丁、绑定 SDK（Pi 使用） |
| 配置 | `config_schema`、`normalize_config` | 实例配置表单与规范化；不填时由 `executable`、`settings` 生成 |
| 能力 | `runtime_capabilities`、`permission_options`、`required_guarantees` | Runtime 级能力上限、权限选项、恢复时要求的保证；会话能力再按握手收窄（见 5.2） |
| 展示 | `metadata`、`maturity`、`model_connection`、`model_connection_status` | 发现结果与模型连接 |
| 运行时 | `runtime` | 可选钩子：后台准备、原生历史等需要专用运行时的 Agent（Pi 使用） |
| 差异 | `dialect` | 方言工厂，默认为通用方言（空实现） |

Hermes 的定义大致是：

```python
HERMES = AcpAgentDefinition(
    runtime_type="hermes",
    display_name="Hermes",
    executable=Executable("hermes", candidates=("~/.local/bin/hermes", "~/.hermes/hermes-agent/venv/bin/hermes")),
    arguments=("acp",),
    check=("acp", "--check"),
    version=("acp", "--version"),
    settings=(PathSetting("hermesHome", "Hermes 配置目录（可选）", "HERMES_HOME"),),
    dialect=lambda _context: HermesDialect(),
)
```

### 5.2 公共会话引擎

由现有的 `AcpRuntime`、`SessionService` 和 `AgentClient` 演进而来，负责：

- **进程与连接**：启动受管子进程，清理进程树，连接异常时收敛状态。
- **握手与会话**：`initialize`、认证检查、`session/new`、`session/resume` 或 `session/load`、`session/prompt`、`session/cancel`、配置更新、关闭。
- **能力**：定义给出上限，按握手声明收窄。例如 `promptCapabilities.image` 为假时不开放附件；没有 `resume` 也没有 `loadSession` 时不开放恢复；收到过 `available_commands_update` 才开放命令；方言提供了追加方式才开放 `session.steer`。
- **执行状态与接纳判定**：见 5.5。
- **交互**：审批、表单的开启、回答、过期与取消。
- **历史重放**：恢复时 Agent 重放的历史在新连接绑定前到达，不重复写入 Timeline；能核验的稳定 `messageId` / `toolCallId` 才跨连接去重。
- **恢复失败**：明确失败并保留原会话，不自动建立替代会话，不重投结果未知的消息。
- **同步**：事实与 outbox 同一事务写入，按序发送、ACK 后删除（现有行为）。

### 5.3 方言钩子

方言是一组可选钩子，通用方言是空实现。只有需要时才覆盖：

| 钩子 | 用途 | 现有例子 |
| --- | --- | --- |
| `adapt_configuration` | 把 Agent 的配置项归入 AA 类别（模型、推理强度、权限），选项和名称保持原样 | Hermes 把 `edit_approval_policy` 归为权限 |
| `translate_update` | 把私有通知、`_meta` 或特殊工具输出翻译为标准更新，或丢弃 Agent 内部更新 | Hermes 丢弃审批卡片自身的更新 |
| `acceptance_evidence` | 额外的「已开始处理当前输入」证据 | Pi 守卫发出的 `aa-prompt-started` 状态 |
| `interaction` | 自行回答或转换 Agent 的请求 | Pi 把守卫的表单请求转为 AA 工具审批；Hermes 记下审批卡片 |
| `before_prompt` | 发送前校验；拒绝时视为未发送 | Pi 的 `/bash` 审批 |
| `verify_session`、`prepare_resume` | 新建或恢复前后核验与准备 | Pi 的审批守卫加载校验、恢复前写入权限；Hermes 要求有模型配置项 |
| `configure`、`extension` | AA 自有的配置项和操作 | Pi 的权限选项、认证状态与资源查询 |
| `steer`、`supports_steer` | 运行中追加的方式 | Pi 用扩展方法，Hermes 用 `/steer` 文本命令 |
| `capabilities`、`guarantees` | 额外的会话能力与保证 | Pi 声明 `managed_tool_permissions` |
| `classify_error` | 把 Agent 错误识别为统一错误事实 | 未安装、ACP 不可用、需要认证、模型不可用、额度不足 |
| `echoes_user_prompt` | Agent 是否会实时回显用户消息；是则引擎不再补发 | 默认否 |

运行中追加提供两种内置实现供方言直接选用：扩展方法（期望返回 `{outcome: "injected"}`）和斜杠命令（可声明是否支持附件）。其他方式由方言自己实现 `steer`。

### 5.4 统一事件与错误事实

- 标准 ACP 更新和方言翻译结果，经现有投影转换为 Timeline 条目（消息、思考、工具调用、文件变更、命令），客户端不读取任何 Agent 的原始通知。
- 方言只能产出现有的 Timeline 条目类型。新增条目类型（例如任务列表、子 Agent）属于契约变更，见待决问题 2。
- 错误统一为稳定的错误码和文案。公共层定义常见错误（见 [ACP Runtime 当前实现](acp-runtime-implementation.md)），方言负责把 Agent 的具体错误识别成这些错误码或更准确的专属错误码。

### 5.5 「消息已接纳」的判定

接纳的含义是：**有证据表明 Agent 已经在处理这条输入。接纳不代表执行成功**，执行结果另由回合结束状态（完成、取消、失败）表示。

| 状态 | 判定 |
| --- | --- |
| 未发送 | 发送前被本地拒绝（包括 `before_prompt` 拒绝），Agent 没有收到 |
| 已接纳 | 见下方证据 |
| 已拒绝 | Agent 明确拒绝了这条输入 |
| 结果未知 | 已经发出，但连接中断前没有拿到足够证据 |

算作接纳证据的：

- 发出 prompt 之后、本轮结束之前，该会话收到的第一个执行事件（助手消息、思考、工具调用及其更新）；
- Agent 在本轮发起的审批或表单请求；
- `session/prompt` 正常返回；
- 方言提供的额外证据。

不算证据的：子进程已启动、请求已写入 stdin、恢复时重放的历史。

归属规则：引擎保证同一会话同一时刻只有一条进行中的输入（运行中追加另行处理），因此本轮发出后到结束前的执行事件都归属于这条输入。确认接纳时，引擎写入带 `clientMessageId` 的用户消息，客户端和其他设备在刷新后也能看到。

## 6. 新 Agent 的接入流程与合入要求

1. 确认 Agent 提供 ACP v1 stdio 入口。
2. 编写 Agent 定义；只有标准 ACP 不覆盖的差异才实现方言钩子。
3. 录制该 Agent 的 ACP 交互作为回放样本，并用真实 Agent 加本地模型跑通用验证脚本（第 7 节），覆盖允许与拒绝审批、附件、运行中追加（声明了才测）、中断、恢复，在 PR 中贴出结果。
4. 更新 CHANGELOG 和 [ACP Runtime 当前实现](acp-runtime-implementation.md)。
5. 专属图标按需另补；四端不需要为新 Agent 做其他修改。

其余要求沿用 [#276](https://github.com/anywhere-labs/Agents-Anywhere/issues/276) 中确定的合入约定：Agent 专属内容只放在它的定义和方言里，不进公共参数；没有实现的能力明确返回 unsupported；CI 全部通过。

## 7. 验证分层

| 层次 | 内容 | 运行位置 |
| --- | --- | --- |
| 协议 | ACP 请求与响应按 SDK 类型校验；定义注册测试（配置 schema、能力上限、方言钩子签名） | CI |
| 公共引擎 | 脚本化的受控 Agent（`verify-acp-runtime.py` 等），新增断言：用户消息带 `clientMessageId` 进入 Timeline，并在 Agent 开始处理后记为已接纳 | CI |
| 方言 | 每个 Agent 的录制回放样本：回放真实交互，检查 Timeline 条目、能力和错误事实 | CI，不需要安装 Agent |
| 真实兼容 | `verify-acp-agent.py --definition <runtimeType> --executable <path>`，由 `verify-hermes-acp.py` 参数化而来，真实 Agent 加本地模型 | 本地，PR 中贴结果；安装稳定的 Agent 可另设每周检查 |

Pi 现有的 CI 场景（`verify-pi-managed.py --scenario all`）和 pi-compat 继续保留，作为 Pi 迁移的回归保障。

## 8. 迁移计划

| 阶段 | 内容 | 用户可见变化 |
| --- | --- | --- |
| 1 | 引擎接管接纳判定与用户消息写入；Pi、Hermes 删除各自实现；受控验证补断言 | 无 |
| 2 | 引入 Agent 定义与方言钩子；能力按握手收窄；Hermes 改为定义 + 方言；验证脚本参数化，加入录制回放 | 无，`runtimeType=hermes` 和已有实例配置不变 |
| 3 | 统一错误事实：常见错误码进入 `contracts/runtime-errors`，四端同步翻译；方言实现 `classify_error` | 英文界面能看到常见 Agent 错误的英文说明 |
| 4 | Pi 迁移到定义 + 方言，安装和原生历史由 `prepare_launch`、`runtime` 钩子装配 | 无 |
| 5 | 用定义接入下一个 ACP Agent | 新 Agent 可用 |

每个阶段单独提 PR。阶段 1 和 4 改动 Pi 的核心路径，必须在 Pi 的 CI 场景全部通过后合入。

## 9. 兼容性与版本

- 阶段 1、2、4 只改 Connector 内部，按[版本号规则](../versioning.md)属于 Connector 的 PATCH 更新，不写 CHANGELOG。
- 阶段 3 修改 `contracts/` 并涉及四端，属于接口更新。2.2.0 尚未发布，随 2.2.0 一起发布；若改到之后的版本，需要升 MINOR 并更新所有端的版本号。
- `runtimeType`、实例 ID 和已保存的实例配置保持不变，已有会话不受影响。

## 10. 风险

| 风险 | 应对 |
| --- | --- |
| 阶段 1、4 改动 Pi 依赖的路径，可能影响原生历史和审批守卫 | 通过 `acceptance_evidence`、`verify_session` 等钩子保留 Pi 的行为；以 Pi 的 CI 场景和 pi-compat 作回归 |
| 方言钩子越加越多，公共引擎的边界被侵蚀 | 方言不得改变生命周期、事件身份、接纳判定和历史重放；新增钩子需在评审中说明为何不能放进公共层 |
| 会实时回显用户消息的 Agent 出现两条用户消息 | `echoes_user_prompt`；录制回放检查用户消息只出现一次 |
| 录制样本过时，回放通过但真实 Agent 已变化 | 真实兼容验证在接入和 Agent 升级时重跑，并更新样本 |
| 「开始处理即接纳」成为所有 Agent 的默认规则 | 与现有 Pi、Hermes 行为一致；接纳与执行结果分开表示 |

## 11. 设计决定与待决问题

本方案采用的决定：

| 问题 | 决定 |
| --- | --- |
| 定义的形式 | 类型化的 Python 定义，允许行为钩子；不追求所有差异都用纯数据表达 |
| 用户自定义 Agent | 不支持。注册表只包含随 Connector 发布的 Agent，修改实例配置不能注册新 Agent |
| 错误 | 公共层定义类型化错误事实，常见错误码进入契约，方言负责识别 |
| 真实 Agent 验证 | 分层：协议、引擎、录制回放进 CI；真实 Agent 兼容验证在本地或每周检查进行 |

仍待决：

1. 是否限制可执行文件路径（`cliPath`）的远程修改，例如只允许设备本地修改，或只允许候选路径。
2. 方言是否可以产出新的 Timeline 条目类型（任务列表、子 Agent、后台任务等）；若可以，需要先扩展契约并同步四端。

## 附录：Pi 与 Hermes 的 ACP 方法对照

依据 `@openma/pi-acp` 0.1.8 和 Hermes `acp_adapter`（`git.42456cf`）源码整理。

| 功能 | ACP 方法 | Pi | Hermes |
| --- | --- | --- | --- |
| 握手 | `initialize` | 支持 load、list、delete、fork、resume、close | 支持 load、list、fork、resume，不支持 close |
| 新建、发消息、中断 | `session/new`、`session/prompt`、`session/cancel` | 标准 | 标准；以已注册的 `/命令` 开头的消息按命令处理 |
| 流式输出 | `session/update` | 另有 `compaction_update` | 另有 `plan` |
| 恢复 | `session/resume`、`session/load` | 支持 | 支持；加载时重放历史 |
| 配置 | `session/set_config_option` | `model`、`thinking`（`thought_level`）、`auto_compaction` | `model`、`reasoning_effort`（`thought_level`）、`edit_approval_policy`（`mode`）、`service_tier` |
| 审批 | `session/request_permission` | 只用于 Pi 界面上的选择；工具审批走 AA 守卫和表单 | 命令与编辑审批，选项 `allow_once`、`allow_session`、`allow_always`、`deny` |
| 表单 | `elicitation/create` | 用于提问 | 客户端声明支持表单时用于追问 |
| 运行中追加 | 无标准方法 | `_session/steering` | 文本命令 `/steer` |
| 认证 | `authenticate` | 另有 `logout`、`_auth/status_update` | 终端配置引导 |
| 私有扩展 | `_` 前缀方法、`_meta` | `_pi/trust_project`、`_pi/add_directory`、`_pi/emit_event` | 无扩展方法，`_meta.hermes` |
