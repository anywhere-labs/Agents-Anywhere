# 模型配置 API

用户在任意客户端选择各设备上的 Runtime 使用哪个模型渠道（网关地址、API Key、模型列表）。模型服务来自手动填写，或来自 Tokens Anywhere 链接。设计依据见 [模型配置方案](../model-config-management-proposal.md)，Runtime 侧的契约见 [Runtime Control 2.0](../../contracts/runtime-control/2.0/README.md) 的「Maturity and model connections」一节。

所有接口都在 `/api/v2` 下，使用登录态的 Bearer token。

## 原则

- **Key 只写不读**：Key 只在创建配置或保存 Runtime 配置时传入，任何读接口和实时快照都不返回 Key，只返回 `keyHint`（开头和结尾几位）或 `secretFields` 里的 `hint`。
- **按能力渲染**：Runtime 是否接受模型连接、支持哪些协议、改动的范围和生效时机，都来自它声明的 `modelConnection`，客户端不按 Runtime 名称判断。
- **先拒绝、不忽略**：Runtime 不支持的组合在保存前就被拒绝（`model_connection_unsupported`），不会保存后静默不用。
- **已应用不等于已验证**：`applied` 表示 Runtime 已采用配置，不代表网关连通。
- **默认只改 AA 管理的实例**：`scope=native_global` 的 Runtime 会修改其自身全局配置，不跟随当前渠道（`unsupported`，原因 `confirmation_required`），只能单独指定并带 `confirmNativeGlobal: true`。
- **切换失败不丢可用性**：切换前保存快照，失败时恢复原配置，见「当前渠道与切换」。

服务器需要设置至少 32 个字符的 `AGENT_SERVER_SECRET` 才能保存手动 Key 和链接 Tokens Anywhere；没有设置时相关写接口返回 409 `secret_unconfigured`，快照中 `secretConfigured` 为 `false`。

## Runtime 上的新字段

`/connectors/{id}/runtimes` 和快照的 `runtimes[]` 增加：

| 字段 | 说明 |
| --- | --- |
| `maturity` | `experimental`、`beta`、`stable` 或 `null`；客户端显示在状态旁边，例如「Pi Beta · 运行中」，`stable` 不显示 |
| `modelConnection` | Runtime 声明的能力：`maturity`、`configField`、`modelsField`、`protocols`、`modes`、`modeField`、`scope`、`catalog`（`auto`、`manual`，以及表示必须导入模型的 `required`）、`apply`，以及可选的 `modelField`（见「Runtime 模型」）；不接受模型连接时为 `null` |
| `modelConnectionStatus` | `{state, protocol, scope, mode, reason, externalOwner}`，`state` 为 `not_configured`、`saved_pending`、`applied`、`failed`、`managed_externally` |
| `secretFields` | 已保存的只写字段，例如 `{"modelGateway.apiKey": {"set": true, "hint": "sk-gate…1234"}}` |
| `managedBy` | 由其他功能创建的实例的标记；配置管理创建的实例为 `model-config` |

`config.modelGateway` 不再包含 `apiKey`。保存 Runtime 配置时：

- 省略 `apiKey` 且地址的 host 不变，Server 保留原 Key；
- 地址换了 host 却没有提供 Key，返回 422 `secret_required`；
- 校验和 Connector 的错误信息不会包含 Key。

声明多个协议的 Runtime 在 `modelGateway` 中还需要 `protocol`。

## 模型配置

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/model-profiles` | 返回 `{secretConfigured, profiles, assignments, channel}` |
| POST | `/model-profiles` | 手动配置：`{name, apiKey, offers: [{format, baseUrl, models: [{id, name?}]}]}`，每种协议最多一个 offer；返回 201 |
| PATCH | `/model-profiles/{id}` | 需要 `If-Match: <etag>`；改了地址的 host 必须同时提供新 `apiKey`；Tokens 配置只读 |
| DELETE | `/model-profiles/{id}` | 是当前渠道、被某个 Runtime 指定或仍有 Runtime 在用时返回 409 `profile_in_use` |

`format` 为 `openai_responses`、`openai_chat` 或 `anthropic`。

`assignments` 是各 Runtime 实际在用的 AA 渠道记录（`actual` 不是 `native` 的 Runtime 各一条）：`{connectorId, runtimeId, profileId, offerFormat, createdRuntime, status, appliedAt, modelConnectionStatus}`，`status` 为 `applied`、`modified`（之后手动改过连接）或 `outdated`（渠道的模型或 Key 已变化，等待重新写入）。切换进度只看渠道状态。

## 当前渠道与切换

本功能使用 `v2_48` 数据库结构，渠道切换不保存等待空闲状态或允许中断标记，也不提供 `switch-now` 接口。

每个 Runtime 同一时间只能使用一个渠道。渠道取值：

| 值 | 含义 |
| --- | --- |
| `native` | 设备自带配置：不使用 AA 写入的模型连接 |
| `tokens` | Anywhere 渠道（当前用户已链接的 Tokens Anywhere 配置） |
| `mpr_…` | 某个手动添加的模型服务（`source=manual` 且 `state=active` 的配置 ID） |

用户选择一个**当前渠道**，所有 Runtime 默认跟随；单个 Runtime 可以单独指定渠道（覆盖）。Runtime 想要的渠道 = 覆盖 ?? 当前渠道。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/model-config/channel` | 返回渠道状态（见下） |
| PUT | `/model-config/channel` | `{channel}`；应用当前渠道并立即切换，允许中断运行中的任务；立即返回渠道状态，不等切换完成 |
| PUT | `/model-config/channel/runtimes/{connectorId}/{runtimeId}` | `{channel: string \| null, confirmNativeGlobal?: boolean}`；`null` 表示跟随当前渠道；`scope=native_global` 的 Runtime 指定 AA 渠道时必须带 `confirmNativeGlobal: true` |
| POST | `/model-config/channel/retry` | 重新尝试所有 `restored` 和 `failed` 的 Runtime；也可带 `{connectorId, runtimeId}` 只重试一个 |

错误：渠道不存在 404 `channel_not_found`；配置已断开 409 `profile_detached`；`tokens` 但未链接 409 `tokens_not_linked`；Runtime 不存在 404。

### 渠道状态

`GET /model-config/channel`、上面所有写接口和快照的 `modelConfig.channel` 返回同一结构：

```json
{
  "channel": "tokens",
  "revision": 7,
  "switch": {"revision": 7, "state": "running", "startedAt": "…", "finishedAt": null},
  "runtimes": [
    {
      "connectorId": "con_…", "runtimeId": "codex",
      "override": null, "desired": "tokens", "actual": "native",
      "state": "pending", "step": null,
      "reason": null, "message": null,
      "updatedAt": "…"
    }
  ]
}
```

- `revision` 每次修改当前渠道或覆盖时加一。
- `switch.state`：`running`（还有 Runtime 没切完）、`done`（全部到达终态且没有失败）、`attention`（有 `restored` 或 `failed`）。从未切换过时 `switch` 为 `null`。
- `runtimes` 列出用户所有 Runtime（包括不支持模型连接的），不仅是参与切换的；配置管理创建的受管实例（`managedBy=model-config`）不单独列出，它代表的本机 Runtime 那一行就是它的状态。
- `actual` 是 Runtime 当前**实际**在用的渠道，只有核实成功后才会变成新渠道；切换失败恢复后仍是原渠道。

`state` 取值：

| state | 含义 | 客户端展示 |
| --- | --- | --- |
| `applied` | `actual == desired`，已核实 | 已生效 |
| `pending` | 已排队，马上开始 | 排队中 |
| `waiting_online` | 设备离线，上线后自动切换 | 上线后切换 |
| `switching` | 正在切换，`step` 为 `preparing`、`activating`、`verifying` | 切换中 |
| `restoring` | 切换失败，正在恢复原配置 | 正在恢复 |
| `restored` | 切换失败，已恢复原渠道，Runtime 可用；`reason` 给出原因 | 切换失败，已恢复，可重试 |
| `failed` | 切换和恢复都没有成功，需要处理；`reason` 给出原因 | 需要处理，可重试 |
| `unsupported` | 不能使用想要的渠道，保持原样；`reason` 给出原因 | 不支持 |

`reason` 取值：`model_connection_unsupported`、`not_installed`、`format_unsupported`、`mode_unsupported`、`models_required`、`model_unavailable`、`confirmation_required`、`profile_unavailable`、`validate_failed`、`start_failed`、`verify_failed`、`verify_timeout`、`device_offline`、`rollback_failed`、`superseded`。`message` 是可选的说明文字，不含 Key。

### 切换流程

每个 Runtime 的切换是一个可恢复的事务，步骤和状态都保存在数据库里：

1. **排队**：修改当前渠道或覆盖后，想要的渠道和实际渠道不同的 Runtime 进入 `pending`；比当前更早的未完成切换被新的一次取代（`superseded`，不再执行）。
2. **调度**：在线 Runtime 立即执行，不等待运行中的任务结束；设备离线时进入 `waiting_online`，上线后立即执行。
3. **准备**：先把 Runtime 当前的完整配置、启用状态和应用记录加密保存为快照，再计算新配置。快照写入之前不改动 Runtime。
4. **激活**：暂停这个 Runtime 接收新任务（新建会话和发送消息会等待最多 90 秒，超时返回 409 `runtime_switching`），写入新配置并**硬替换**：停掉旧实例并等它退出，再用目标渠道的完整配置创建新实例。即使配置没有变化也会重建，不在原实例上热更新，也不复用旧实例的客户端或连接。
5. **核实**：Runtime 运行起来、回报的模型连接与目标配置一致即记为 `applied`；Connector 返回 `status: error`、启动超时或回报不一致才算失败。请求超时或结果不明时，Server 先读取 Connector 上实际生效的配置再决定。切换不发送真实模型请求，不产生探针调用费用；余额不足、鉴权失败或模型服务不可用由实际模型请求报告，不影响配置切换结果，也不触发回滚。
6. **完成或恢复**：成功后更新应用记录、恢复接收新任务；失败则写回快照里的配置和启用状态，同样重建实例并核实配置，恢复成功为 `restored`，恢复失败为 `failed`，同样恢复接收新任务。恢复结果不依赖原渠道能否完成模型请求。

切换不使用定时轮询。等待中的 Runtime 在 Redis 中记一条待处理标记（没有 Redis 时在进程内存中），由事件触发处理：这个 Runtime 上的任务结束、设备重新上线、Runtime 启动完成、有人在它上面新建会话或发送消息、客户端读取渠道状态。Server 启动时把数据库中未完成的切换重新登记一次。

Tokens 模型选择变化、轮换 Key、切换账号后，使用 Anywhere 渠道的 Runtime 也按这个流程重新写入配置（`revision` 加一，渠道不变）。

新建会话和获取模型目录时，如果这个 Runtime 还有待处理的切换且现在可以执行，会先执行并等待它完成（最多 90 秒）；切换失败并已恢复时，会话继续使用原渠道，不报错。

Connector 2.2.0 起在 `runtime.discover` 结果中声明 `switchFence` 和 `modelProbe`（渠道切换不调用模型探针）。Server 只对声明了 `switchFence` 的 Connector 在 `runtime.validateConfig`、`runtime.start` 中带 `operationId` 和 `switchRevision`：Connector 拒绝比已接受的更早的 `switchRevision`（`switch_revision_stale`），带这两个字段的 `runtime.start` 总是硬替换实例，并在启动结果中回报实际加载的 `configDigest` 和进程标识 `instanceId`。声明了 `modelProbe` 的 Connector 支持独立的 `runtime.probeModelConnection`，不作为切换或恢复的成功条件。旧版 Connector 由 Server 读取 `runtime.config` 核实。

外部管理的实例不在切换的保证范围内，例如 Codex App 自己持有的线程、本机独立运行的 Pi。要保证切换生效，让会话交给 AA 管理的实例执行。

## Runtime 模型

声明了 `modelConnection.modelField` 的 Runtime（目前为 Codex、Claude Code 和受管环境的 Pi，字段名都是 `model`）可以在配置里记录新会话使用的模型：`model: {modelId, effortId?}`，与 `modelGateway` 并列。没有声明的 Runtime 不显示这项设置。

- **只影响新会话**：新建会话时客户端没有选模型，Connector 就把这个模型写进该会话自己的选择；之后改设置，已有会话的模型不变。会话里仍然可以手动切换模型。
- **必须是已配置的模型**：接入了模型连接时，`modelId` 必须是 `customModels` 里的模型，否则 Runtime 拒绝保存；没有接入时取 Runtime 自己的模型目录。
- **不重启**：只改 `model` 时 Runtime 不会重启，也不会打断任务。Codex 和 Claude Code 刷新模型目录；Pi 改写 AA 私有配置里的 `defaultModel`，下一个会话起生效。
- **目录标记**：模型目录里对应的那一项 `default` 为 `true`，各端新建会话时会预先选中它。

启用了模型连接的 Runtime 返回的模型目录只展示它实际所在渠道当前启用的模型，保留 Runtime 原生的模型选择标识和目录 revision（与查询或分页一样，仅投影可见模型，不改变 Runtime 的目录）。模型与推理强度继续在输入框中选择。Web 和 Desktop 在 Runtime 实际渠道为 `tokens` 且状态为 `applied` 时，在输入框的模型选择前显示 Anywhere 图标。Pi 自动复用或创建隔离的受管实例，不覆盖本机 Pi；渠道改回 `native` 后新会话回到本机实例。

写入渠道配置时：

- Runtime 原有的 `model` 设置如果仍在新的模型列表里就保留，否则删除，回到 Runtime 自己的选择；关闭 Tokens Anywhere 模型后的重新写入也按这条处理。
- 切回 `native` 时，指向导入模型的设置随导入的模型一起删除；指向 Runtime 自带模型的设置保留。
- `model` 不计入核实用的配置摘要，单独修改默认模型不会触发切换。

已有会话在换渠道之后：Codex 接入网关后恢复线程时，如果会话没有显式选择，会带上线程最近一次使用的模型（不带的话 Codex 会改用 `config.toml` 里的模型）；Claude Code 没有显式选择的会话仍使用 Claude Code 当前的默认模型；Pi 沿用会话里保存的模型。会话里的模型在新渠道不存在时，请求会失败，需要在会话里重新选择。

## Tokens Anywhere 链接

Tokens Anywhere 是 OAuth 授权服务器，每个 AA 实例是公共 PKCE 客户端 `agents-anywhere`，以 origin 区分。Tokens Anywhere 地址是实例设置，默认取环境变量 `AGENT_SERVER_TOKENS_URL`，必须与 Tokens 的 `TOKENS_PUBLIC_ORIGIN` 完全一致（回跳的 `iss` 按它校验）；回调地址用 `AGENT_SERVER_PUBLIC_ORIGIN` 拼出。同步模型时，网关地址取 Tokens `GET /api/v1/status` 返回的 `apiBaseUrl`，没有时用 Tokens 地址。Tokens 必须设置 `TOKENS_SECRETS_KEY`：否则托管 Key 的明文只在创建时返回一次，AA 之后每次应用都要重新取回，会得到 409 `key_not_kept`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/integrations/tokens` | `{available, tokensUrl, secretConfigured, link}` |
| POST | `/integrations/tokens/link` | 返回一次性的 `startUrl`（60 秒有效）；已绑定时用于切换账号 |
| GET | `/integrations/tokens/start?ticket=` | 浏览器打开；把链接绑定到这个浏览器的 cookie 后跳到 Tokens 授权页 |
| GET | `/integrations/tokens/callback` | Tokens 回跳；校验 state、浏览器 cookie 和 `iss`，换取 token，首次绑定同步模型、切换账号保存绑定并排队更新 Key 后跳到 `{Tokens}/oauth/done/`；失败时跳回 `/?tokensLink=<code>#/settings/model-configs` |
| POST | `/integrations/tokens/sync` | 重新读取托管 Key 能用的模型，更新 Tokens 配置 |
| DELETE | `/integrations/tokens/link` | 撤销授权并删除链接；还有 Runtime 想要或实际在用 `tokens` 时返回 409 `channel_in_use`，需要先切换到其他渠道 |
| POST | `/model-profiles/{id}/rotate-key` | `{allowInterrupt}`；轮换托管 Key，再按切换流程把新 Key 写入所有使用 Anywhere 渠道的 Runtime。旧 Key 立即失效，所以有任务运行且没有 `allowInterrupt: true` 时先返回 409 `busy`，不轮换 |
| GET、PUT | `/admin/integrations/tokens` | 管理员读取或修改 Tokens Anywhere 地址：返回 `{tokensUrl, source, linkedAccounts, secretConfigured}`，`source` 为 `setting`、`environment` 或 `null`；PUT `{tokensUrl}`，空值关闭；有账户已链接时不能改成别的地址（409 `tokens_links_exist`），地址带路径时返回 422 `invalid_tokens_url` |

### 切换账号

四端的「切换账号」直接打开现有授权页，用户可选择其他账号后授权。取消授权、获取新 Key 或读取新账户失败时，原绑定保持可用；同一次授权发起后若账户已被另一授权替换，旧回调会被拒绝。

切换时在同一事务中替换绑定、更新原 Tokens 配置的 Key 标识，并让使用 Anywhere 渠道的 Runtime 重新走一次切换流程写入新 Key。网关地址、模型目录、当前渠道、别名、默认模型、实例启用状态和会话不变；不调用解绑接口，也不撤销旧账号授权，以免影响尚未切换的任务。旧授权可在 Tokens Anywhere 的已连接应用中管理。

在线 Runtime 立即写入并重建，运行中的任务会被中断；离线设备上线后写入，失败时恢复原配置并可重试；客户端在渠道状态里看到每个 Runtime 的进度。

### 账户、用量与模型选择

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/integrations/tokens/account` | `{account: {id, displayName, email}, balance: {balance, available, held, bonus}, links: {console, billing, usage}}`。金额是 Tokens Anywhere 给出的人民币元字符串（4 位小数），客户端只做展示，求和时按 0.0001 元的整数计算 |
| GET | `/integrations/tokens/usage?days=` | `days` 为 1–92，默认 30。返回 `{from, to, items}`，`items` 是整个 Tokens 账户按北京时间日期和模型统计的已结算用量：`date`、`model`、`requests`、`inputTokens`、`outputTokens`、`cacheReadTokens`、`cacheWrite5mTokens`、`cacheWrite1hTokens`、`amountCharged`；没有请求的日期不返回 |
| PUT | `/integrations/tokens/models` | `{disabled: [模型 ID], names: {模型 ID: 名称}}`，关闭模型或改名，只影响 Agents Anywhere。返回 `{applying}`：为 `true` 时使用 Anywhere 渠道的 Runtime 按切换流程重新写入，进度在渠道状态里 |

Tokens 配置的 `offers` 始终是 Tokens 给出的完整模型目录，模型带 `vendor`、`contextWindow`、`maxOutputTokens`（来自 Tokens 价格表，可能为空）；配置另有 `preferences: {disabled, names}`。写入 Runtime 时 Server 先去掉关闭的模型、换上新名称；某种协议的模型全部关闭时，这种协议不再提供给 Runtime。同步模型目录时保留 `preferences`。

### 授权页

客户端在完成授权的浏览器里打开 `startUrl`：Web 在用户点击时先创建浏览器小弹窗，获取地址后在弹窗中导航，弹窗被拦截时回退到当前页；Desktop 用系统浏览器，Android 用 Custom Tabs，iOS 用 `ASWebAuthenticationSession`。客户端不接收回调，链接结果通过实时快照得知；Web 在快照显示已链接后关闭授权弹窗，用户取消或请求失败时也会关闭弹窗；iOS 在快照显示已链接后主动结束授权会话。

Server 保存加密的 refresh token，access token 放在 Redis（没有 Redis 时在内存）；刷新在数据库行锁下串行进行，结果不明时在持锁期间重试一次。刷新得到 `invalid_grant` 时链接变为 `reauth_required`。每天的后台任务会刷新 30 天没用过的链接，避免闲置过期。

## 实时快照

`dashboard.snapshot` 增加 `modelConfig`：

```json
{
  "secretConfigured": true,
  "profiles": [{"id": "mpr_…", "source": "tokens", "name": "Tokens Anywhere", "originHost": "tokens.example", "offers": [], "keyHint": "sk-aa-se", "strategyName": "Default", "state": "active", "etag": "1", "updatedAt": "…"}],
  "assignments": [{"connectorId": "…", "runtimeId": "codex", "profileId": "mpr_…", "offerFormat": "openai_responses", "createdRuntime": false, "status": "applied", "error": null, "appliedAt": "…", "modelConnectionStatus": {"state": "applied"}}],
  "channel": {"channel": "tokens", "revision": 7, "switch": null, "runtimes": []},
  "tokens": {"available": true, "tokensUrl": "https://tokens.example", "secretConfigured": true, "link": {"status": "linked", "issuer": "https://tokens.example", "account": {"id": "42", "displayName": "Ada", "email": null}, "linkedAt": "…", "relinkSoon": false}}
}
```

配置、渠道、切换进度、链接状态的变化都会触发 `dashboard.changed`，所有在线客户端随下一份快照更新。

启动后才应用连接的 Runtime 通过 `runtime.statusChanged` 的 `modelConnection` 回报结果；Server 只在已存的报告对应当前保存的连接时采用它，避免还在用旧配置的实例被误报为「已应用」。

所有渠道切换（应用渠道、单个 Runtime 变更、模型或 Key 更新、重试与重启恢复）均不等待任务结束；在线 Runtime 立即重新加载配置，运行中的任务会被中断，离线设备上线后立即执行。
