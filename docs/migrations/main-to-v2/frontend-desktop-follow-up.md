# v2 前端与 Desktop 跟进说明

更新时间：2026-09-04

后续账号变更（2026-09-05）：邮箱登录、绑定邮箱、统一 `displayName` 和服务页
Resend 配置见[邮箱账号与昵称](./email-accounts.md)。该变更覆盖 Web 和移动端，
不修改 Desktop；下文关于配对和 New Session 副本差异的说明仍单独适用。

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
| `desktop-workbench/renderer` | 部分同步；配对和 New Session 主流程仍是旧副本 | 先同步下文列出的 shared renderer 逻辑，保留 Desktop 自有壳层差异。 |
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

重点查看 `web-next/src/components/task-composer.tsx`、`web-next/src/components/pair-device-dialog.tsx`、`web-next/src/features/dashboard/`，以及 Connector 的 Codex descriptor。`desktop-workbench/renderer` 是独立维护的复制副本；本轮已同步其中的 runtime helper、设备页和配置对话框，但配对和 Composer 主流程仍需要按下文清单跟进。

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

## Desktop 需要跟进什么

这里要区分两个 Desktop 代码面：

- `desktop-next` 是独立的 Electron Connector 控制器，负责本机进程、配对和重连。
- `desktop-workbench/renderer` 是一份手工 vendored 的 Web renderer，负责在 Desktop 窗口里展示 New Session、配对和 session UI。

### Desktop Workbench 必须同步的内容

当前 `desktop-workbench/renderer` 不是完整同步版本，不能只更新 Electron 主进程。本轮已经同步 runtime helper、设备页和 runtime config dialog 的 descriptor-driven 改动；仍请从 `web-next` 同步配对和 New Session 主流程，再保留 Desktop 自有集成层。至少需要核对：

- `src/components/task-composer.tsx`
- `src/features/dashboard/new-session-preferences.ts`
- `src/features/dashboard/new-session-runtime-inventory.ts`
- `src/components/pair-device-dialog.tsx`
- `src/features/dashboard/connector-presence.ts`
- `src/components/runtime-config-dialog.tsx`
- `src/components/runtime-instance-name-dialog.tsx`
- `messages/en.json` 和 `messages/zh-CN.json` 中本轮 pairing 文案
- `test/task-composer-preferences.test.mjs`
- 对应的静态契约测试；renderer 当前可以直接运行 `node --test test/*.test.mjs`、`corepack yarn typecheck` 和 `corepack yarn protocol:check`（也可以同步 `web-next/package.json` 中的 `test` script）

其中 `runtime-instances.ts`、`device-page.tsx`、`runtime-config-dialog.tsx` 和
对应测试已经按本轮 descriptor 规则更新；`pair-device-dialog.tsx`、
`task-composer.tsx` 及其 inventory/presence 逻辑仍需要单独同步。

同步后应具备以下行为：

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
Web `64 passed` 且 typecheck、protocol check、lint 通过。Workbench renderer 当前
基线静态测试为 `10 passed`，但尚未包含本次重连恢复修复；完成同步后必须重新
执行下列验证。

本轮没有修改 Android，也没有要求 Android 跟进。

Desktop Workbench renderer 同步后至少再执行：

```bash
cd desktop-workbench/renderer
node --test test/*.test.mjs
corepack yarn typecheck
corepack yarn protocol:check
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
