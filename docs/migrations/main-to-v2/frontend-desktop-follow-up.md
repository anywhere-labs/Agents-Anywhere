# v2 前端与 Desktop 跟进说明

更新时间：2026-09-06

当前 Desktop 状态：本文记录的 Web 配对、剪贴板、项目选择与创建、项目侧栏、
设置页和工具侧栏修复已同步到 `desktop-workbench/renderer`。Desktop 原生
标题栏、导航与 Connector 控制保留；终端改用与 Web 一致的查询和回收规则，
移除 Electron 续租与退出关闭终端的逻辑。范围和验证见文末“Desktop 同步完成”。

后续工作台布局（2026-09-06）：Web 已接入 Desktop Workbench 的标签式工具栏、
文件树、内嵌预览和会话 Review，保留 Web 原有顶部空间和侧栏外的开关。
实现边界与验证见文末“Web 工作台布局同步”。下文原有业务基线说明保留其历史范围。

后续账号变更（2026-09-05）：邮箱登录、绑定邮箱、统一 `displayName` 和服务页
Resend 配置见[邮箱账号与昵称](./email-accounts.md)。该变更覆盖 Web 和移动端，
当时不修改 Desktop；其中共享账号设置组件现已随本次 renderer 同步更新。

适用分支：`v2`

业务代码基线：`82b55a0a`（本说明编写时已推送到 `origin/v2`）

这是一份给 Web 前端组和 Desktop 维护者的说明，描述本轮已经落地的业务行为，以及各端需要如何理解和验证。它不是新的 API 迁移方案；本轮没有修改公开 REST、WebSocket 或协议 payload 的 shape。

## 先看结论

- 设备配对成功后，Server 不再偷偷创建并启动 Codex/Claude 实例。
- Web 配对窗口会停留在“配置 Agent”步骤，由用户决定跳过、配置并启动哪些 runtime。
- Connector 刚上线时，`connector.status=online` 可能先于 runtime discovery 完成；Web 会在 New Session 内做一次有界的 inventory settling，避免选项暂时为空后永久消失。
- New Session 里的设备、Agent、Model、Permission、Reasoning/Effort 在用户选择后立即写入浏览器本地 preference，不再等到会话创建成功。
- Connector 离线时，New Session 可以暂时进入“无设备”状态；同一设备重新上线并完成 catalog 加载后，会恢复 preference 中的设备、Agent、Model、Permission 和 Reasoning/Effort。
- 离线产生的空值和自动 fallback 本身不会覆盖 preference；用户主动选择会立即
  更新，创建 session 前仍会以当前有效值做最终兜底。
- 上述 preference 只属于 Web 的 New Session composer，不是 Server 数据，也不影响已有 session 的 runtime selection 更新。
- Codex runtime descriptor 现在声明单实例（`instancePolicy=single`、`maxInstances=1`）；`codexHome` 是可选配置，省略或填写空白时由 Connector 使用 `CODEX_HOME` 或 `~/.codex`。
- Desktop 的本机 Connector 控制层不需要新增 preference IPC，也不应自动创建 runtime；Workbench renderer 只应按 descriptor/schema 驱动，不得恢复平台专属默认值或多实例分支。

责任可以先按下面划分：

| 组件 | 本轮状态 | 跟进 |
| --- | --- | --- |
| `web-next` | 已实现 | 直接使用 `v2` 最新代码并运行前端回归检查。 |
| `desktop-workbench/renderer` | 本文所列共享前端改动已同步 | 保留 Desktop 自有壳层差异；发布前完成原生设备集成手测。 |
| `desktop-next` | Connector 控制层无需改业务接口 | 验证配对、重连和 Connector 状态展示，不创建 runtime。 |
| Server/Connector | 已实现连接替换保护；ownership lease 竞态仍是已知限制 | 不需要客户端新增 endpoint 或 payload 字段。 |

## 如何看到这次更新

Web 前端直接拉取 `v2` 即可看到已经落地的实现：

```bash
git fetch origin
git switch v2
git pull --ff-only origin v2
git log --oneline -10
```

重点查看 `web-next/src/components/task-composer.tsx`、`web-next/src/components/pair-device-dialog.tsx`、`web-next/src/features/dashboard/`，以及 Connector 的 Codex descriptor。`desktop-workbench/renderer` 是独立维护的复制副本；上述配对、Composer 和 runtime helper 已同步，后续维护仍应逐项保留 Desktop 集成差异。

## 业务行为变化

### 1. 配对和 runtime 生命周期

之前的流程在 Connector 成功连接后由 Server 自动配置默认 Codex/Claude。这会在用户尚未选择的情况下改变设备状态，也会让“配对成功”与“Agent 已经启动”混在一起。

现在的流程是：

```text
创建设备/完成认领
  -> Connector 上线
  -> Web 显示 Agent 配置步骤
  -> 用户选择 Done，或明确配置并启动一个/多个 runtime
  -> New Session 只展示已配置、active 且 status=running 的 runtime
```

几个边界要点：

- 点击 `Done` 不会创建 runtime。
- 选择“添加 runtime”才会调用 runtime 创建接口，并在提交配置时启动它。
- 已存在但 inactive 的 runtime 会显示“配置并启动”重试入口。
- 配置步骤期间 Connector 掉线时，配置按钮会禁用；重新上线后会自动重新读取 inventory。
- 过期的配对 claim 响应不会覆盖新的配对状态。

### 2. Connector 重连时序

Server 现在把 runtime control negotiation 与当前 Connector connection 绑定，并在旧连接失效后阻止旧连接继续发送控制请求。启动 discovery 的 inventory/status 事件会按协商结果处理；普通 timeline、session、capability 等事件不需要等待整个 discovery 完成。

因此客户端必须接受一个正常时序：

```text
Connector online
  -> runtime inventory 可能暂时为空或为 starting
  -> discovery/reconcile 完成
  -> runtime 进入 running
```

这不是新的前端 API。它只是说明为什么 Web 不能把第一次空 inventory 当成最终结果。

### 3. Server 重启时的 Connector ownership 竞态

这次排查确认了一个与 capability 数据无关的已知 Server 边界：Connector
ownership lease 当前在 Redis 中保留约 60 秒。若 Server 进程非正常退出，旧
Server 的 Pub/Sub owner channel 会先消失，但 lease 可能还在；新 Server 在
这段窗口内可能把 Connector 判为 online，随后 RPC 路由返回：

```json
{"detail":"connector owner is unavailable"}
```

这不是新的接口或 payload，也不是前端 capability schema 错误。当前实现没有
仅凭 Pub/Sub 订阅数强制删除 lease，因为短暂的 Redis 断订阅也可能表现为零
订阅，直接抢占会制造两个 owner。真正的提前接管需要独立的 owner liveness
和 fencing 协议；在该协议落地前，lease 到期仍是唯一安全的自动回收边界。

Web 和 Desktop 的处理约定：

- 将 `409 connector owner is unavailable` 视为短暂的 Connector/Server
  ownership 状态，而不是 capability 内容错误；按现有有界退避重新读取
  Connector presence、runtime inventory 或 capabilities。
- 不要因为一次 409 清空本地 runtime 配置或把 Connector 标记为永久离线。
- 不要在客户端按 `codex`、`claude` 或其他平台名称实现强制接管；服务端
  lease 重新可路由后，现有通用读取流程会恢复。
- 这条竞态目前仍可能在 Server 重启后的 lease 窗口内出现；本轮没有改变
  REST、WebSocket 或 capability payload，也没有把不安全的抢占逻辑带入
  `v2`。

### 4. Codex runtime 配置

Codex 的可运行实例策略和配置约束现在由 Connector 返回的 runtime
descriptor/schema 作为唯一来源：

- `instancePolicy=single`、`maxInstances=1`；Server 和 Connector 都拒绝第二个
  Codex 实例，但不会按平台名称在前端生成另一套规则。
- `codexHome` 不再带 `minLength`，因此配置请求可以省略该字段或传空字符串。
- Connector 校验时把空值解析为 `CODEX_HOME`，没有该环境变量时回退到
  `~/.codex`，并在实际 runtime config/resource claim 中使用规范化后的路径。
- Web 和 Workbench renderer 的创建默认值、named-instance required 字段、字段
  标题和校验文案都只读取 descriptor/schema metadata；前端不再生成隔离的
  `codexHome`、强制 `modelGateway`，也不再显示 Codex 专属的多实例标签。

这不是新的 endpoint 或 payload 字段；现有 Runtime Control 2.0
`runtimeTypes[].instancePolicy/maxInstances/configSchema` 即可表达上述行为。

## Web 前端需要理解的逻辑

### 配对窗口

主要代码：[`pair-device-dialog.tsx`](../../../web-next/src/components/pair-device-dialog.tsx)

- `agents` 是配对后的显式配置步骤，不再在 Connector online 时关闭窗口。
- 通过 Connector presence polling 处理在线、离线和重新上线。
- runtime 类型和实例通过现有的 connector runtime endpoints 读取；配置、创建和 active 操作仍然走现有 `dashboardApi` 方法。
- `agentSetupOnline=false` 时只等待重连，不发起配置/启动请求。
- 页面刷新、短暂断线和过期异步响应都不会把用户带回错误的步骤。

前端不要再添加“Connector 一上线就自动创建默认 runtime”的 effect 或初始化请求。

### New Session runtime inventory

主要代码：[`task-composer.tsx`](../../../web-next/src/components/task-composer.tsx) 和 [`new-session-runtime-inventory.ts`](../../../web-next/src/features/dashboard/new-session-runtime-inventory.ts)

New Session 只把以下 runtime 当作可选目标：

```text
configured && active && status == "running"
```

Connector 从 offline 变为 online，或首次 online 时，watcher 会：

- 立即读取每个在线 Connector 的 `/connectors/{connectorId}/runtimes`；
- 只在 inventory 为空，或存在 `configured && active` 但还不是 `running` 时重试；
- 按 `500ms -> 1s -> 2s -> 4s -> 8s` 退避，最多 6 次请求；
- 只合并仍在线 Connector 的结果，并对旧请求做失效检查；
- inventory 已稳定后停止，不会因为 dashboard 的普通 session/timeline 更新持续轮询。

因此，前端不要把 dashboard snapshot 的某一次空列表缓存成永久事实，也不要把每条实时事件都转换成 runtime inventory 请求。

### New Session preference 即时持久化

主要代码：[`task-composer.tsx`](../../../web-next/src/components/task-composer.tsx)

此前唯一的写入点在 `handleCreate`：用户改了选项但没有马上发起创建时，选择不会进入 preference。这次把写入放到各个有效选择回调中；`handleCreate` 只保留最终兜底，因此“选择”和“创建请求是否成功”不再绑定。

本地存储键仍是 `aa-new-session-preference-v1`。数据是浏览器 `localStorage`，不是 Server preference API。结构概念如下：

```json
{
  "connectorId": "conn_...",
  "agent": "rti_...",
  "selections": {
    "conn_...:rti_...": {
      "model": "sel_model_...",
      "permission": "sel_permission_..."
    }
  }
}
```

选择行为现在是同步的本地写入：

| 用户动作 | 立即保存的内容 |
| --- | --- |
| 选择设备 | 当前 New Session 的 `connectorId`，并确定该设备的 Agent |
| 选择 Agent | `connectorId`、`agent` |
| 选择 Model + Reasoning/Effort | 对应 runtime scope 的 protocol `selectionId` |
| 选择 Permission | 对应 runtime scope 的 protocol `selectionId` |

实现规则：

- 只有 enabled 且能由当前 live catalog 解析出的选项才会写入 selection ID。
- Model 与 Reasoning/Effort 保存为一个具体的 model selection ID；不要保存展示文案或 label。
- 切换设备/Agent 时保留其他 scope 的历史选择。
- `handleCreate` 仍会再写一次当前值，作为创建前的最终兜底；它不再是唯一写入点。
- 用户离开 New Session、创建请求失败、刷新页面后，最近一次有效选择仍可被下一次打开的 composer 读取。
- 这项改动只影响 New Session；已有 session 的 selection 仍按 runtime state/API 的现有流程处理。
- `localStorage` 写入是 best-effort；浏览器禁用本地存储时不应把它当成 Server 持久化成功。

### New Session preference 重连恢复

主要代码：[`task-composer.tsx`](../../../web-next/src/components/task-composer.tsx) 和
[`new-session-preferences.ts`](../../../web-next/src/features/dashboard/new-session-preferences.ts)

旧实现中 preference 本身并没有丢失。Connector 离线后，可用设备、runtime 和
catalog 变空，composer 会清空当前选择；但设备、Agent 和 selection scope 的
三个“一次性已应用”标记没有一起复位。同一个 Connector/runtime 重新上线时，
这些标记会让前端误以为 preference 已经恢复过，从而跳过第二次恢复。

现在不再用一次性标记阻止后续恢复。设备和 Agent 在可用选项变化时持续按
以下顺序对齐：

```text
当前可用的 preference
  -> 当前仍然可用的 composer 选择
  -> 第一个可用选项
  -> 空值
```

具体约束如下：

- Connector 离线时可以清空临时选择并显示“无设备”，但这个状态不会写入
  `aa-new-session-preference-v1`。
- 同一 Connector 重新上线后，只要 preference 指定的设备和 Agent 再次出现在
  inventory 中，就优先恢复它们，而不是固定选择第一个可用项。
- Model、Reasoning/Effort 和 Permission 沿用 composer 原来的 catalog fallback：
  先保留当前仍有效的选择，否则选择 enabled 的默认项，再选择第一个 enabled
  项，最后才为空。live catalog 加载完成后，如果保存值仍能解析且 `enabled`，
  preference 恢复 effect 会覆盖上述临时 fallback；Reasoning/Effort 还必须属于
  恢复后的 Model。
- 自动对齐到空值或 fallback 的动作本身不会持久化。如果用户随后直接使用当前
  fallback 创建 session，创建前兜底会把当时的有效选择保存为新 preference。
- 用户主动改选设备、Agent、Model、Reasoning/Effort 或 Permission 时，新值仍
  立即持久化；后续重连以用户最后一次选择为准。

这项修复没有修改 REST、WebSocket、协议 payload、Server preference 或
Connector 行为，也没有按 Codex、Claude 等平台名称增加特判。它只影响 New
Session composer；已有 session 的 selection 流程保持不变。

## Desktop 同步范围

这里要区分两个 Desktop 代码面：

- `desktop-next` 是独立的 Electron Connector 控制器，负责本机进程、配对和重连。
- `desktop-workbench/renderer` 是一份手工 vendored 的 Web renderer，负责在 Desktop 窗口里展示 New Session、配对和 session UI。

### Desktop Workbench 共享代码

截至 2026-09-06，`desktop-workbench/renderer` 已同步下列共享配对与 New Session 主流程，保留 Desktop 自有集成层。后续更新应继续核对这些入口：

- `src/components/task-composer.tsx`
- `src/features/dashboard/new-session-preferences.ts`
- `src/features/dashboard/new-session-runtime-inventory.ts`
- `src/components/pair-device-dialog.tsx`
- `src/features/dashboard/connector-presence.ts`
- `src/components/runtime-config-dialog.tsx`
- `src/components/runtime-instance-name-dialog.tsx`
- `messages/en.json` 和 `messages/zh-CN.json` 中本轮 pairing 文案
- `test/task-composer-preferences.test.mjs`
- 对应的行为与静态契约测试；renderer 已提供 `yarn test`，同时运行 `yarn typecheck` 和 `yarn protocol:check`。

其中 runtime descriptor 规则与对应测试沿用已有实现；配对、Composer、
inventory/presence 和 preference 测试已补齐。当前行为：

- 配对进入显式 `agents` 配置步骤，Connector online 不会直接关闭对话框。
- Connector 离线时配置/启动按钮禁用，重连后重新加载 runtime inventory。
- New Session 在 Connector online/discovery 竞态下能补载 runtime 选项。
- New Session 设备、Agent、Model、Permission、Reasoning/Effort 选择后立即写入 `localStorage` preference。
- Connector 离线时显示“无设备”，同一 Connector 重连并加载完 catalog 后恢复上述 preference，且离线空值或 fallback 不覆盖它。

不要整目录覆盖 `desktop-workbench/renderer`。必须保留 Desktop-owned 差异，包括 `useIsMobile`、Desktop shell/header/sidebar、Electron bridge、嵌套 workspace 的 Next 配置、端口和窗口拖拽区域。仓库已有说明见 [`desktop-workbench/README.md`](../../../desktop-workbench/README.md)。

### 本轮不需要新增的接口/功能

- 不需要新增或修改 Desktop 与 Web 之间的 preference IPC。
- `desktop-next` 主进程不需要保存或桥接 `aa-new-session-preference-v1`；Desktop
  Workbench renderer 仍按 Web 的浏览器 `localStorage` 逻辑读写它。
- `desktop-next` 不需要增加 runtime 创建 UI，也不需要在 Electron 主进程中创建默认 Codex/Claude runtime。
- 不需要因为本轮 preference 改动修改 Connector 配置文件格式或公开 endpoint。

### `desktop-next` 发布/验证时必须确认的事

1. Desktop 启动的是 Connector，不是 runtime 实例；配对完成后不要额外调用 runtime create/start。
2. 使用与 `v2` Server 兼容的 Connector 构建产物，确认 Connector 能在短暂断线后自动重连。
3. Desktop 自身仍应验证现有 `connector:state`、`connector:pairing` 事件和日志展示；本轮没有改变这些桥接消息的 shape。

### Desktop Workbench 集成验证

1. 配对后把 Workbench 页面保持在 Agent 配置步骤，验证用户点 `Done` 时设备仍可连接但没有被隐式创建的 runtime。
2. 在 Workbench 中手动添加并启动 runtime，然后断开/恢复 Desktop Connector，确认 Web renderer 能重新发现该 runtime，且不会产生重复实例。
3. 选择 New Session 的 Model/Permission/Reasoning 后离开页面再回来，确认 vendored renderer 的 `localStorage` preference 已即时保存。
4. 让 Connector 离线，确认 composer 显示“无设备”；重新连接同一 Connector，
   等 runtime inventory 和 catalog 加载完成后，确认设备、Agent、Model、
   Reasoning/Effort 和 Permission 都恢复到断线前的 preference。

`desktop-next` 当前入口仍是 [`desktop-shell.tsx`](../../../desktop-next/src/components/desktop-shell.tsx) 和 [`connector-rpc.ts`](../../../desktop-next/src/lib/connector-rpc.ts)。Workbench 的同步入口和保留规则见 [`desktop-workbench/README.md`](../../../desktop-workbench/README.md)。如果后续要在 Desktop 增加 runtime 管理 UI，应复用 Server 的 connector runtime management API，而不是在 Electron 主进程里写一套默认创建逻辑。

## 前端组手测路径

建议在干净的浏览器 profile 或清除旧的 `aa-new-session-preference-v1` 后执行：

1. 打开 New Session，此时没有在线设备；确认 composer 不会永久卡在空选项。
2. 启动或重新连接 Desktop Connector；等待 runtime discovery 完成，确认设备/Agent/Model/Permission 选项出现。
3. 先选择一个 Agent，再选择 Model、Reasoning/Effort 和 Permission；不发送消息，离开当前页面。
4. 再次打开 New Session，确认上次有效选择被恢复；打开 DevTools 的 Application/Local Storage 可看到写入发生在每次选择之后。
5. 创建一次 session，确认请求中的 `selections` 使用 protocol `selectionId`，而不是显示名称。
6. 在配置步骤中选择 `Done`，确认不会凭空多出 Codex/Claude runtime；需要的 runtime 必须由用户明确添加并启动。
7. 选择一组非默认的设备、Agent、Model、Reasoning/Effort 和 Permission，然后让
   Connector 离线；确认 composer 显示“无设备”，且 Local Storage 中保存的
   preference 没有被空值或 fallback 覆盖。
8. 重新连接同一 Connector；等待 runtime inventory 和 catalog 加载完成，确认
   五类选项都恢复到断线前的 preference，并且没有产生重复请求风暴。
9. 主动改选另一组可用选项，再重复一次断线和重连；确认恢复的是新的
   preference，而不是第一次保存的旧值。

## 验证命令

```bash
cd web-next
corepack yarn test          # 64 passed
corepack yarn typecheck
corepack yarn protocol:check
corepack yarn lint
```

本轮受影响的回归测试已通过：Connector Codex/runtime-control 共 `202 passed`，
Server runtime/connector RPC 共 `69 passed`（另有 1 个现有 deprecation warning），
Web `64 passed` 且 typecheck、protocol check、lint 通过。以上为原业务基线的
历史验证记录；2026-09-06 的 Desktop 同步验证见文末，已覆盖重连 preference。

本轮没有修改 Android，也没有要求 Android 跟进。

Desktop Workbench 后续同步时执行：

```bash
cd desktop-workbench
yarn test:main
yarn renderer:typecheck
yarn workspace agents-anywhere-desktop-renderer test
yarn workspace agents-anywhere-desktop-renderer protocol:check
```

## 代码提交范围

与本说明直接相关的提交：

- `fb5d4115`：移除 Server 配对后的默认 runtime 创建。
- `e4cf99f2`、`227676d6`、`ad1d3a2b`：恢复并稳定 Web 显式 Agent 配置/重连流程。
- `f0c67237`、`33617ef0`：修正 Connector runtime negotiation、重连和旧连接隔离。
- `f6de53c4`：修复 New Session 在 online/discovery 竞态下丢失 runtime 选项。
- `23d2d188`：让 New Session 选择在用户操作后立即持久化。
- `52979225`：让 Codex descriptor 声明单实例并允许空 `codexHome`；移除前端
  按 Codex 名称生成的多实例/必填逻辑；保护 Connector 重连期间的替换连接不被
  旧心跳清理。
- `82b55a0a`：让 New Session 在 Connector 重连并重新加载 catalog 后恢复已保存
  的设备、Agent、Model、Reasoning/Effort 和 Permission，同时避免临时 fallback
  覆盖 preference。

以上业务提交已连续合并在 `v2`。本说明随后作为文档提交加入同一分支；请以前端组实际拉取到的 `origin/v2` HEAD 为准。

## Web 工作台布局同步（2026-09-06）

改动直接落在 `v2`，参考 `desktop-workbench/renderer` 的工作台交互。
本轮不修改 Desktop、Server、Connector 或移动端原生代码，不新增依赖。

- Web 不增加原生标题栏。左侧导航从页面顶部开始，现有页面标题行与右侧工具
  标签行对齐；侧栏开关由 `WorkspaceSidebarControl` 在主内容区统一挂载。
  页面原有开关位置保留占位，工具最大化或会话加载时仍有可操作的入口。
- 左侧导航保留现有项目、置顶、最近会话分组，同步展开/收起动画；动画期间
  保持内部列表宽度，拖动调整宽度时关闭动画，并尊重减少动态效果的设置。
- `SessionToolSidebarStateProvider` 按账号隔离内存状态，工具宿主在页面切换时
  保持挂载。每个会话保存标签、当前标签、宽度、终端和文件编辑状态，支持
  临时会话 ID 到服务端 ID 的迁移；终端刷新恢复通过下述设备查询实现，
  未保存文件编辑仍只保留在当前页面内存中。
- 窄屏或主内容可用宽度不足 720px 时，工具覆盖整个主内容区；保留左侧开关
  的位置与工具收起入口。文件/Review 面板自身宽度不足 480px 时上下排列预览
  和目录树，选中文件后可收起目录树。
- 文件标签支持目录树、内嵌预览、编辑与保存。关闭未保存文件或切换文件前
  使用确认弹窗；重复选择同一文件不会清除未保存状态，凭据刷新不会重载编辑器。
- Review 展示会话每轮操作产生的文件变更，包含消息内摘要、当前轮次提示和
  右侧 diff；从 Review 打开文件进入工具标签。更早的变更按需读取会话历史，
  使用 timeline reset version 防止把已重置的历史混回当前会话。
- 终端使用现有浏览器 WebSocket 与 Connector 的普通终端生命周期，不接入
  Electron 的持久化租约、退出钩子或本机 Connector 识别。首次打开先查询
  当前设备的终端，按工作目录精确过滤并恢复，确实没有时才创建；已有终端后
  再点新增仍创建一个新终端。显式关闭标签调用终端关闭 API，创建请求返回前
  主动关闭标签时也清理该新终端。刷新、离开页面或退出账号不关闭远端进程。

迁移时保留 Web 的 `session-event-state.ts` 去重/恢复逻辑、配对流程、账号入口、
归档会话和公开分享实现。`FilePreviewSurface` 同时服务工具标签与独立预览，
保留 iOS 的 `/#/preview?previewToken=...` 路由和只读边界；所有现有复制入口
继续使用兼容剪贴板，并且只在复制成功后显示成功状态。

验证包括 150 项 Node 单元测试、TypeScript 与协议生成检查，以及 Chrome/WebKit
的 40 项无头布局与交互检查：侧栏开关、工具展开/收起、文件未保存确认、会话
与账号切换、终端创建/关闭、窄屏布局和尺寸变化。另有 26 项剪贴板场景，覆盖
API 缺失、权限拒绝、复制失败、编辑内容和 iOS 使用的 scoped preview 路由。
浏览器布局验证使用模拟会话数据、编辑器和终端连接；没有启动开发服务器，
没有执行真实设备连接或 iOS 真机验证。

### Web 视觉基线恢复（2026-09-06）

用户确认的视觉基线是 `ea6bb902`：合并 PR #51 之前实际运行的 Web。
后续同步功能时应沿用该版本的字号、间距和留白，不以当前 Desktop 或
`_reference/demo-shadcn` 的更早原稿作为 Web 样式基准。

- 侧栏顶部恢复 16px 上/左右内边距、8px 下内边距，“新会话”恢复 40px 行高
  与加号图标；手机连接入口使用相同操作行样式。分组标题恢复 12px，筛选与
  全部已读操作回到标题旁。设备名保持 13px 等宽字体，会话名保持 14px，
  两类列表行均为 32px；项目分组、折叠与分页行为保留。
- 配对选项恢复图标和标题同行、描述另起一行的排版：16px 图标，14px 文字，
  上下 12px、左右 16px 内边距，文字间距 2px。弹窗仍为历史版本的 672px
  宽度上限，只将入口标题保留为用户要求的 18px；新的配对步骤和剪贴板处理保留。
- 文件树使用原 Web 文件列表的 32px 行高与 13px 等宽名称。审阅摘要复用
  原工具消息的紧凑字号和间距，去掉单独占位的大图标区域。
- 工具标签栏从 56px 收至 48px，通过上内边距保持按钮与会话标题原有的垂直
  对齐；文件路径栏从 48px 收至 36px，消除两层留白叠加造成的空带。标签
  按钮仍为 32px，路径字号和编辑工具栏保持原尺寸。
- 工具侧栏为空时，审阅、终端、文件使用三张纵向排列的小卡片，整体最大
  宽度 288px、卡片间距 8px。每张卡片包含 16px 图标、14px 标题与 12px
  简短说明，圆角沿用侧栏列表的 `rounded-xl`（当前主题为 14px），表面样式
  复用现有 Card；整张卡片支持点击和键盘打开。
  高度不足时允许滚动，保证三个入口均可到达。

验证使用历史提交中的侧栏和配对组件，对照当前组件的浏览器计算样式，包含
字体、字重、字号、行高、内边距、选项排列和弹窗宽度。两组验证均加载项目
实际的 Geist、Geist Mono 与 Caveat 字体。另通过 TypeScript、11 项配对定向
测试、40 项工作台交互检查，以及 Chrome/WebKit 320px、390px 配对布局、
新配对流程和 HTTP 剪贴板回退验证。浏览器仍使用模拟账号与接口，未启动本地服务。

工具顶部间距调整另通过 TypeScript 与 Chrome/WebKit 的 1440px、390px
无头验证：顶部按钮位置不变、两栏连续排列、路径无溢出，文件树开关、工具
全屏与侧栏收起均可用。

空状态卡片另通过 Chrome/WebKit 的 6 组中英文、深浅色与宽窄/短屏检查，
覆盖圆角与字号、整卡点击、键盘打开及关闭后回到入口；TypeScript 检查通过。

### Web 终端生命周期与刷新恢复（2026-09-06）

新工具侧栏沿用合并 Workbench 前 `TerminalPanelBody` 的查询与普通终端语义。
原迁移遗漏了终端列表查询，并在账号卸载时增加了关闭进程的行为，本轮已修正。

- `session-terminal-lifecycle.ts` 复用现有 `connectorTerminalListV2`、创建与
  关闭 API。设备和工作目录是查询范围，同一目录下不同会话可查看同一终端，
  已退出但尚未回收的记录也保留。关闭同一个终端后，同设备的其他会话视图
  同步移除对应标签，并忽略尚未返回的旧查询中已经关闭的记录。
- 浏览器仅保存按服务端、账号隔离的侧栏偏好：会话、设备、工作目录、开合、
  宽度与所选终端 ID。进入有记录的会话时重新查询设备，再用实际返回的终端
  建立 WebSocket 并接收已有输出回放；不缓存进程、输出或凭据，不把本地
  记录当作终端仍然存活的依据。终端偏好读写失败不会阻塞手动打开时的查询。
- 自动恢复查不到终端时移除过期偏好，不自动创建替代进程。查询失败保留错误，
  再次打开或浏览器恢复联网时可重试；快速重复打开会合并正在进行的请求。
  创建期间主动关闭标签只清理该新进程，页面或账号卸载则保留进程供后续查询。
- 普通终端仍由 Connector 按现有规则回收，默认空闲 30 分钟、退出记录保留
  15 分钟；不修改超时、持久化租约或 Server/Connector 协议。现有终端流的
  自动重连机制未在本轮扩展。

验证通过 Web 全部 163 项 Node 测试（新增 13 项终端生命周期与存储测试）和
TypeScript 检查。Chrome/WebKit 新增 20 项无头场景覆盖真实页面刷新后的
同一终端 ID、输出回放、活动标签、侧栏收起状态、同目录多会话关闭同步、
账号隔离、查询失败重试及设备记录过期；此前的 40 项工作台交互检查亦通过。
浏览器使用实际 Web 组件与跨刷新保留的模拟终端服务，没有启动开发服务器，
未进行真实 Connector 进程或 iOS 真机验证。本轮不修改界面样式。

### Web 项目展开状态与排序（2026-09-06）

- 侧栏项目原先只在组件内存里记录展开状态，普通项目按项目创建时间排序。
  现在每个项目和“项目”分区的展开/收起状态按服务端、账号保存在当前浏览器，
  刷新、侧栏重新挂载或切换会话/项目视图后恢复。恢复展开时调用原有项目
  会话分页查询，同一次展开不会因为实时更新或凭据刷新反复加载。
- 空项目遵循 Web 现有 `manuallyCreated` 例外：手动创建的空项目保留显示，
  自动项目仍由 `projectHasVisibleSessions` 按归档筛选与服务端计数决定可见性。
  保留置顶项目与普通项目的分区，各分区内先放手动创建且确实没有 session
  的空项目，其余按项目内最新 session 的时间倒序；同一时间再按项目创建
  时间、名称和 ID 稳定排序。空项目创建首个 session 后自动参与正常排序。
- 排序使用服务端聚合全部会话的 `ProjectView.lastActivityAt`，同时接收本地
  已知会话的新时间，避免等待下一次聚合更新。展开与否、分页或归档筛选不会
  把有历史的项目误判为空；不修改项目内会话已有的运行中优先等排序规则。

验证通过 Web 全部 172 项测试（其中 14 项为项目排序、偏好和可见性测试）
与 TypeScript 检查。
Chrome/WebKit 的 18 项无头检查覆盖空项目优先、活动时间实时排序、刷新后
展开与会话查询、分区收起、账号隔离、视图切换与凭据刷新。浏览器使用实际
侧栏组件和模拟项目数据，没有启动开发服务器；本轮只修改 Web。

### Web 设置页组件与状态标签统一（2026-09-06）

- 账号与外观原先使用手写设置分区，手机连接、资料和归档会话使用另一套
  Card 默认尺寸，并且分别限制页面宽度。现在这些分区复用 `SettingsSection`，
  内部组合现有 Card、Separator 等组件。Card 的 `settings` 变体沿用原设置页
  的 `rounded-xl`（14px）、标题区左右 24px/上下 20px 内边距、16px 半粗标题，
  普通内容左右 24px/上下 16px；其他页面的默认 Card 样式保持原样。
- 手机连接与外观使用相同的 FieldGroup、横向 Field 和 Switch 排版；连接入口
  使用设置分区的标题操作行。账号状态也复用 Badge。标题旁的操作、头像按钮
  支持换行，窄屏账号信息改为标签和值纵向排列，长邮箱可换行，避免挤出容器。
- 邮箱“已验证”和邮件服务“API Key 已配置”被拉成整行，原因是 Badge 直接
  放在纵向 Field 下，受 `*:w-full` 规则影响，`self-start` 无法限制宽度。
  两处都改为字段标题与 Badge 同行、必要时换行，保留输入框占满宽度的规则。
  修改邮箱后暂时隐藏旧邮箱状态，保存后显示返回状态，原验证与保存流程保留。

验证通过 Web 全部 172 项测试、TypeScript 与差异格式检查。Chrome/WebKit
通过 60 组布局检查，覆盖账号、外观、手机连接、归档会话和邮件服务，中英文、
深浅色、1440px/390px/320px 视口，以及长邮箱；并通过 16 项交互检查，覆盖
开关刷新恢复、连接与密码弹窗、外观切换、昵称和邮箱保存、邮箱验证码、API Key
清除及归档恢复。浏览器使用实际 Web 组件、字体与模拟接口，没有启动开发服务器。

### Web 目录模式与项目创建流程（2026-09-06）

- 新会话下方的项目/目录选择改为下划线样式，去掉四周边框与圆角，保留单条
  底部分隔线。名称、路径和下拉箭头连续排列，箭头与下划线均跟随内容宽度，
  不延伸到容器右侧；长路径在可用宽度内截断。
- 关闭项目模式（侧栏显示会话）时，恢复默认用户目录、历史会话目录和浏览
  文件系统入口，同时加入已有项目的目录，按设备过滤并按路径去重。选择目录
  只更新草稿；发送任务时先按设备和目录查找项目，缺少时取得自动创建的项目
  ID，再调用现有会话创建接口。项目模式同样默认家目录，菜单中可选其他
  项目或返回家目录，无需先手动创建或选择项目才能发送。如果家目录已有对应
  项目，直接显示并选中该项目，菜单不再重复列出相同路径的 Home 目录。
  切换到项目模式或项目列表更新时，也按设备与规范化路径显示已有项目名称。
- 新建项目表单按设备、路径、名称排列。路径使用 InputGroup，右侧按钮直接
  打开共用的文件选择器；目录名生成默认项目名，并自动补充 ` (1)` 等后缀
  避免重名，用户可修改。选择目录、编辑名称、取消都不会创建项目，提交后
  才写入。切换设备清空旧路径；从新会话中创建项目后同步设备偏好，避免
  原设备偏好覆盖新项目的选择。同目录重命名沿用现有确认流程。
- 前端复用现有 `GET /api/v2/projects` 和 `POST /api/v2/projects`：先按设备与
  目录匹配，缺少时刷新项目列表、生成不重名的名称，再创建并取得项目 ID。
  并发名称冲突时重新查询，复用已创建的同目录项目或补充数字后缀重试，最多
  尝试创建三次。创建请求的可选 `manuallyCreated` 默认保持 `true`；自动创建
  传 `false`，复用已有项目时保留其名称与手动创建标记。原接口继续校验设备
  归属、撤销状态与绝对路径。会话请求仍必须携带 `projectId`，无需数据库
  迁移；Web 与 Server 应一起更新。
- 自动解析失败时保留任务草稿，重复发送不会重复创建。文件选择器的加载状态
  和请求序号保护确认路径，失败、加载中或文件目标均不能提交为工作目录。

验证通过 Web 全部 183 项测试（含 11 项目录匹配、命名与项目查询/创建测试）和
TypeScript 检查，Server 12 项项目唯一性、并发解析、归属与显示规则测试。
Chrome/WebKit 通过 12 组中英文、深浅色、1440px/390px/320px 布局检查及
48 项交互检查，覆盖直接打开文件选择器、名称生成/修改、取消与提交、跨设备
项目选择、默认用户目录、已有家目录项目去重、项目列表延迟更新、自动创建、
失败重试和模式切换。浏览器使用实际 Web
组件和模拟设备接口；Server 测试使用隔离数据库，没有启动开发服务器。


## Desktop 同步完成（2026-09-06）

本次直接在 `v2` 将上述已确认的 Web 改动同步到 `desktop-workbench`，未修改
`desktop-next`、iOS、Server 或 Connector。共享代码逐项同步，没有覆盖 renderer
整个目录，也没有新增项目解析接口。

- 配对入口使用 18px 标题、原有 672px 弹窗宽度和纵向桌面程序/命令行选项。
  桌面程序提供 GitHub Releases 与安装指引；CLI 按确认、命名、配对方式排列，
  配对码在 Token 上方。Agent 配置由全局 provider 处理，关闭等待中的配对
  弹窗不丢失在线发现，完成后也不再由 Demo 提前关闭后续配置窗口。
- 配对、预览、消息和服务配置的复制入口使用同一剪贴板回退，只在真实成功后
  提示成功。配对命令和手机登录二维码使用当前 Desktop 登录的 Server 地址，
  OAuth 指引使用对应 Web origin，避免生成 `aa-workbench://web` 内部地址。
- 新会话、工作目录与项目创建完整同步 Web 行为：内容宽度下划线与相邻箭头，
  两种模式都默认家目录，有现成项目则直接显示/复用；按设备、路径、名称填写
  新项目，通过输入框末尾的按钮直接选择目录，名称自动去重且可修改，提交后
  才创建。目录模式发起会话前复用或创建项目以取得 ID，沿用已有项目 API。
  Desktop 对空 API namespace 的代理路径补充 `/projects`。
- 项目展开状态持久化，置顶/普通分区分别按最新会话排序，仅手动创建且没有
  session 的项目优先。项目偏好和终端偏好均以实际 Server 地址、API namespace
  与账号隔离，避免多个服务端共用 Electron 的固定窗口 origin。
- 账号、外观、手机连接与归档设置复用 `SettingsSection`；邮箱验证及 API Key
  状态回到字段标题旁。侧栏字号、间距，Review 摘要、文件树及三张工具入口
  卡片沿用用户确认的 Web 基线。文件未保存确认、同文件复用、凭据刷新和
  工具尺寸变化时的状态保留同步。
- 原生标题栏仍为 44px，保留红绿灯留位、窗口拖拽、侧栏开关、前进后退、
  本机设备识别与重连提示。工具标签与标题栏对齐，路径栏紧接其下且高 36px；
  展开/恢复、侧栏收起按钮仍可操作。Desktop OAuth、HTTP/下载代理、原生
  WebSocket 地址处理和本机 Connector supervisor 保留。

### 终端由 Connector 管理

用户明确选择 Desktop 与 Web 一致：退出客户端保留终端，由 Connector 按
原规则回收。Electron 的终端登记、访问令牌保留、20 秒续租、持久化提升和
退出逐个关闭全部移除；Main/preload/renderer 不再暴露这组终端生命周期 IPC。

首次打开先查询设备终端并按目录恢复，没有可复用终端才创建；页面刷新时从
Connector 重新查询同一终端 ID、接收输出回放、恢复当前标签及侧栏开合状态。
自动恢复不创建替代进程，查询失败保留重试入口。显式关闭终端标签才调用
关闭 API，包含创建请求完成前已经主动关闭该标签的情形。同目录其他会话
同步移除已关闭终端；退出账号或窗口不主动关闭远端终端。

Connector 的普通终端默认空闲回收时间仍为 30 分钟，已退出记录保留 15 分钟。
进程能否继续运行取决于所属 Connector：独立/远程 Connector 仍在运行时按
上述规则保留；Desktop 退出仍会停止它内置的本机 Connector，所以该 Connector
中的终端也随进程结束。此次没有引入系统后台服务或改变本机 Connector 的退出规则。
旧版本已经创建的持久化终端仍按原租约到期回收，新建终端使用上述普通空闲规则。

### 同步验证

Desktop renderer 的 181 项测试、TypeScript 与协议生成检查通过；Main 的
39 项测试通过，新增覆盖退出并发、取消退出、Connector 关闭失败以及空 API
namespace 下的项目代理。全部为无头检查，不需要启动 Electron 或开发服务器。

使用实际 Desktop renderer、原生标题栏组件与模拟接口进行了 Chrome/WebKit
回归：项目流程 12 组布局与 48 项交互，设置页 60 组布局与 16 项交互，项目
侧栏 18 项、终端刷新/输出恢复 20 项、工具与文件状态 40 项，以及工具空状态
6 组布局与 4 组标题栏/路径间距检查。Chrome 另外通过 8 组配对流程与 7 组剪贴板场景。截图检查包含
原生标题栏与工具行对齐、文件路径留白、家目录项目去重和配对入口。

浏览器测试未加载 Electron 实例、真实 Connector、真实终端进程或生产账号，
编辑器/接口/终端连接使用测试替身。没有执行完整 Next 构建、安装包构建或原生
退出端到端测试；发布前仍需按上文路径完成真实 Desktop/设备集成验证。


## iOS 项目与目录模式同步（2026-09-06）

基于 `v2 / 3837d04b` 对齐 Web/Desktop 的项目与工作目录行为，不包含终端。

- “侧边栏显示会话”为客户端本地偏好，默认关闭，即默认项目模式。侧栏和
  新会话选择器共用此偏好；平铺列表包含原来属于项目的会话，活动置顶会话
  单独显示。切换模式只改变展示，保留项目、会话、置顶和草稿中的有效目录。
- 置顶项目和普通项目分别排序。只有手动创建且服务端计数、活动时间与本地
  已知会话都表明确实没有 session 的项目才优先；其余使用服务端聚合活动
  时间与本地会话活动时间的较新值，再按创建时间、名称和 ID 稳定排序。
  项目可见性独立使用手动创建标记、归档筛选和服务端计数，不从已加载页数推断。
- 项目及“项目”分区展开状态按规范化服务端地址、账号保存。恢复展开会查询
  原项目会话接口，每个仓库和归档范围首次刷新一次，普通推送不触发重复查询。
  同一账号更新凭据时更新共享 Token provider，保留仓库、分页、草稿和导航；
  账号或服务端变化仍重建隔离的客户端。登录先验证账号资料再保存新凭据。
- 新会话通过 Connector 的 `fs/list`、`root: "~"`、`path: "."` 解析设备家目录。
  保存每台设备的目录与已解析家目录，断网时可恢复；过期的异步结果不会覆盖
  其他设备或用户已选目录。按设备与目标系统的规范化路径识别项目，项目迟到、
  改名或切回项目模式时更新显示；已有家目录项目不会再重复显示 Home 入口。
- 目录模式合并当前设备的 session cwd 和 project workspacePath，按远端路径
  去重，并单独提供 Home 和文件系统入口。选择目录只修改草稿；两种模式发送
  时共用 `V2WorkspaceProjectResolver`：复用本地项目、缺少时 GET 刷新、仍缺少
  才 POST 自动项目（`manuallyCreated: false`）。仅明确的名称冲突重新查询并
  重试，最多创建三次。会话使用返回项目的真实 ID 和实际 workspacePath，
  保留既有项目名与手动标记。发送过程互斥，失败保留文本和附件，继续使用现有
  乐观消息与 clientMessageId；网络恢复不自动重放创建写请求。
- 项目表单顺序为设备、路径、名称、创建。创建要求在线设备，路径旁的图标
  打开共用文件 sheet，目录自动生成名称并跨设备去重；手动修改名称后不再
  被路径覆盖。切换设备清空旧路径，编辑已有项目只修改名称。同路径、不同名
  经系统提示确认后修改已有项目，最终提交前不登记项目或创建磁盘文件夹。
- 文件浏览和目录选择继续共用 `WorkspaceFilesSheet`，默认半屏，设备名作为
  标题，列表上方保留实际完整路径。目录选择增加路径输入和上一级入口，确认
  仅接受当前成功返回的目录；加载中、失败、文件/不存在的目标、被替代的旧请求
  都不能确认。路径规范化或解析 `~` 后使用成功结果，不使用输入字符串兜底。
- 新会话目录入口为随内容收缩的下划线布局，名称、路径、箭头连续排列。
  配对先选桌面程序或 CLI，CLI 先确认、再命名、再选配对码或 Token；设备
  上线后由用户决定配置 Agent 或稍后处理。新增文案均有英文和简体中文。

侧栏 wordmark 现在使用原生 toolbar。`NavigationSplitView` 由系统
`horizontalSizeClass` 驱动：iPad 的 regular 布局保留原生分栏动画，compact
布局使用 iPhone 抽屉，不设置窗口宽度阈值。`isTabViewSidebarAvailable` 是
TabView 的环境值，不能当作当前 NavigationSplitView 的可用性查询。

验证：205 项 iOS 核心测试、通用 iOS Simulator 目标无签名构建通过；本地化
检查覆盖 778 个 catalog 条目、190 个 Swift 文件提取出的 737 个 key，以及
参数、复数、权限文案和共享 Web 元数据。未启动模拟器、开发服务器或 Electron；
真实 iPhone/iPad 分屏切换、文件浏览、配对和远程设备交互仍需在 Xcode 中验收。

### HTTP 登录页面响应修复

HTTP 非安全上下文无法使用 SubtleCrypto 时，Web/Desktop 原来的同步
JavaScript PBKDF2 fallback 会阻塞浏览器。现在优先使用原生 WebCrypto，
否则延迟加载 `@noble/hashes@2.4.0`，以短批次异步派生并让出浏览器任务队列。
PBKDF2-SHA256 的 120,000 次迭代、盐、编码和 verifier 协议保持一致。
Web 16 项认证测试、Desktop 7 项密码派生测试及两端 TypeScript 检查通过。
该修复需要更新服务器提供的 Web 页面，仅重新编译 iOS 不会替换浏览器登录页。
未进行真实 iOS 浏览器登录计时；无 JIT 的压力测量只用于确认主线程阻塞原因，
不作为真机登录速度的结论。

## DSH 配置与图片检查（2026-09-08）

`feat/benson-0905` 已接通 DSH 官方模型、effort、权限和 Agent 模式目录，
在新建时显式初始化，支持会话内切换及 PNG/JPEG/WebP/GIF 图片发送。
Web 与 Desktop renderer 均已同步模型标签、配置选项名称/禁用原因、图片
白名单和状态回显；继续使用现有 AA 新会话偏好机制，不从 DSH 默认值覆盖。
这次没有重新替换 Desktop renderer，也没有改动其原生窗口和传输边界。

基于 `5c99b42d`，Web 219 项、Desktop renderer 205 项、主进程 90 项测试
及两端类型/协议检查通过。插件 105 项、Connector 68 项、Server 76 项检查
另见 [验证记录](../../../dsh-bridge-next/VERIFICATION.md)。这些是 headless
结果，真实模型、手机、Windows 和长期运行仍待手动验收。

### Connector 启动职责调整

后续在 `codex/connector-owned-lifecycle` 完成独立调整，不能沿用上述旧基线
宣称新代码已经验证。Python Connector 统一执行启动互斥、记录实际 PID 和
启动来源、追加本机 ID 历史，覆盖 CLI、Desktop 和插件。检查以 PID 是否仍为
对应 Connector 进程为准；RPC 进程仍存活时停止后端连接不会释放占用。

Desktop 和插件通过 `-32009 / connector_already_running` 处理冲突、提供
重试并保留私有绑定；两端不再自行检查 PID 或追加 ID。安装信息继续由
Desktop 校验和发布，插件只读。共享状态升级为 `.agents-anywhere/connector-runtime.json`
的 v2 格式，旧文件由 Python 迁移，详见 [v2 契约](../../../contracts/local-machine/2.0/README.md)。

本地插件 102 项、Connector 84 项、Desktop 主进程 85 项通过。Linux 暴露的
旧 SQLite 迁移语法问题已修复，Server 相关及完整迁移测试共 175 项通过。
当前分支 CI 另行重跑 Web 和 Desktop renderer；具体远程结果与仍需手动
验收的真实模型、手机及 Windows 行为见 [验证记录](../../../dsh-bridge-next/VERIFICATION.md)。
