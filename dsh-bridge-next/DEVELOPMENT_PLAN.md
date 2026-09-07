# DSH Bridge Next 开发计划

## 1. 项目目标

在 `dsh-bridge-next/` 中重新实现安装到 DSH Desktop / Web 的插件。旧 `dsh-bridge/` 作为业务行为、协议和测试案例的参考。

核心设计：**Connector 的 DSH 适配器负责协议转发；DSH 相关的 Agent 业务逻辑集中在插件的 `src/host/dsh-runtime/` 中。**

预期收益：只要插件与 Connector 之间的协议保持兼容，DSH 官方升级后，通常只需更新插件，无须同步修改 Connector。

当前已实现无 AA Desktop 的插件登录、设备绑定、内部源码 Connector 管理与 Web onboarding，覆盖到“设置完成”。Desktop 启动安装登记、新建本机设备 ID 记录，以及插件 OAuth 后按共享 ID 恢复设备也已接入。Runtime 第一阶段已实现：端点发现与鉴权、单实例添加、原生会话列表和历史详情读取；Python DSH 适配器已收薄。实现边界与后续步骤见 [会话读取](./RUNTIME_READS.md)，运行方法见 [README](./README.md)。

本轮已按确认方案接入官方侧栏过滤、内部 notice 丢弃、首次历史校准、实时事件与重连补偿，以及纯文本新建/续聊和中断。**后端不新增接口或逻辑，复用现有 Timeline 完整替换和增量通知。** 详细边界见 [Runtime 过滤与事件同步计划](./RUNTIME_SYNC_PLAN.md)。附件、模型/权限目录及审批应答后续单独实现。

插件入口为 DSH 主侧边栏设置上方的「手机连接」，使用官方扩展点与官方 Modal、Button、Input 等组件。登录文案及云端/自建实例交互与 Desktop 保持一致：自建实例仅输入后端地址，检查后端健康状态后发起 OAuth；本地只保存后端地址，按同源部署及本地开发端口约定推导 Web/OAuth 地址，不再单独配置或保存 OAuth 地址。

插件启动与每次打开「手机连接」弹窗时优先检测 Desktop，与登录状态无关。有效安装目前只显示「已安装桌面端，连接功能即将开放。」占位页面；每次打开都等待新检测，避免闪现上次的账号或登录页面。

未安装 Desktop 时，登录后切换为「已登录」面板，显示头像与账号基本信息、Connector 运行状态，以及「打开 Web」「退出登录」两个操作；面板不放手机连接入口。Web 按钮直接进入应用，退出登录负责停止本机连接并清理用户凭据。

Connector 凭据失效时，插件接收既有 `connector/state` 通知并检查当前设备。确认删除后在 Connector 状态区提供「重新创建」；仍存在则提供「重新连接」，只续签当前 ID 的凭据。两种操作都等待点击，重启也不自动恢复。网络错误和账号登录过期单独提示，复用现有后端接口。

最新业务流程见 [Onboarding 业务方案](./ONBOARDING_PLAN.md)。**第一期先实现未安装 Agents Anywhere Desktop 的流程。** 本文的 Desktop 均指 AA Desktop；DSH Desktop 是承载插件的另一应用。

插件进入引导前由 Host 检查本机 Desktop 安装状态。已安装时将 onboarding、用户、设备及 Connector 管理交给 Desktop；未安装时插件承担本机管理职责，OAuth 后把已上线设备交给 Web 独立 onboarding 页面。两种模式共用插件内的 `dsh-runtime`，不改变 Connector 薄转发的边界。

## 2. 两端的明确分工

### Connector 侧：`connector/connector/runtimes/dsh/`

这一端运行在 Python Connector 进程中，作为 Connector 统一运行时接口与插件端口之间的转发适配器。

负责：

- 保留 Connector 所需的运行时接口，将接口调用封装成协议请求。
- 发现插件端点，建立连接并完成鉴权、协议版本检查。
- 转发请求、响应和通知，完成通用的参数编解码及结构校验。
- 处理超时、取消、断线和重连，向 Connector 报告连接错误。
- 将插件返回的标准会话、Timeline、能力和交互数据交给 Connector。

不承担 DSH 相关的 Agent 业务：

- 不直接调用 DSH 内部服务，不依赖 DSH SDK。
- 不解析 DSH 原始会话文件、内部事件或模型数据。
- 不决定 DSH 会话生命周期、消息执行、审批和权限语义。
- 不维护 DSH 特有的 ID 映射、Timeline 投影或版本兼容分支。

允许保留把协议对象转换成 Connector 公共数据类型的机械转换，但不能在转换中重新解释 DSH 业务语义。写请求的重试必须遵守协议的幂等约定，不能因重连自行重复执行操作。

### 插件侧：`dsh-bridge-next/src/host/dsh-runtime/`

这一端运行在 DSH Host 进程中，是 DSH 相关 Agent 业务的实现者。

负责：

- 暴露本机通信端口，接收 Connector 转发的请求并返回结果。
- 调用目标版本的 DSH 原生服务，处理相关 API 和事件变化。
- 实现会话创建、查询、恢复、消息发送、引导、中断和命令执行。
- 实现模型、推理强度、权限等选项的查询与变更。
- 实现审批、提问及用户响应的完整业务流程。
- 管理 DSH 特有的会话关联、消息 ID、幂等和并发规则。
- 处理实时输出、历史读取及同步，转换成双方协议约定的标准数据。
- 管理属于该模块的连接、订阅、会话控制器和持久化元数据，并在卸载时释放资源。

**插件直接输出 Connector 约定的数据结构，避免让 Python 适配器再次理解和转换 DSH 原始数据。**

之前讨论的 `host/bridge/` 和 `host/dsh/` 合并到 `host/dsh-runtime/`。不再把这两者规划成独立的顶层业务模块。

## 3. 实际调用链

发送消息：

```text
手机 / AA 客户端
  → AA Server
  → Python Connector
  → connector/connector/runtimes/dsh/：转发协议请求
  → 插件暴露的本机端口
  → host/dsh-runtime/：执行 DSH 会话业务
  → DSH 原生服务
```

返回输出：

```text
DSH 原生事件
  → host/dsh-runtime/：整理为约定的 Timeline、状态或交互数据
  → Connector 的 DSH 适配器：转发结果和通知
  → Connector / AA Server
  → 手机 / AA 客户端
```

未安装 AA Desktop 时，插件还有一条管理链路：`client → host/rpc → host/connector`，用于启动、停止和查看其内部源码 Python Connector。已安装时，账号、设备和 Connector 生命周期由 Desktop 管理，插件不启用对应管理模块。这条进程管理链路与上面的 Agent 远控链路分别实现。

无 Desktop 的引导交接为：`插件 → Web OAuth → 插件 localhost 回调 → 领取用户和设备凭据、启动 Connector → 带 connectorId 重定向 Web onboarding → 配置全部可添加 Agent → 可选手机下载/扫码 → 完成页`。token 留在本机，URL 中的 connectorId 仅用于定位，Web 仍校验当前用户的设备权限。

## 4. 规划目录

```text
dsh-bridge-next/
├── DEVELOPMENT_PLAN.md
├── ONBOARDING_PLAN.md
├── package.json
├── cordis.patch.yml
├── src/
│   ├── contracts/              # 插件设置页与 Host 共享的接口、事件和数据类型
│   ├── host/
│   │   ├── index.ts            # 模块组装、插件注册和生命周期
│   │   ├── config.ts           # 配置校验、数据目录和运行路径
│   │   ├── rpc/                # 向插件设置页提供管理接口
│   │   ├── desktop/            # 已实现共享安装记录检测；打开 Desktop 后续接入
│   │   ├── onboarding/         # 模式检查、OAuth 回调、设备上线后的 Web 交接
│   │   ├── account/            # 无 Desktop 时的账号、设备和凭据管理
│   │   ├── connector/          # 无 Desktop 时的源码 Connector 进程管理
│   │   ├── storage/            # 通用配置、凭据及文件读写能力
│   │   └── dsh-runtime/
│   │       ├── index.ts        # DSH 运行时模块的组装与释放
│   │       ├── server.ts       # 本机端点、连接与鉴权
│   │       ├── router.ts       # 协议校验、请求分发和错误响应
│   │       ├── history.ts      # 原始日志到统一 Timeline 的纯转换
│   │       ├── tools.ts        # 工具分类、结果与嵌套调用
│   │       ├── identity.ts     # 稳定 ID 与跨语言内容哈希
│   │       ├── capabilities.ts # 读取、纯文本发送及中断能力
│   │       ├── errors.ts       # 稳定错误码与错误内容过滤
│   │       └── types.ts        # 共享线协议的 TypeScript 数据形状
│   └── client/                 # 设置页、界面状态缓存和 Host 调用
├── scripts/                    # 开发构建、安装检查和发布辅助
└── tests/                      # 业务规则、协议、真实组合及回归样本
```

目录按实际实现逐步建立。`dsh-runtime` 内部可以按业务拆分文件，但对外仍由同一个插件提供稳定协议。

`host/desktop/`、`host/onboarding/` 已建立；Web 专门页面位于 `web-next/src/components/onboarding/`。Desktop 的专门页面和唤起能力后续接入；两种模式不复制运行时业务。

`src/contracts/` 是插件内部前后端的共享约定。Python Connector 与插件之间已有的跨进程协议位于仓库根目录 `contracts/dsh-bridge/1.0/`，两者用途不同，不能再维护一份相互漂移的桥接协议。

## 5. 协议与状态归属

- 以现有桥接协议、请求方法和测试样本作为迁移基线，核对字段、错误码、ID、顺序和通知语义。
- DSH 的内部类型和事件变化由插件吸收，对外尽量维持原有含义。
- 必须进行不兼容变更时，明确协议版本和两端迁移方式，不能在同一版本中静默改变语义。
- DSH 会话数据仍由 DSH 原生持久化管理；插件只保存自己拥有的关联、幂等及必要同步元数据。
- 每类状态只有一个维护者：DSH 会话以 DSH 为准；Connector 运行状态根据进程和真实反馈更新；设置页缓存用于展示。
- 已安装 Desktop 时，账号、设备和 Connector 状态以 Desktop 为准；未安装时由插件拥有。检测到安装状态变化不等于可以自动接管另一个进程。
- 共享本机记录固定为 `<操作系统用户主目录>/.agentsanywhere/machine.json`，包含安装信息与有序的本机 Connector ID 历史。Desktop 每次启动检查路径，正确则不重写；只在创建新本机设备时追加 ID。插件 OAuth 后将共享 ID 与当前用户设备列表匹配，取本地顺序中的第一个，换取新 token 后继续引导。完整字段与兼容规则见[共享记录契约](../contracts/local-machine/1.0/README.md)。

“后续只更新插件”以协议兼容为前提。新功能超出现有 Connector 协议表达范围时，仍可能需要两端配合更新。

## 6. 首次迁移需要做什么

第一阶段已移除 Python 中旧的原生消息转换、写操作和会话关联修补逻辑。`runtime.py` 负责协议调用、分页拼接与断线重连，`bridge/models.py` 只解码和校验插件返回的统一数据；DSH 日志解释集中在插件。

本次完成了两项工作：

1. 在新插件中实现 DSH 原生会话发现与只读历史，输出约定的数据结构。
2. 将 Python DSH 适配器收薄，保留通用接口接入和通信职责。尚未支持的写能力明确关闭。

以实际业务语义为依据逐项迁移，避免两端同时保留一套独立的 DSH 业务规则。旧代码和测试用于核对行为，不能把旧实现的所有行为直接视为正确结果。

后续首期实施涉及新插件、Web onboarding 页面和 Connector 的 DSH 薄转发适配器。认证与设备管理优先复用既有服务端能力；若回环 OAuth 契约有缺口，先明确最小改动。其他运行时不纳入本次重写。

Desktop 启动登记、本机新设备 ID 记录与侧栏设备名称排序已按用户授权接入；Desktop onboarding 页面与插件来源唤起后续实现。

## 7. 实施顺序与验收

工程骨架已完成。后续按无 Desktop 场景推进，详细验收见 [Onboarding 业务方案第 8 节](./ONBOARDING_PLAN.md#8-下一步先打通未安装-desktop-的完整链路)。

1. **入口与契约**：统一共享路径、实现只读安装检测和插件引导入口；核对 OAuth、本机设备注册及现有桥接协议。
2. **授权与上线**：完成插件 OAuth、本地回调、凭据与设备复用、内部源码 Connector 上线；作为第一个可独立验收的目标。
3. **Web 交接与配置**：回调再次跳转到带 connectorId 的 Web 独立引导页，校验设备权限、复用全部 Agent 配置内容，接通 DSH 发现和配置。
4. **手机与完成页**：页面内下载、扫码、可选跳过，完成页显示“立即体验”“下载桌面端”和官网链接。
5. **DSH 业务迁移与端到端验证**：发现与读取、官方侧栏过滤、事件同步与断线历史校准、纯文本新建续聊、中断和 `ask_user_question` 问答已实现，复用现有后端接口与平台协议。下一阶段接入附件、模型/权限目录和权限审批；详细边界见 [Runtime 同步方案](./RUNTIME_SYNC_PLAN.md)及[用户问答](./USER_QUESTIONS.md)。
6. **Desktop 接入**：启动记录和新本机设备 ID 记录已实现；继续接入专门引导页、插件来源唤起及普通首启完成标记，最后处理新旧管理模式的显式交接。

## 8. 开发约定

- 在当前分支工作；如需新分支，先告知用户。
- `desktop-workbench/` 本次获准修改侧栏设备排序、启动记录与新本机设备 ID 登记；其他 Agent 的工作继续保持原样。
- 开发使用本地链接安装和自动构建，无须每次重新生成安装包。
- 使用独立测试数据目录及匹配的 Connector 配置，避免新旧插件争用同一端点或业务状态。
- 核心 Host 逻辑支持无界面运行和测试，不依赖设置页打开或 Electron 窗口存在。
- 开发脚本默认只构建或监听；DSH、AA Server 和 Connector 的启动由用户明确发起。
- 重要节点按仓库约定提交，仅包含本任务的明确文件；保留其他 Agent 的改动和暂存状态。
