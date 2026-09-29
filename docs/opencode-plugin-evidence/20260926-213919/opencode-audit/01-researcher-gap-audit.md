<!-- tm_board_write · 2026-09-26T19:40:02.347Z · role=researcher · session=20260926-213919 -->
# OpenCode V2 接入 — 真实用户视角系统性缺口审计（只读）

> 方法：设计三版 vs 实现代码 vs AA 契约 vs Web 渲染；只读，未改仓库、未扰 PID 9016、未改用户配置。
> 证据基线：opencode-cli 2.0.18 实测（p0/dist/subagent 报告）+ 本仓库源码。
> 评级：Critical=真实用户无法走通主路径；Major=可用性/安全显著受损或组合即坏；Minor=体验/可诊断性。

## 严重度总览
| # | 类别 | 缺口 | 严重度 | 处置 |
|---|---|---|---|---|
| C1 | 安装/运营 | 登录唯一入口是未证装载的 TUI，服务端插件 needs_login 时只记录不引导 | Critical | 改实现 |
| C2 | 安装/分发 | 推荐 git::path: 分发落盘后无同级 connector/，Connector 永远起不来 | Critical | 改实现/文档 |
| M1 | 多实例 | 多 OpenCode 进程缺 servicePid 时连"最近启动"端点；resource_claims 仅按 registryDir | Major | 产品决策 |
| M2 | 多实例 | 同机 Desktop 自带旧 Connector 不认识 opencode → lease 抢走后静默无连接 | Major | 产品决策/文档 |
| M3 | 卸载 | 无卸载路径；残留含明文 connectorToken、令牌、sqlite、可能残留进程 | Major | 改实现/文档 |
| M4 | 安全 | 子会话审批永不达远端（无 parentID 处理，owner=null fail-closed） | Major | 改实现/产品决策 |
| M5 | 安全 | loopback-only 在远程/容器 OpenCode 下整体不成立，设计未覆盖 | Major | 产品决策 |
| M6 | 运营 | 服务端侧无可操作自检命令；静默失败面大（目录 spec 零日志、A10） | Major | 改实现/文档 |
| M7 | 运营 | 旧服务端(<v2_38) + 新插件：设备码 404、dashboard insert 失败，无版本门 | Major | 改实现 |
| M8 | 跨平台 | Windows 强杀只杀 uv，python 孙进程残留 | Major | 改实现 |
| m1 | 兼容 | session-agent-icon 硬编码 codex/claude/deepseek，opencode 落通用图标 | Minor | 文档/前端 |
| m2 | 观测 | logger 正则含 code → 错误码字段被误 redact | Minor | 改实现 |
| m3 | 跨平台 | 0600/0700 在 Windows no-op，凭据仅靠 ACL | Minor | 文档/加固 |
| m4 | 兼容 | 能力投影仅固定 _INHERITED_RUNTIME_CAPABILITY_IDS，新 runtime-scope 能力不入会话级 | Minor | 产品决策 |
| m5 | 其它 | 冷启动盲区 complete 不可达（已知设计），用户以为少会话 | Minor | 产品决策 |

## 1. AA 侧兼容与端到端运营
**已覆盖**
- 服务端接受任意 runtime_type：`server/agent_server/core/runtime_identity.py:44-54` 只校验格式，KNOWN_RUNTIME_TYPES(:23) 已含 opencode；不限制枚举。
- Web 设备/实例 UI 动态渲染 runtimeTypes：`web-next/src/features/dashboard/runtime-discovery.ts:12,25`、`runtime-instances.ts:77-97`、`components/pages/device-page.tsx:488-497`（discoverRuntimes 设 runtimeTypes）。
- 会话标签含 opencode：`web-next/src/components/session/session-utils.ts:26-31`（opencode→"OpenCode"，未知 runtime 回退首字母大写）。
- 通知形状对齐 AA 契约：`projector.ts:454-459`（interactionType="approval"、blocking {scope,targetId}）；`bridge-hub.ts:869-879` 重写 targetId。P3 报告确认 AA 零改动。
- admin_dashboard 四处补齐 + snapshot v6（p5 §4）。
**缺口/待判**
- m1 图标：`web-next/src/components/sidebar/session-agent-icon.tsx:19-26` 仅 codex/claude/deepseek，opencode→通用 `Bot`。Minor，仅需前端补图标。
- m4 能力渲染固定表：`server/agent_server/services/effective_capabilities.py:32-43`。opencode 的 runtime-scope 能力（session.discovery）不投影到会话级。Minor。
- M7 组合兼容：设备码端点与 v2_38 `opencode_agents` 列是 P5 新增（p5 §2/§4）；插件/Connector 无服务端版本门。旧服务端 → 404/insert 失败。Major。
- 【无法判定】移动端 App 对 opencode runtime 的渲染（web-next 不能代表 mobile）——需 mobile 仓库证据。

## 2. 安装 / 升级 / 卸载
**已覆盖**
- 安装形态 B′ 已实测：目录根 `index.ts` 才被 file 源加载，`exports` 不参与（dist/02 §2-4，README:70-95）。
- 升级：分支跟踪 / commit pin（dist/01 §2）；自检步骤（README:90-95）。
- 退出登录顺序不可逆：revoke→删本地→停 Connector（onboarding.ts 头注 + README:45）。
**缺口**
- C2（Critical）：`connector-supervisor.ts:185-197` resolveSourceDir 只认 `AGENT_CONNECTOR_SOURCE` 或插件包同级 `../connector`；而 dist/01 推荐的 `github:…::path:opencode-plugin` 落在 `~/.cache/opencode/packages/<spec>/`，同级无 connector/ → 安装后 Connector 永不启动，只有一条 warn。处置：改实现（随包分发 Connector）或文档强制 clone 全仓库 + 设 env。
- C1（Critical）：`server/index.ts:16-18,54-61` needs_login 时只 logger.debug，不引导；`onboarding.login` 唯一调用点是 `tui/index.ts:235`，而 TUI 装载未证（A10，README:101-103）。且 `apiBaseUrl` 无默认/无 env，只能 TUI 对话框写入（tui/index.ts:324-333）。→ 新用户无法完成账号接入。处置：改实现（服务端可触发设备码/或提供显式命令）。
- M3（Major）：全仓库无 uninstall/卸载/autostart（grep 0 命中）。残留：`~/.cache/opencode/packages/<spec>/`、`~/.agents-anywhere/opencode-plugin/{settings,account, bindings/**,pending-flow}.json`、`connector.json`（**含明文 connectorToken**，supervisor:262-265）、`<connectorId>.sqlite3`、可能仍在跑的 Connector（index.ts:20-22 明确不杀）、端点文件。处置：文档+实现 cleanup。
- 升级不兼容：`engines.opencode>=2` 已声明但 P6 未实现门（README:33）；插件/Connector 协议版本无协商降级。Major→P6。

## 3. 多实例 / 多进程 / 同机共存
**已覆盖**
- 同进程单例：globalThis Symbol 收养（README:25；bridge-hub.ts:1430-1442）。
- 机器级 Connector 单例：OS lease；`connector_already_running` 当正常复用（onboarding.ts:185-195）。
- 同机 DSH 桥：registryDir 不同（opencode-bridge vs dsh），无冲突。
- location 归一过滤（paths.ts:16-24）。
**缺口**
- M1（Major）：多 OpenCode 进程各发端点文件；`servicePid` 可选，缺省时 discovery 取 startedAt 最新（p2/03 M6）→ 可能连到"最近启动"的另一 OpenCode；`provider.py:195-206` resource_claims/session_source_key 只按 registryDir → 多实例同 location 时 AA 侧歧义。处置：产品决策（强制每实例绑 servicePid+location）。
- M2（Major）：同机 AA Desktop 自带 Connector 若版本旧、不含 opencode provider，则插件 spawn 因 lease 失败退出，opencode 会话永不出现且仅 debug 日志。处置：产品决策/文档（Connector 版本要求）。
- 【无法判定】子会话是否带正确 location（subagent/01 §3）——需探针。

## 4. 运维与可观测性
**已覆盖**
- logger 脱敏（logger.ts:17-31）；可操作报错（uv/源码缺失，supervisor:218-229）；syncDiagnostics/skipped 计数（p2/03）。
**缺口**
- M6（Major）：服务端侧唯一自检是 TUI `/aa status`（tui/index.ts:187-217），TUI 未证 → 用户只能"看端点文件是否生成 + grep opencode 日志"。无独立日志文件/status 命令。处置：改实现。
- 静默失败面：目录 spec 解析不到入口**零日志零报错**（dist/02 §3）；TUI 通道静默；session discovery 恒 partial（README:50-52）。已文档化自检，但"装了没反应"概率高。处置：文档+实现。
- m2（Minor）：`logger.ts:17` 正则 `(token|secret|code|…)` 会把字段名含 code 的值也 redact（如错误码）→ 削弱定位。处置：改实现（白名单）。
- 【无法判定】插件 console.* 输出（logger.ts:40-42）是否被收集进 `opencode.log`——需实测；否则用户无处看日志。

## 5. 跨平台差异
**已覆盖**
- realpath 归一（paths.ts:34-40）；POSIX 进程组杀（detached: supervisor:283，kill(-pid): 379-381）；Windows 不 fsync 目录（endpoint-store.ts:195-196）；uv 查找含三平台路径（supervisor:549）。
**缺口**
- M8（Major）：`connector-supervisor.ts:376-390` win32 只 `child.kill`（uv），不杀其 python 孙进程 → 退出/卸载后 Connector(python) 残留。处置：改实现（taskkill /T 或 Job Object）。
- m3（Minor）：0600/0700 在 Windows 被 Node 忽略，凭据仅靠 %USERPROFILE% ACL（设计 §2.1 已承认）。处置：文档/加固。
- 符号链接：location 用 realpath，但对"尚未存在的目录"退化 resolve（paths.ts:34-40），若事件侧 realpath 成功则比较可能失配。Minor。
- 【无法判定】macOS/Linux 全链路未实测（全部实证在 Windows）——需跨平台 CI/实测。

## 6. 安全边界
**已覆盖**
- loopback + 32B token 恒定时间比较（bridge-hub.ts:13,505,1389-1397）；首帧必须 initialize（:458-476）；拒绝 bridge 反向请求；审批白名单 READ_ONLY_ACTIONS、owner 绑定、首答锁定、禁 always（permission-policy.ts / P3 报告）；OAuth state 恒定时间 + code 一次性（README:42）。
**缺口**
- M4（Major）：子会话 permission.asked 的 sessionID 属子会话，未被任何连接认领 → owner=null → 永久 `unbound_notice`；插件/Connector 无 parentID/children/family 处理（grep 0 命中）。fail-closed 安全但功能缺失。处置：改实现（按 root 家族认领）或产品决策。
- M5（Major）：loopback-only 假设在"OpenCode 跑远程服务器/容器"下整体不成立（插件绑容器内 127.0.0.1，Connector 须同网络命名空间）；设计未覆盖该部署。处置：产品决策（明确不支持或另设隧道）。
- 端点 token 落盘：同 uid 本机任意进程可读端点文件并连 loopback 代答审批（DSH 同构风险）。Medium；文档写明信任边界。

## 7. 其它
- 子会话事件是否进全局流未判定：P0 实测"子会话事件不转发"与 SDK 类型矛盾（subagent/01 §3）。若成立，子会话不进注册表、时间线/审批全缺。Major；处置：跑隔离探针（subagent/01 §7）。
- 冷启动盲区：插件加载前已存在且不再发事件的会话永不出现，complete 不可达（README:50-52，session-registry.ts:54-69）。用户会以为"少了会话"。Minor→产品决策。
- steerTurn 恒 false（V2 无原生 steer）：前端应据 capabilities 显示不可用（已由能力驱动覆盖）。已覆盖。
- `connector.json` 明文 connectorToken 落盘（supervisor:262-265）+ Windows 无 0600（叠加 m3）。Medium。

## 建议优先级
1. C1/C2：先补齐"零到可用"闭环（登录可达 + Connector 随包可达），否则接入无真实用户价值。
2. M1/M2/M7：组合/多实例/版本门——写进 README 的兼容矩阵 + 实现版本校验。
3. M3/M6/M8：卸载与运维——提供 cleanup 命令与自检命令（含 Windows 进程树清理）。
4. M4/M5 + 子会话：需产品/安全决策后再实现。
