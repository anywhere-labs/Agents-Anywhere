<!-- tm_board_write · 2026-09-26T13:56:57.432Z · role=researcher · session=20260926-213919 -->
# OpenCode 多插件共存与动态适配 — 调研报告（researcher，2026-09-26）

范围：多插件共存与动态适配。基础 API 盘点（hook 清单/context/SDK 路线）由另一位研究员负责，本文不重复。
渠道：sst/opencode dev 分支源码 → opencode.ai/docs/plugins → 本机 ~/.config/opencode 与宿主日志（只读）。

## 0. 本机环境实证快照

| 事实 | 证据 | 置信度 |
|---|---|---|
| 宿主 CLI/Server = OpenCode **2.0.16**（v2 插件系统） | opencode.log L820 `cli starting version=2.0.16` | High |
| 桌面端另有 1.18.x v1 loader 产品线（asar 1.18.30） | team-mode dist/index.js L7-12 注释 | Medium |
| 已配置：@slkiser/opencode-quota@latest + @te-river/opencode-team-mode@latest | opencode.jsonc L4-6 | High |
| quota（v1 格式 default.{id,server}）在 2.0.16 上**每次加载都失败**（PluginModule.LoadError：缺 default.effect/setup） | opencode.log L15108-15109（当前 run=e0accff1，今日 10:41） | High |
| team-mode 1.6.1（default.{id,server,setup} 双人格）加载成功，今日 entrypoint 解析到 `C:\Users\34296\node_modules\...`（家目录根，第三种安装根） | opencode.log L15110 | High |
| npm 插件缓存 = `~/.cache/opencode/npm/<scope>/<name>@latest/<时间戳>/node_modules/<pkg>` | opencode.log L35 entrypoint= 行 + 目录实测 | High |
| 宿主日志有 `msg="loading plugin" id=... entrypoint=...` 行 | opencode.log L35/L6882/L15108 | High |
| 存在 `opencode plugin list` CLI 子命令 | opencode.log L10 `args=["plugin","list"]` | High |
| 宿主 watcher 订阅配置目录（ignores=3） | opencode.log L18/L33 | High |
| 存在 `/api/location/reload` 端点（CLI `opencode api location.reload`） | opencode.log L820-825 | High |
| config 重载路径真实运行（失败记 ERROR "failed to reload config"） | opencode.log L15529 | High |

## 1. 多插件 hook 执行机制

### 1.1 v1 loader（dev 分支 packages/opencode/src/plugin/index.ts；1.18.x 桌面线同源）

trigger 分发原文（文件后部，~L278-292）：

```ts
const trigger = Effect.fn("Plugin.trigger")(function* (name, input, output) {
  if (!name) return output
  const s = yield* InstanceState.get(state)
  for (const hook of s.hooks) {
    const fn = hook[name] as any
    if (!fn) continue
    yield* Effect.promise(async () => fn(input, output))
  }
  return output
})
```

结论（源码可见未文档化）：
1. **顺序执行**：hooks 数组 for 循环逐个 await。顺序 = 内置插件（internalPlugins：Codex/Copilot/Modal/Gitlab/Poe/Cloudflare/Azure/DO/Xai/Cerebras/Snowflake）在前，外部插件按配置顺序在后。
2. **全部依次执行**：改 output 不中断循环；所有插件拿到**同一个 output 对象**（引用传递，无快照无合并，后写者胜，前面的修改对后面可见）。
3. **抛错即断链**：Effect.promise 无 catch——任一插件 hook 抛错，整个 trigger 失败并上抛调用方（工具执行中止），**排在后面的插件不再执行**。官方文档 env-protection 示例（throw 阻断 .env 读取）即利用此行为。
4. **event hook 特例**：events.listen 回调里 `void hook["event"]?.({event})`——按数组顺序同步发起但**不 await 不 catch**：全部插件都会被调用，完成顺序任意，异步异常成为 unhandled rejection（对宿主影响未文档化）。
5. **config/dispose hook 容错**：Effect.tryPromise + tapError(logError) + ignore——单个插件失败只记日志，其余照常。
6. **加载失败隔离**：import/初始化失败 → logError("failed to load plugin") + catch(void) → 跳过该插件继续。**本机活证据**：quota 每次加载失败，team-mode 不受影响。
7. **每插件每 hook 单槽位**：team-mode v1.js L223-227 注释："the host calls the single `tool.execute.before` slot per plugin"——它把超时钳制+R6 两件事塞进同一个函数。

### 1.2 v2（2.0.16，本机宿主实际运行）

- 插件格式：`default.{id, setup(ctx) | effect}`（PluginModule schema）。**2.0.16 无 v1 回退**——quota 的 default.{id,server} 被拒（日志实证）。dev 分支 applyPlugin 已加回 readV1Plugin(...,"detect")+getLegacyPlugins 的 v1 兼容（未来版本可能双轨）。
- **注册制**：`ctx.<domain>.<hook>(callback) → Promise<Registration>`（Registration={dispose}），域（agent/catalog/command/integration/reference/skill/tool）各带 `reload()`。类型见 @opencode-ai/plugin@1.18.24 dist/v2/promise/registration.d.ts。
- **PluginDomain**：`ctx.plugin.add({id, effect}) / remove(id)`——v2 插件可编程式增删插件（SDK 类型层面）。宿主侧 packages/core/src/plugin/host.ts L197。
- team-mode 实证（在本机 2.0.16 上工作）：ctx.tool.transform 包工具（v2.js L74）、ctx.agent.transform 改角色（L384）、ctx.location/ctx.options；"Every v2 hook fires for EVERY agent on this host"（L83-85）——**v2 hook 全局触发，插件必须自己做 agent 范围过滤**。
- **v2 多插件回调分发顺序未在源码定位**（gap）：注册顺序=setup 调用顺序=插件加载顺序（配置顺序）；tool.transform 多插件叠加应为洋葱包裹，内外层先后未证实。

## 2. 权限/审批的多插件竞争

### 2.1 permission.ask 插件 hook 是死的
- 类型存在：`"permission.ask"?: (input: Permission, output: {status:"ask"|"deny"|"allow"}) => Promise<void>`（@opencode-ai/plugin dist/index.d.ts L225-227）。
- dev 分支 prompt.ts 的 trigger 调用点仅 tool.execute.before(L310)/after(L392)/shell.env(L557)/chat.message(L1002)，**无 permission.ask**；team-mode v1.js L246-248："this host's d.ts has shipped surfaces the runtime never fires (permission.ask)"（对 1.18.x 二进制实测）。
- 结论：审批代答**不要**建立在 permission.ask hook 上。【High】

### 2.2 真实审批流（packages/opencode/src/permission/index.ts，dev）
1. ask()：每 pattern 用 evaluate() 合并规则——`rulesets.flat().findLast(匹配)` **最后匹配规则胜**（config 规则+会话内已批准规则）。deny→DeniedError；全 allow→静默通过；否则 needsAsk。
2. needsAsk：登记 pending Map，publish `permission.asked`（广播所有插件，fire-and-forget），await Deferred。
3. reply()：**先到先得**——pending.get 拿不到即 NotFoundError。第一个 reply 决定结果：
   - "reject"：fail deferred 并**级联 reject 同 session 全部其它 pending**；
   - "once"：仅本次；
   - "always"：**把 allow 规则持久推进 approved**，自动放行同 session 其它已全匹配的 pending。
4. 事件面：permission.asked / permission.replied 均在官方事件列表，插件 event hook 都能收到。
5. 工具侧 ctx.ask 桥（team-mode perm-ask.js 实测：宿主把工具 ask 包成 permission.ask+ruleset 合并）；**v2 宿主上插件没有弹确认窗的入口**（v2.js L28-31，team-mode 只能 fail-closed）。

### 2.3 竞争语义与安全风险
- 多消费者（插件/SDK 客户端/TUI）都能调 reply：**先到先得，后来者 NotFoundError**。【安全风险：High】审批完整性完全依赖进程内信任，无"谁有权应答"校验。
- 【安全风险：High】恶意/失控插件可 reply "always" 持久放行一类 pattern，静默改变后续所有权限行为。
- 【安全风险：Medium】reject 级联杀掉同 session 全部 pending——一个插件的激进拒绝会放大成整轮中断。
- 检测：订阅 permission.replied——收到非己方 reply 即存在另一个审批消费者；asked/replied 时间差可做竞争告警。

## 3. 插件枚举与能力发现

| 通道 | 可行性 | 证据 |
|---|---|---|
| PluginInput 插件列表 API | **无**（client/project/directory/worktree/experimental_workspace/serverUrl/$） | d.ts L36-46 |
| config hook 收到的 cfg | **有**——Config 类型含 plugin 数组（配置清单，非加载状态） | d.ts L48-50 |
| 读 opencode.jsonc/package.json | 有（文件系统） | 本机实测 |
| 宿主日志 entrypoint= 行 | **有**（含解析路径+时间戳缓存目录） | opencode.log L35 等 |
| `opencode plugin list` CLI | 存在（输出未验证） | opencode.log L10 |
| 桌面端插件面板 | 存在 | opencode.jsonc L9 注释 |
| 动态装卸感知 | v1 无 API（日志 tail+配置 watch）；v2 PluginDomain.add/remove+域 reload | registration.d.ts/host.ts L197 |
| config 热重载 | watcher 订阅配置目录；重载真实运行（"failed to reload config"）；/api/location/reload；team-mode："宿主**同进程**重载插件"（v2-browser-gate.js L298）"插件重载会**重放 hooks**"（dispatch.js L880）——重载非重启，插件必须可重入 | 多源 |

注意：InstanceState 按 directory（location）隔离——同一次宿主启动里多个项目目录各自初始化一套插件（日志中 team-mode 一秒内加载 3 次）。"已加载插件集合"是 per-location 的。

## 4. 隔离性与故障域

1. **同一 JS 运行时**：插件是宿主 server 进程（Bun）里的动态 import——共享全局/内存/事件总线，无沙箱。【安全风险：Medium】任何插件可 monkey-patch 全局或其它插件模块。
2. **加载失败隔离良好**（quota 失败 team-mode 正常）；**hook 执行失败不隔离**（抛错断链）；**event hook 异步失败无人接**（unhandled rejection）。
3. **依赖解析多根并存**（本机三种同时存在）：~/.cache/opencode/npm/<scope>/<name>@latest/<时间戳>/（npm spec 按次隔离）；~/.config/opencode/node_modules/（配置目录 package.json+bun install，本地插件共享树，版本冲突可能在此）；C:\Users\34296\node_modules\（team-mode 今日 entrypoint）。file:/Junction/绝对路径 spec 走 resolvePathPluginTarget（目录需有 package.json 或 index 文件，否则 "missing package.json or index file"——file 插件在此错误上重试一次）。
4. **npm 与本地同名插件双载**：官方文档明说"本地插件和名称相似的 npm 插件会分别独立加载"；本机 09-25 日志实证 team-mode（npm）+plugins/team-mode.js（本地）同轮各载一次（用户 09-26 改 .disabled 才修掉）。
5. **engines.opencode 兼容门**（dev shared.ts）：npm 插件可声明 semver 范围，不满足拒载；file 插件跳过。
6. **@latest 解析即缓存**：装进时间戳目录后不再查 registry——用户 refresh-plugins.ps1 即为此而写（比对 registry、删缓存目录逼重装）。
7. **deprecated 包静默忽略**：DEPRECATED_PLUGIN_PACKAGES 已内置，配置写了也当没看见。
8. quota 源码注释（dist/index.js L9-12）自述多插件冲突规避："V1 plugin format: default export with id + server. This avoids the legacy getLegacyPlugins fallback path... which iterates Object.values(mod) and can conflict with other plugins that also use the legacy path."——第三方作者的一手共存经验。

## 5. 动态适配设计建议（每条标注依据）

1. **双格式导出**：`export default { id, server, setup }` 三件套。依据：quota 仅 v1 格式在 2.0.16 加载失败（日志 L15109）；team-mode 双人格两端可装。【High】
2. **只读旁路优先**：会话/消息/工具调用暴露给 Connector 用 event 订阅+tool.execute.after（读结果）+SDK client；**绝不在 tool.execute.before 抛错或改参数**（除非用户明确要治理功能）。依据：trigger 无 catch，抛错断链伤所有插件（index.ts+官方 env-protection 示例）。【High】
3. **幂等可重入+完整 dispose**：宿主同进程重载插件并重放 hooks（v2-browser-gate.js L298、dispatch.js L880）；每 location 独立初始化（日志 3 连载）。注册收集 Registration、定时器 unref、dispose 全清。【High】
4. **能力探测降级**：每个 ctx 面/hook 先探测存在性，缺失 console.error+静默降级，绝不 throw。依据：team-mode v2.js L74-79；v1.js L248（d.ts 有、运行时不发的 hook 真实存在）。【High】
5. **审批代答竞争协议**：订阅 permission.asked→记录 requestID→代答窗口尽量短→代答后监听 permission.replied 确认归属；发现非己方 reply 立即告警并降级为"只通知不代答"。**绝不使用 "always"**（持久改规则越权）。依据：reply 先到先得+NotFoundError（permission/index.ts）。【High】
6. **不写共享配置**：quota 会写 opencode.jsonc（用户配置注释 L185）——反面教材；我们只读配置，注入用 v2 草稿域并在 dispose 移除。依据：本机配置注释+host.ts 草稿模型。【Medium-High】
7. **启动时共存清单**：读 opencode.jsonc plugins 数组+tail 宿主日志 entrypoint= 行+（可选）opencode plugin list，生成共存清单，对每个想占用的面（审批代答/tool.transform/event 订阅）做冲突评分与告警。依据：无 list API（d.ts）但日志/配置/CLI 三通道实测可用。【High】
8. **零运行时依赖**：不依赖 v2 SDK（Plugin.define 是恒等函数，team-mode dist/index.js L42-44）；必须的依赖锁精确版本随包发布。依据：多解析根并存（§4-3）。【High】
9. **event 处理器全自捕获**：event hook 是 void 不 await（index.ts）——每个事件回调内部 try/catch 一切，防 unhandled rejection 波及宿主。依据：源码。【High】
10. **升级感知**：监听 installation.updated+watcher 触发的 config 重载；宿主版本变化可能改变 v1/v2 兼容面（dev 已在加回 v1 兼容）。依据：docs 事件列表+dev/2.0.16 差异。【Medium】

## 6. 证据清单（关键源码文件）
- packages/opencode/src/plugin/index.ts（trigger/state/applyPlugin/internalPlugins/event 分发）
- packages/opencode/src/plugin/loader.ts（resolve/load/attempt 分阶段容错、deprecated 跳过）
- packages/opencode/src/plugin/shared.ts（spec 解析/入口探测 exports["./server"]→main→index/兼容门/路径包含检查）
- packages/opencode/src/permission/index.ts（evaluate findLast/ask/reply 先到先得/级联/always）
- packages/opencode/src/session/prompt.ts（trigger 调用点 L310/392/557/1002）
- packages/core/src/plugin/host.ts（v2 PluginHost/各域/plugin.add）
- @opencode-ai/plugin@1.18.24 dist/index.d.ts（v1 Hooks 全集）+ dist/v2/promise/*.d.ts（本地）
- https://opencode.ai/docs/plugins（官方：Bun 安装缓存/同名同版本只载一次/本地+npm 独立加载/package.json 依赖 bun install/throw 阻断示例/事件列表）
- 本机：opencode.jsonc、package.json、refresh-plugins.ps1、opencode.log、~/.cache/opencode/npm/、team-mode 与 quota 的 dist/

## 7. Gaps（未能确认）
1. v2 多插件回调分发顺序——host.ts 只见注册面，分发循环未读到；需读 packages/core/src/plugin/ 其余文件或反查 2.0.16 二进制。
2. sst/opencode 仓库内多插件冲突 issue 检索：GitHub search API 对 repo: 限定查询 422（两次）；改用无限定搜索得 8 条第三方仓库适配 v1/v2 双格式的 PR（社区普遍双格式适配的旁证）；quota 源码注释是唯一一手"多插件冲突"社区陈述。
3. dev 与 2.0.16 差异：dev 的 applyPlugin 已有 v1 detect 回退而 2.0.16 没有——未来版本 v1 插件可能又能载；按双格式设计即可免疫。
4. `opencode plugin list` 输出内容（researcher 无 shell，未运行）。
5. 桌面端 1.18.x 与 CLI 2.0.16 的确切关系（两条产品线并行？）——team-mode 注释与日志版本号并存但未互相印证。
