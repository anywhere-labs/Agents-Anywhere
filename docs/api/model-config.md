# 模型配置 API

用户在任意客户端把模型服务（网关地址、API Key、模型列表）应用到各设备上的 Runtime。模型服务来自手动填写，或来自 Tokens Anywhere 链接。设计依据见 [模型配置方案](../model-config-management-proposal.md)，Runtime 侧的契约见 [Runtime Control 2.0](../../contracts/runtime-control/2.0/README.md) 的「Maturity and model connections」一节。

所有接口都在 `/api/v2` 下，使用登录态的 Bearer token。

## 原则

- **Key 只写不读**：Key 只在创建配置或保存 Runtime 配置时传入，任何读接口和实时快照都不返回 Key，只返回 `keyHint`（开头和结尾几位）或 `secretFields` 里的 `hint`。
- **按能力渲染**：Runtime 是否接受模型连接、支持哪些协议、改动的范围和生效时机，都来自它声明的 `modelConnection`，客户端不按 Runtime 名称判断。
- **先拒绝、不忽略**：Runtime 不支持的组合在保存前就被拒绝（`model_connection_unsupported`），不会保存后静默不用。
- **已应用不等于已验证**：`applied` 表示 Runtime 已采用配置，不代表网关连通。
- **默认只改 AA 管理的实例**：`scope=native_global` 的 Runtime（如 DSH）会修改其自身全局配置，应用时必须带 `confirmNativeGlobal: true`。

服务器需要设置至少 32 个字符的 `AGENT_SERVER_SECRET` 才能保存手动 Key 和链接 Tokens Anywhere；没有设置时相关写接口返回 409 `secret_unconfigured`，快照中 `secretConfigured` 为 `false`。

## Runtime 上的新字段

`/connectors/{id}/runtimes` 和快照的 `runtimes[]` 增加：

| 字段 | 说明 |
| --- | --- |
| `maturity` | `experimental`、`beta`、`stable` 或 `null`；客户端显示在状态旁边，例如「Pi Beta · 运行中」，`stable` 不显示 |
| `modelConnection` | Runtime 声明的能力：`maturity`、`configField`、`modelsField`、`protocols`、`modes`、`modeField`、`scope`、`catalog`（`auto`、`manual`，以及表示必须导入模型的 `required`）、`apply`；不接受模型连接时为 `null` |
| `modelConnectionStatus` | `{state, protocol, scope, mode, reason, externalOwner}`，`state` 为 `not_configured`、`saved_pending`、`applied`、`failed`、`managed_externally` |
| `secretFields` | 已保存的只写字段，例如 `{"modelGateway.apiKey": {"set": true, "hint": "sk-gate…1234"}}` |
| `managedBy` | 由其他功能创建的实例的标记；配置管理创建的实例为 `model-config` |

`config.modelGateway` 不再包含 `apiKey`。保存 Runtime 配置时：

- 省略 `apiKey` 且地址的 host 不变，Server 保留原 Key；
- 地址换了 host 却没有提供 Key，返回 422 `secret_required`；
- 校验和 Connector 的错误信息不会包含 Key。

声明多个协议的 Runtime（如 DSH）在 `modelGateway` 中还需要 `protocol`。

## 模型配置

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/model-profiles` | 返回 `{secretConfigured, profiles, assignments}` |
| POST | `/model-profiles` | 手动配置：`{name, apiKey, offers: [{format, baseUrl, models: [{id, name?}]}]}`，每种协议最多一个 offer；返回 201 |
| PATCH | `/model-profiles/{id}` | 需要 `If-Match: <etag>`；改了地址的 host 必须同时提供新 `apiKey`；Tokens 配置只读 |
| DELETE | `/model-profiles/{id}` | 仍有 Runtime 在用时返回 409 `profile_in_use` |

`format` 为 `openai_responses`、`openai_chat` 或 `anthropic`。

## 预览、应用与恢复

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/model-config/assignments/preview` | `{profileId, targets?}`；省略 `targets` 时列出用户所有 Runtime |
| POST | `/model-config/assignments` | 需要 `Idempotency-Key`；`{profileId, targets, allowInterrupt, confirmNativeGlobal, modelIds?}` |
| GET | `/model-config/assignments` | 当前的应用记录 |
| DELETE | `/model-config/assignments/{connectorId}/{runtimeId}?allow_interrupt=` | 恢复应用前的配置 |
| GET | `/model-config/operations/{id}` | 操作结果 |

**预览**的每个目标包含 `decision`（`apply` 或 `skip`）。跳过原因：`model_connection_unsupported`、`not_installed`、`format_unsupported`、`mode_unsupported`、`models_required`（`catalog.required` 的 Runtime 没有可导入的模型）、`busy_operation`、`device_offline`。可以应用时给出 `offerFormat`、`effect`（`new_instance` 或能力的 `apply`）、`scope`、`requiresConfirmation`、`runningSessions`、`replaces`、`models`、`tooManyModels`。

**应用**规则：

- 协议取 Runtime 声明顺序中第一个配置也提供的协议。
- Runtime 当前模式（包括尚未配置时的默认模式）不能使用模型连接时，新建一个 `managedBy=model-config` 的受管实例，原实例保持不变；每台设备每种类型最多一个，再次应用时复用，恢复后再次应用会重新启动它。
- 只改写模型连接字段、上次导入的模型和必要的模式字段；用户自己添加的模型保留，ID 冲突时保留用户的；模型总数最多 64 个，超出时该目标跳过，原因为 `too_many_models`，可以用 `modelIds` 选择要导入的模型。
- `apply=restart` 且有任务运行时，必须 `allowInterrupt: true`，否则该目标以 `busy` 跳过；带 `deferBusy: true` 时改为先保存配置、不重启，记录状态 `deferred`，后台每 20 秒检查一次，Runtime 空闲后重启生效。
- `trimModels: true` 时，模型超过 64 个只导入放得下的部分，结果带 `modelsTrimmed`，不再跳过。
- 同一个 `Idempotency-Key` 重放返回同一操作；用于不同请求返回 409 `idempotency_key_reused`；仍在进行时返回 409 `operation_in_progress`。

恢复和轮换 Key 也遵循「先不中断」：带 `allow_interrupt=false`（或 `allowInterrupt: false`）时，有任务运行会返回 409 `busy`，客户端确认后再带 `true` 重试。轮换在 Tokens 一侧生效之前就会检查，所以被拒绝时旧 Key 仍然有效；轮换后没能更新的 Runtime 标为 `failed`，原因 `key_rotated`。

**恢复**只撤销本模块写入的内容：恢复应用前的 `modelGateway`、删除导入的模型；受管实例只停用，不删除实例和会话。恢复从不删除 Runtime 配置。

应用记录的 `status` 按优先级为 `applying`、`failed`、`deferred`（已保存，空闲后生效）、`modified`（应用后手动改过）、`outdated`（配置的模型或 Key 已变化）、`applied`。

### 多协议模型连接

声明 `modelConnection.multiProtocol: true` 的 Runtime（当前为 DSH）会同时应用模型服务中所有兼容协议。预览和 64 个模型限制按去重后的模型 ID 计算；同一模型可以出现在多个协议下，选择时以 Provider 和模型 ID 区分。

`modelGateway` 保留主协议的 `protocol`、`baseUrl` 和只写的 `apiKey`，可附带主协议的 `modelIds` 和额外的 `routes: [{protocol, baseUrl, modelIds}]`。所有路由共用该 Key，模型名称来自 `customModels`；没有这些附加字段的旧单协议配置仍可使用。恢复、重新应用和 Key 轮换以整个网关对象为单位处理。

DSH Bridge 在一次设置更新中写入各协议 Provider，仅删除本次配置已不再包含的 AA 路由，保留用户自己的 Provider；模型目录随设置更新失效并重新读取。已有单协议配置需要重新应用模型服务，才能补齐其余协议。Server、Connector 和 DSH Bridge 需配套更新；多协议下发使用 `applyModelConnections`，旧插件会明确拒绝，避免只应用主协议却报告成功。

## Tokens Anywhere 链接

Tokens Anywhere 是 OAuth 授权服务器，每个 AA 实例是公共 PKCE 客户端 `agents-anywhere`，以 origin 区分。Tokens Anywhere 地址是实例设置，默认取环境变量 `AGENT_SERVER_TOKENS_URL`，必须与 Tokens 的 `TOKENS_PUBLIC_ORIGIN` 完全一致（回跳的 `iss` 按它校验）；回调地址用 `AGENT_SERVER_PUBLIC_ORIGIN` 拼出。同步模型时，网关地址取 Tokens `GET /api/v1/status` 返回的 `apiBaseUrl`，没有时用 Tokens 地址。Tokens 必须设置 `TOKENS_SECRETS_KEY`：否则托管 Key 的明文只在创建时返回一次，AA 之后每次应用都要重新取回，会得到 409 `key_not_kept`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/integrations/tokens` | `{available, tokensUrl, secretConfigured, link}` |
| POST | `/integrations/tokens/link` | 返回一次性的 `startUrl`（60 秒有效） |
| GET | `/integrations/tokens/start?ticket=` | 浏览器打开；把链接绑定到这个浏览器的 cookie 后跳到 Tokens 授权页 |
| GET | `/integrations/tokens/callback` | Tokens 回跳；校验 state、浏览器 cookie 和 `iss`，换取 token，同步模型后跳到 `{Tokens}/oauth/done/`；失败时跳回 `/?tokensLink=<code>#/settings/model-configs` |
| POST | `/integrations/tokens/sync` | 重新读取托管 Key 能用的模型，更新 Tokens 配置 |
| DELETE | `/integrations/tokens/link?allow_interrupt=` | 先恢复用这份配置的 Runtime，再撤销授权；无法恢复的标为 `failed` |
| POST | `/model-profiles/{id}/rotate-key` | 需要 `Idempotency-Key`；轮换托管 Key 并写入所有用它的 Runtime |
| GET、PUT | `/admin/integrations/tokens` | 管理员读取或修改 Tokens Anywhere 地址：返回 `{tokensUrl, source, linkedAccounts, secretConfigured}`，`source` 为 `setting`、`environment` 或 `null`；PUT `{tokensUrl}`，空值关闭；有账户已链接时不能改成别的地址（409 `tokens_links_exist`），地址带路径时返回 422 `invalid_tokens_url` |

### 账户、用量与模型选择

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/integrations/tokens/account` | `{account: {id, displayName, email}, balance: {balance, available, held, bonus}, links: {console, billing, usage}}`。金额是 Tokens Anywhere 给出的人民币元字符串（4 位小数），客户端只做展示，求和时按 0.0001 元的整数计算 |
| GET | `/integrations/tokens/usage?days=` | `days` 为 1–92，默认 30。返回 `{from, to, items}`，`items` 是整个 Tokens 账户按北京时间日期和模型统计的已结算用量：`date`、`model`、`requests`、`inputTokens`、`outputTokens`、`cacheReadTokens`、`cacheWrite5mTokens`、`cacheWrite1hTokens`、`amountCharged`；没有请求的日期不返回 |
| PUT | `/integrations/tokens/models` | `{disabled: [模型 ID], names: {模型 ID: 名称}}`，关闭模型或改名，只影响 Agents Anywhere。返回 `{applying}`：为 `true` 时 Server 在后台重新应用到所有使用 Tokens 配置的 Runtime，进度和一键配置一样在 `tokens.quickSetup`，有任务的 Runtime 空闲后生效。一键配置进行中时返回 409 `quick_setup_running` |

Tokens 配置的 `offers` 始终是 Tokens 给出的完整模型目录，模型带 `vendor`、`contextWindow`、`maxOutputTokens`（来自 Tokens 价格表，可能为空）；配置另有 `preferences: {disabled, names}`。预览和应用时 Server 先去掉关闭的模型、换上新名称；某种协议的模型全部关闭时，这种协议不再提供给 Runtime。同步模型目录时保留 `preferences`。

### 一键配置

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/integrations/tokens/quick-setup` | 一键配置会处理哪些 Runtime：每项带 `decision`、跳过原因、`effect`、`requiresConfirmation`、`runningSessions`。还没链接时按三种协议都可用来判断，真正应用时以 Tokens 的模型目录为准 |
| POST | `/integrations/tokens/quick-setup` | `{targets, confirmNativeGlobal}`。还没链接时返回 `{started: false, startUrl}`，所选 Runtime 随授权请求保存；已经链接时返回 `{started: true}`，立即开始。同时只能有一个在进行，否则 409 `quick_setup_running` |

授权完成后，Server 在后台同步模型，再按 `deferBusy: true`、`trimModels: true` 应用到所选 Runtime，不打断正在运行的任务。进度在快照的 `tokens.quickSetup`：`state` 依次为 `syncing`、`applying`、`done`，失败时为 `failed` 并带 `step`（`sync` 或 `apply`）和 `code`；完成时 `results` 列出每个 Runtime 的结果（`applied`、`deferred`、`skipped`、`failed`）。

客户端在完成授权的浏览器里打开 `startUrl`：Web 用新标签页，Desktop 用系统浏览器，Android 用 Custom Tabs，iOS 用 `ASWebAuthenticationSession`。客户端不接收回调，链接结果通过实时快照得知；iOS 在快照显示已链接后主动结束授权会话。

Server 保存加密的 refresh token，access token 放在 Redis（没有 Redis 时在内存）；刷新在数据库行锁下串行进行，结果不明时在持锁期间重试一次。刷新得到 `invalid_grant` 时链接变为 `reauth_required`。每天的后台任务会刷新 30 天没用过的链接，避免闲置过期。

## 实时快照

`dashboard.snapshot` 增加 `modelConfig`：

```json
{
  "secretConfigured": true,
  "profiles": [{"id": "mpr_…", "source": "tokens", "name": "Tokens Anywhere", "originHost": "tokens.example", "offers": [], "keyHint": "sk-aa-se", "strategyName": "Default", "state": "active", "etag": "1", "updatedAt": "…"}],
  "assignments": [{"connectorId": "…", "runtimeId": "codex", "profileId": "mpr_…", "offerFormat": "openai_responses", "createdRuntime": false, "status": "applied", "error": null, "appliedAt": "…", "modelConnectionStatus": {"state": "applied"}}],
  "tokens": {"available": true, "tokensUrl": "https://tokens.example", "secretConfigured": true, "link": {"status": "linked", "issuer": "https://tokens.example", "account": {"id": "42", "displayName": "Ada", "email": null}, "linkedAt": "…", "relinkSoon": false}}
}
```

配置、应用、恢复、链接状态的变化都会触发 `dashboard.changed`，所有在线客户端随下一份快照更新。

启动后才应用连接的 Runtime（如 DSH 在连上 Bridge 后）通过 `runtime.statusChanged` 的 `modelConnection` 回报结果；Server 只在已存的报告对应当前保存的连接时采用它，避免还在用旧配置的实例被误报为「已应用」。
