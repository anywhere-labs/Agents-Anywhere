# DSH Runtime 配置与新建会话方案

更新日期：2026-09-08。状态：方案保留，当前分支已按要求撤回图片、模型/effort/权限和模式配置实现。以下是后续重做时的业务约束，不代表当前功能已开放。

核对基线：`dsh-bridge-next` 使用的官方 DSH `0.1.2-rc.1` 类型、发布包实现和预设文件，并参考官方插件文档。本文中的“当前实现”指本仓库现状；“需要实现”不表示功能已经接通。

## 1. 已确认的业务规则

1. DSH Runtime 向 AA 提供权限、模型、effort 的能力及可选值，并提供 Agent 模式目录。
2. 模型的实际身份是 `provider ID + model ID`。界面按模型名称是否跨 provider 重复，决定是否显示 provider。
3. 新建会话要把权限、provider、model、effort、cwd、Agent 模式完整传到插件，并在首条消息开始执行前完成设置。
4. **AA 新会话继续使用 AA 现有偏好机制。不得根据 DSH 返回的默认值、最近选择或默认标记覆盖 AA 的选择。**
5. **保持 AA 现有偏好的存储结构、作用域、保存时机和失效回退逻辑不变。**本次补齐 DSH 的目录、请求透传和执行，不重写平台偏好功能。
6. **会话内的模型、effort、权限随时可以切换。插件收到请求后立即调用官方切换入口，实际生效时机由 DSH 决定。**不增加“等当前 turn 结束”的限制。
7. Agent 模式在 AA 创建会话时确定。已创建的 AA 会话不提供模式切换入口。
8. 在设备详情的 DSH Runtime 配置中增加“新会话默认模式”，只影响以后创建的会话。

这里将讨论中“配置创建会话时的默认模型”理解为“默认模式”，对应截图中的标准、PTC、极简、创造模式；模型本身继续由 AA 现有新会话偏好管理。

## 2. 字段含义与状态归属

| 概念 | 字段或身份 | 含义 | 创建后的修改规则 |
| --- | --- | --- | --- |
| 权限模式 | `permissionMode`，映射官方 permission preset | 一组沙箱与审批策略 | 随时提交切换 |
| 模型 | `provider + model` | provider ID 与 model ID 的完整路由 | 随时提交切换 |
| 推理强度 | `reasoningEffort` | 当前模型支持的 effort | 随时提交，与模型成组校验 |
| 工作目录 | `cwd` | DSH Host 所在机器上的工作目录 | 本方案只在创建时确定 |
| Agent 模式 | `agentPreset` | 一组工具、提示词和插件组成的 Agent 预设 | AA 只在创建时确定 |

`modelName` 是显示名称，不能代替 `model ID` 调用官方接口。`agentPreset` 也不能与 permission preset 混用。官方 `prompt.mode` 的 `queue / steer` 表示消息投递方式，与截图中的模式无关。

三类状态分别管理：

| 状态 | 所有者 | 用途 |
| --- | --- | --- |
| AA 新会话偏好 | AA 现有偏好模块 | 打开新会话页面时恢复模型、effort、权限选择 |
| AA Runtime 的默认 Agent 模式 | AA 中当前设备、Runtime 实例的配置 | 新建 DSH 会话时补齐 `agentPreset` |
| 当前会话配置 | DSH 会话状态 | 展示、执行、恢复和跨客户端同步 |

DSH 自己保存的“以后会话默认使用什么”不参与 AA 新会话选值。恢复已有会话时，也不能用 AA 新会话偏好或 Runtime 默认模式重新初始化它。

## 3. 已核实的官方接口

| 需求 | 官方入口 | 本次接入方式与边界 |
| --- | --- | --- |
| provider、模型和 effort 目录 | `ctx.sessionController.modelCatalog()`；底层 `ctx.llm.listProviders()`、`listModels(provider)`、`resolveModelInfo(provider, model)` | 获取 provider/model 标识、名称及模型级 effort 信息；不采用目录的全局 `default` |
| 权限目录 | `ctx.permissionPresets.names`、`optionOf(name)` | 使用当前部署真实的预设表；不把 `defaultPreset` 当成 AA 默认选择 |
| 当前权限 | `ctx.permissionPresets.current(session)`，或官方 `permissions` 会话投影 | 按实际沙箱和审批状态读取，支持派生的 `custom` 状态 |
| Agent 模式目录 | `ctx.agentPresets.list()` / `remoteExportList()` | 可以获取内置及用户自定义模式；AA 丢弃 `isDefault`，不使用 DSH 的 `defaultId` |
| 创建会话 | `ctx.sessionController.create({ sessionId, cwd, agentPreset })` | 支持 cwd 和 Agent 模式；**没有**一次携带模型、effort、权限的参数 |
| 切换模型和 effort | `ctx.sessionController.selectModel({ sessionId, provider, model, reasoningEffort })` | 一次提交完整模型选择，返回官方解析后的 `selected` |
| 初始化权限 | `ctx.permissionPresets.set(session, preset)` | 写入当前会话的权限事实；须在第一条消息入队前完成 |
| 会话内切换权限 | 官方命令执行入口的 `/permission <preset>` | 沿用官方实时写入路径，其中包含审批策略变更的处理；不能把命令当普通用户消息发送 |
| 发送消息 | `ctx.sessionController.prompt({ requestId, sessionId, mode: 'queue', content })` | 提交普通消息；接口本身不带上述配置，配置应先设置 |

这些是 DSH Host 的公开服务入口，不是要求 AA 直接连接 DSH 的外部 HTTP API。调用链仍然是：

```text
AA 客户端 → AA Server → Python Connector → dsh-bridge-next Host → DSH 官方服务
```

现有插件已经使用公开的 `ctx.agents.create(...)` / `agent.followup(...)` 处理纯文本会话。这组接口也能组合创建流程。补齐配置时必须统一 Agent 的控制权与模型选择写入路径，不能让两个控制器各持一份互不同步的模型选择。

优先接入官方 Session Controller，以覆盖 AA 创建和 DSH 本地创建的会话。该服务是 Host 服务，业务代码不能依赖浏览器、Electron 或 DSH 前端组件实例。具体部署未组合相应服务时，能力应如实关闭并说明原因；公开底层 API 的替代实现必须通过同样的验收。

### 3.1 截图中的模式可以枚举

在 `0.1.2-rc.1` 的官方发布包中核实到以下内置模式：

| 实际 ID | 中文名称 |
| --- | --- |
| `standard` | 标准模式 |
| `ptc` | PTC 模式 |
| `minimal` | 极简模式 |
| `cordis` | 创造模式 |

其中创造模式的 ID 是 `cordis`，不能根据显示文字猜成 `create` 或 `creator`。

目录还可能包含用户自定义模式。每项包含稳定 ID、名称、描述、来源，以及不可用时的 `broken` 原因。插件应动态读取目录，不能把上面四项写死为全部可选项；`list()` 返回的本地文件路径无需交给 AA。

官方 `agentPresets.select(agent, id)` 允许切换尚未开始过 turn 的空白会话。它检查是否已有打开的 turn 或历史 turn，一旦开始过就返回 `agent-preset/locked`。所以准确边界是“首个 turn 开始后锁定”，并非创建对象的瞬间就锁定。

AA 的本次规则保持简单：模式在创建并发送首条消息之前确定，之后只展示，不暴露空白会话的模式切换特例。

### 3.2 官方 `selectModel` 的默认值副作用

此版本的官方实现先安装当前会话的模型选择，再尝试调用 `agentDefaultModel.saveSelection(selected)`。它会保存完整的 provider、model、effort，接口中没有 `persistDefault: false` 一类参数。新建初始化如果使用它，也有同样的副作用。

本方案明确区分两个要求：

- **本次必须实现：AA 忽略 DSH 默认偏好，AA 会话内切换不写 AA 新会话偏好。**即使 DSH 自己记住了 B，下一次 AA 创建仍显式使用 AA 记住的 A。
- **额外的更强要求：AA 操作连 DSH 自己的全局默认也完全不能改变。**现有官方 `selectModel` 无法直接保证这一点。所以不做这个逻辑。

## 4. Runtime 的能力与目录上报

能力回答“支持什么操作”，目录回答“有哪些合法选项”，当前状态回答“这个会话选了什么”。三者都要接通。

| 内容 | AA 对接方式 | 要求 |
| --- | --- | --- |
| 模型目录 | 现有 `catalog.model` + `catalog.listModels` | 保留 provider、model 标识与显示名称 |
| effort 目录 | 现有 `catalog.effort` + 模型的 `reasoningItems` | effort 归属于具体 provider/model，不提供虚构的全局枚举 |
| 权限目录 | 现有 `catalog.permission` + `catalog.listPermissions` | 取官方 permission presets；`custom` 仅表示当前状态 |
| Agent 模式目录 | 新增桥接查询 `catalog.listAgentPresets`，供 Runtime 配置使用 | 方法名为本方案新增契约；返回 ID、名称、描述、可用性，不返回 DSH 默认标记 |
| 默认模式配置 | 现有 `runtime.config` 对应的 AA Runtime 配置表单 | 不增加会话内模式切换 capability |

上报与刷新规则：

1. 初始化、重连、打开相关配置页面时获取目录；DSH provider、模型或模式目录变化后刷新。优先使用官方可观察变化；文件目录变化没有合适事件时，读取时刷新并提供手动刷新。
2. Runtime 级别报告部署可提供的能力；会话级别结合真实 Agent 组合、可写性和服务可用性细化。不能因为 `running / waiting_approval / stopping` 就把三个切换能力设为不可用。
3. 某个 provider 查询失败时保留其他成功目录，并上报该 provider 的错误。不要把暂时查询失败当成整个 Runtime 永久不支持，也不要把临时空目录写成用户的新偏好。
4. 模型目录不等于路由的完整白名单。官方允许可路由 provider 的目录为空；已有选择不在目录中时，先展示真实值和可用性，最终以官方路由解析、校验结果为准。
5. `custom` 权限可以展示为当前值，但不可放进新建或切换目标。权限服务未组合时，明确说明该部署不支持权限选择。
6. 目录中的 DSH `default`、`defaultPreset`、`defaultId`、`isDefault` 不得映射成驱动 AA 新建选值的默认标记，也不得据此重排 AA 的选择。
7. 配置目录、能力和状态应带版本或事件序号，避免重连补偿、查询结果和实时更新互相覆盖。

## 5. provider、模型名称与 effort

### 5.1 显示规则

在当前 DSH Runtime 的完整模型目录内，按模型显示名称检查是否跨 provider 重名：

| 目录情况 | 显示 |
| --- | --- |
| 只有一个 provider 提供该名称 | `Model A` |
| 多个 provider 提供相同名称 | `Model A（Provider X）`、`Model A（Provider Y）` |

重名判断不受当前搜索过滤结果影响；不能搜索后只剩一项就去掉 provider。名称优先使用官方名称，缺失时回退 ID。若 provider 的显示名称也重复，则以 provider ID 补足区分。

搜索、选中态、历史配置回显使用同一套显示规则。新增或删除 provider 可以改变标签，但不能改变模型选择的稳定身份。极少数“同一 provider 下不同 model ID 也同名”的情况，再用 model ID 区分，不能合并路由。

### 5.2 沿用现有 AA selection 契约

不新建独立的 provider 下拉框。一个模型选项背后保存完整的 provider/model 路由；effort 继续作为该模型的关联选择。

现有 DSH 编码可以继续使用：

```text
模型选项身份：provider ID + model ID
模型 selectionId：dsh:model: + base64url(UTF-8 JSON [provider, model, effort 或 null])
权限 selectionId：dsh:permission: + base64url(UTF-8 permission preset ID)
```

AA 仍传 `selections.model` 和 `selections.permission`。模型的 `reasoningItems` 提供各 effort 对应的完整 `selectionId`，插件解码后再调用 DSH。显示名称、括号和国际化文案不进入 ID。

effort 处理规则：

- 使用该 provider/model 真实返回的 effort ID 和名称，不硬编码 `low / medium / high`。
- 模型和 effort 作为一个整体提交，避免先换模型、后补 effort 时短暂产生非法组合。
- 换模型后原 effort 不可用，沿用 AA 已有的选择及回退处理，发送最终合法组合；插件再调用官方解析接口校验。
- 不支持 effort 的模型关闭相应选择器，清除不适用的旧 effort，不发送空字符串。
- `null / 未指定` 若作为“模型默认推理”的显式选择保留，其含义是采用模型适配器的默认行为，不是读取 DSH 最近保存的全局 effort。不得用全局默认 effort 填补 AA 的参数。
- 请求的 effort 被官方规范化时，以返回的实际选择回显；不能显示 high，却实际已选成另一值而不告知用户。

## 6. 设备详情：新会话默认模式

位置：设备详情 → DSH Runtime → 配置。

建议字段：`defaultAgentPreset`，显示名称“新会话默认模式”，说明“仅用于此 Runtime 以后创建的会话，已有会话保持原模式”。保存值为 preset ID，界面显示名称和必要描述。

具体规则：

1. 选项来自对应 DSH Host 的实时模式目录，内置及自定义模式一并显示。`broken` 模式不可新选，并展示原因。
2. 值保存到 AA 当前 Runtime 实例配置；不调用 DSH 的默认模式设置入口，也不写入 AA 通用的新会话 model/permission 偏好对象。
3. 创建会话时读取这个 AA 配置，并把确定后的 `agentPreset` 显式传给插件。已经提交的创建请求固定自己的模式快照，不因设备配置随后改变而变更。
4. 首次接入、旧配置缺字段时，建议 AA 以可用的 `standard` 作为初始模式；此为 AA 的初始规则，不读取 DSH 默认模式。没有可用 `standard` 的自定义部署要求先选择模式，不擅自选另一个模式。该初始规则只针对新增模式字段。
5. 已保存的模式被删除或变成 `broken` 时，保留原配置供用户识别，提示重新选择并拒绝用它创建新会话；已有会话不被重置。不得静默落回 DSH 默认模式。
6. Runtime 离线时可展示已保存值，不能把未知状态解释为模式已经删除；恢复连接后再校验目录。
7. 只修改这个默认模式不能中断正在执行的 DSH turn。现有 Runtime 配置保存可能重建适配器连接，实施时要验证并保证不因此重启 DSH Host、销毁 Agent 或丢失切换请求。

现有 `RuntimeConfigDialog` 已支持 schema 枚举选择，但当前直接显示枚举原值。需要补齐“ID 与名称分离”、说明、禁用原因和动态目录刷新，并复用 AA 的现有表单组件。模式目录应由插件解释，Connector 只负责转发和配置装配，不复制 DSH 发现逻辑。

本阶段无需在新建会话页新增另一套模式偏好选择器；可展示最终模式作为提示。创建请求必须携带模式字段，以后是否开放单次创建覆盖可以独立扩展。

## 7. 新建会话与后续 turn

### 7.1 参数来源

| 参数 | 来源 |
| --- | --- |
| provider、model、effort | AA 新建页面经现有偏好恢复后，用户最终选中的模型组合 |
| permission mode | AA 新建页面经现有偏好恢复后的权限选择 |
| cwd | AA 当前选中的 DSH 工作目录 |
| agentPreset | AA 当前 Runtime 的 `defaultAgentPreset`，在创建请求提交时固定 |

完整业务参数示意如下。这里展示解码后的含义；AA 的模型和权限线协议仍使用现有 selection ID：

```json
{
  "sessionId": "aa-session-id",
  "clientMessageId": "stable-message-id",
  "content": "开始处理这个项目",
  "cwd": "/workspace/project",
  "provider": "provider-a",
  "model": "model-a",
  "reasoningEffort": "high",
  "permissionMode": "workspace-write",
  "agentPreset": "standard"
}
```

桥接 `session.createAndStart` 应接收 `selections`、`cwd`、`agentPreset` 及原有消息字段。AA 到 Connector 的创建参数通道需要带上模式快照；若现有公共创建 DTO 缺少容纳该字段的位置，只扩展创建参数及透传，不改偏好模块。

AA 没有历史偏好、偏好选项失效或用户切换 Runtime 时，继续使用 AA 已有回退逻辑。插件不能在收到参数后改用 DSH 默认值；必要参数没有解析出来时应返回明确错误。effort 的显式“模型默认”与参数意外丢失要在请求校验中区分。

### 7.2 创建执行顺序

```text
AA 固定本次创建的 selections、cwd、agentPreset 和消息 ID
  → 插件校验身份、目录、模式、模型/effort 与权限
  → 官方 create：指定 sessionId、cwd、agentPreset
  → 官方设置模型与 effort
  → 官方设置当前会话权限
  → 确认配置成功并读取实际值
  → 官方 prompt / followup：只提交一次首条消息
  → 回传实际配置、会话状态与后续输出
```

创建接口本身不接受全部参数，所以必须由插件编排。**不能先开始 turn，再异步补配置。**即使官方创建过程内部初始化了自己的默认值，AA 首轮执行前也必须设置成 AA 本次明确选择的值。

多步调用不是事务：模型设置成功、权限设置失败时不得宣称整个操作成功，也不得发送首条消息。返回已创建的会话身份、失败步骤及实际配置，允许继续完成初始化。不要为处理失败而自动删除会话。

`cwd` 按 DSH Host 机器校验，不能按手机或 AA 客户端的文件系统解释。创建时要求最终解析为有效绝对目录；同时传 workspace ID 和 cwd 的情况要遵守官方接口的互斥约束。

### 7.3 幂等与续聊

- 用稳定的 AA 会话映射和 `clientMessageId` 识别重试。响应丢失后重试，不能创建第二个会话、重复发送消息，或把已经切换的新配置重新刷回首轮参数。
- 同一创建请求 ID 携带不同模式、cwd 或初始化参数时返回冲突，不能当作无害重试。
- 初始化部分成功且首条消息未被接收时，可以在核对实际状态后继续未完成步骤。消息已被接收时只返回已有结果；新的配置变化应走切换请求。
- 续聊继续使用已有会话的 cwd、模式和当前配置。恢复时优先使用 DSH 持久化的会话选择及官方投影，不取任一端的“新会话默认值”。
- 普通 `startTurn` 未携带配置变更时保持当前选择。若现有 AA 请求携带本次明确选择，按同一写入顺序先应用再提交消息，不能用服务端旧缓存覆盖最近一次已确认切换。
- 消息重试语义和切换语义必须独立，重连不能自行重放一个无法判断是否已成功的旧切换来覆盖新选择。

### 7.4 AA 偏好不变的例子

```text
AA 新会话选 Model A / low / 权限 P，创建会话 S1
  → AA 按现有机制记住 A / low / P

S1 执行中切到 Model B / high / 权限 Q
  → 立即调用 DSH 切换接口，S1 更新
  → AA 新会话偏好仍是 A / low / P

再次从 AA 创建 S2
  → 显式发送 A / low / P
  → 模式使用此刻 AA Runtime 配置里的 defaultAgentPreset
  → DSH 自己当前记住 A 还是 B，不参与 AA 的选择
```

该示例描述业务结果，不重新定义 AA 何时保存偏好。当前 AA 在新建页面选择变化及提交路径中已有保存行为，本次不得改成“仅创建成功后才保存”。

## 8. 会话内随时切换

三个选择器在生成、执行工具、等待审批或停止过程中均可提交切换。仍保留 AA 现有的访问权限、会话接管、归档和 Runtime 可用性检查；这些检查不等于 turn 空闲限制。

```text
用户在 AA 选择新配置
  → AA 发出 session.updateSelections
  → Connector 原样转发
  → 插件立即执行官方模型/effort 或权限切换
  → 返回官方已接受的实际选择
  → DSH 自行在其执行流程中使用新配置
```

| 配置 | AA 负责 | DSH 负责 |
| --- | --- | --- |
| 模型 / effort | 立即提交完整组合，回显官方返回值 | 后续请求组装何时使用新值；已发出的模型请求不会被 AA 改写 |
| 权限 | 立即提交官方权限切换 | 后续沙箱、工具和审批检查如何读取新策略；已有进程、审批请求的处理 |
| Agent 模式 | 不提供会话内修改 | 官方对已开始会话的锁定规则 |

“后续请求”可能仍在同一个 turn 内。不能向用户承诺“下一整个 turn 才生效”，也不能在接口成功后声称正在输出的请求已经换成新模型。

前端只维护请求提交状态，不建立“等 turn 结束再应用”的业务队列。切换成功可以显示“已更新”；如需解释时机，使用“已提交给 DSH，按 DSH 执行流程生效”。

需要处理的并发细节：

1. 同会话的配置写入与消息提交保持明确顺序。串行范围只包含校验、设置与消息入队，**不能持锁等待模型生成、工具执行或整个 turn 完成**。
2. 连续选择 A → B → C 时按操作顺序提交，最终以最后一次成功且未被更新操作替代的结果为准。旧响应或旧错误不能覆盖更新选择。
3. 模型与 effort 同批传递。权限与模型同批更新时先校验全部字段；实际写入部分失败必须报告部分结果并重新读取状态，不能宣称原子成功。
4. DSH 本地也可修改同一会话。AA 以官方事件顺序和查询状态收敛，不通过反复重试强行覆盖本地更新。
5. 等待审批时切换权限不代表用户回答了当前审批。审批仍由官方交互流程处理，AA 不因改了 permission mode 自动发送批准或拒绝。
6. 官方拒绝某次切换时展示真实原因并校准状态；不为了统一前端行为人为添加全部“运行中禁止修改”的兜底限制。

## 9. 当前配置读取、持久化与同步

`session.getState` 和实时状态事件都需要携带实际 selections；模式与 cwd 作为会话信息回显。不能只返回空对象，或只在 AA 本地记住下拉框的选择。

模型读取优先使用官方模型选择投影中的 `next`，它表达会话已选择供后续请求使用的值；`lastUsed` 表达最近实际请求使用的值。必要时把两者分别放到展示状态和执行信息中，不能让旧请求的 model header 把新选择覆盖回去。

权限读取官方 `permissions` 投影或 `current(session)`，不要只看最近一次 `permission/preset` 事件。DSH 本地单独改变沙箱或审批策略后，实际状态可能成为 `custom`。

需要同步：

- AA 发起切换后的官方确认及事件。
- DSH 本地 UI、命令或其他官方调用造成的配置变化。
- 断线重连、插件重载、DSH 重启及恢复冷会话后的实际配置。
- 模型目录、权限目录和模式目录变化导致的可选项与可用性变化。

会话配置变化只更新该会话；目录刷新只更新目录。这两条路径都不能调用 AA 新会话偏好保存函数。配置日志也不能被投影成重复的用户消息或普通聊天气泡。

## 10. 当前缺口与实施范围

| 层 | 当前已看到的缺口 | 需要补齐 |
| --- | --- | --- |
| 插件 capabilities / router | 三个 catalog 能力关闭；未实现目录查询和 `session.updateSelections`；状态 selections 为空 | 真实能力、目录、切换路由和状态读取 |
| 插件 native | 新建、恢复路径仍可能取 DSH 默认模型或模式；纯文本发送未接收这些配置 | 区分新建与恢复，显式初始化，统一官方写入控制权 |
| 插件 sync | 当前以会话、消息和运行状态同步为主 | 配置投影、目录变化及重连校准 |
| Connector DSH runtime | `create_and_start_session` / `start_turn` 收到了 selections，但 `_send_text` 未透传 | 补齐字段、目录与切换方法的薄转发 |
| Runtime 配置 | 无 `defaultAgentPreset` 和模式目录 | 模式目录查询、AA 配置字段、校验及创建时快照 |
| AA 客户端 | 已有模型/effort/权限选择与偏好；模型标签未完整处理跨 provider 同名 | 补齐目录适配、标签、状态回显和 Runtime 模式配置 |
| 公共契约与 Server | 已有 selections；模式还未形成完整创建参数通道 | 最小范围扩展创建字段、桥接模式目录及必要事件；保留现有平台偏好逻辑 |

主要代码入口：

- 插件：[capabilities](./src/host/dsh-runtime/capabilities.ts)、[router](./src/host/dsh-runtime/router.ts)、[native](./src/host/dsh-runtime/native.ts)、[sync](./src/host/dsh-runtime/sync.ts)。
- Connector：[DSH runtime](../connector/connector/runtimes/dsh/runtime.py)、[provider](../connector/connector/runtimes/dsh/provider.py)、[provider config](../connector/connector/runtimes/dsh/provider_config.py)。
- 契约：[桥接协议](../contracts/dsh-bridge/1.0/)、[Runtime 接口](../connector/connector/runtime_protocol/protocol.py)。
- AA Desktop：[目录选择](../desktop-workbench/renderer/src/components/session/catalog-selection.ts)、[新建会话](../desktop-workbench/renderer/src/components/task-composer.tsx)、[会话详情](../desktop-workbench/renderer/src/components/session-detail.tsx)、[Runtime 配置表单](../desktop-workbench/renderer/src/components/runtime-config-dialog.tsx)。
- 保持不变：[AA 新会话偏好](../desktop-workbench/renderer/src/features/dashboard/new-session-preferences.ts)及调用它的现有保存、恢复、回退语义。

DSH 插件 UI 若需要变更，使用官方扩展点和官方组件。AA 端复用 AA 现有组件。Host 逻辑需在 headless 环境可执行。

实施顺序：先补协议和只读目录，再接 Runtime 默认模式配置与创建初始化，随后接实时切换及状态同步，最后做端到端验收。以上是同一批完整目标，不能只打开 capability 开关就认为功能完成。

## 11. 验收条件与容易遗漏的逻辑

| 场景 | 必须验证的结果 |
| --- | --- |
| 枚举截图的四个模式 | 返回正确 ID 和名称；创造模式为 `cordis`；自定义模式可被发现 |
| AA 选择 A，DSH 默认 B | AA 首条真实模型请求使用 A；权限、effort、cwd、模式均为本次明确值 |
| DSH 默认值变化 | AA 新建页面与下一次创建继续沿用 AA 偏好，不被 DSH 覆盖 |
| 新建后在会话内改 B/high | 当前会话更新，下一次 AA 创建仍恢复原来的 A/effort |
| AA 新建偏好回归 | 原保存时机、作用域、已有选项失效回退和其他 Runtime 行为不变 |
| 运行中切换模型 / effort | 请求立即到达官方入口；当前请求保持其已组装配置，后续请求依 DSH 规则使用新值 |
| 执行工具、等待审批、停止中切换 | AA 不增加 idle 门禁；权限变更不被当成审批回答 |
| AA 创建和 DSH 本地创建的活跃会话 | 两类都能通过官方控制路径切换，不能重新引入“借用 Agent 不可改模型”的旧限制 |
| 切换后进程重启或恢复冷会话 | 还原会话真实选择，不能退回 AA 或 DSH 新会话默认 |
| model name 唯一 / 跨 provider 重复 | 分别显示 `Model A` / `Model A（Provider）`；路由 ID 始终不变 |
| effort 不受支持或模型不支持推理配置 | 不发送非法组合；界面与官方规范化结果一致 |
| 连续切换与多端同时切换 | 请求和事件顺序可追踪；旧响应不覆盖新选择，最终与 DSH 一致 |
| 初始化部分失败 | 首条消息未发送，失败步骤和已完成结果可见，可安全继续 |
| 创建响应丢失并重试 | 一个会话、一条首消息，不把后来的配置重置回创建值 |
| 更改 Runtime 默认模式 | 只影响以后创建的会话；已有会话模式不变，正在执行的 turn 不受干扰 |
| 模式删除、损坏或 Runtime 离线 | 正确区分不可用与未知；不静默使用 DSH 默认模式 |
| 权限处于 `custom` | 正确展示当前实际状态，不能把 `custom` 当可切换预设 |
| 仅部分 provider 目录失败 | 其他模型仍可用，错误有归属，不清空或重写 AA 偏好 |
| headless Host | 目录、创建、切换和同步不依赖桌面 UI |

实施时优先完成两项技术验证：官方 Session Controller 在目标 Host 的组合与两类活跃会话控制权；官方实时权限命令在执行中保留原生行为。若还要求 DSH 全局默认完全不被写入，则第 3.2 节的官方 API 限制必须单独解决，不能在验收中忽略。

## 12. 官方依据

主要事实以 `0.1.2-rc.1` 发布包为准。用户提供的官方源码目录在本次核对时为较早版本；其中的插件架构文档可以参考，具体方法签名与时序采用已安装版本重新核实。Context7 查询也确认了模式目录和空白会话切换入口。

- [官方 Session Controller 类型](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.2-rc.1/packages/api/session-controller/src/types.ts)：创建、消息投递、模型选择、模型目录和模型投影。
- [官方 Session Controller 命令实现](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.2-rc.1/packages/api/session-controller/src/commands.ts)：创建参数、`selectModel` 校验及保存全局默认的副作用。
- [官方 Agent Presets](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.1.2-rc.1/packages/preset/agent-presets)：模式发现、目录字段、内置模式 ID 和 `select` 的 turn 锁定条件。
- [官方 Permission Presets](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.2-rc.1/packages/interaction/permission-presets/src/index.ts)：权限目录、`custom`、初始化与 `/permission` 的实时写入路径。
- [官方 Agent 实现](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.1.2-rc.1/packages/core/agent)：Agent 创建和模型选择参与后续请求组装的机制。
- [官方插件文档目录](/Users/t4wefan/code/github/deepseek-harness-desktop/deepseek-harness/docs)：本地插件开发、生命周期与权限文档参考。
