# Runtime 指令目录直通契约

来源：2026-10-24 "手机 `/` 菜单只有 /compact" 修复。connector 侧改动：
`connector/connector/runtimes/dsh/runtime.py` 移除 compact 白名单过滤与
executeCommand 的非 compact 拒绝（尚未提交时以工作区为准）。

## 契约

**connector 对 DSH 指令目录零过滤、零语义判断**——`listCommands` 与
`executeCommand` 原样直通桥端。目录内容（哪些指令、metadata.ui.kind）
由桥端（dsh-bridge-next `RuntimeCommands`）全权决定；connector 在中间
过滤会**同时向所有客户端隐藏**条目（iOS/Android/Web/Desktop 共用同一条
RPC 链）。

守门职责归桥端：
- 目录收窄（native compact + `/model` selector + 用户可调用 skills）在
  `commands.ts` 的 list；
- execute 拒绝不认识的指令（`unknown_command`）并在技能执行前对照实时
  catalog 复验。

## ok 回执三件套契约（2026-10-28）

桥端返回 `ok: true` 的指令回执必须同时携带 `kind: 'success'`、非空
`commandId`、`executionState: 'accepted'`，且不得带 `retryable` 和顶层
`code`——见 `connector/connector/runtimes/dsh/bridge/models.py` ok 路径
的逐项校验（失败消息形如 "acknowledgement is invalid: commandId must
be a non-empty string"，2026-10-28 起逐项点名）。缺任何一项会被
connector 降级成 `command_outcome_unknown`，客户端看到的就是
"结果尚不确定"。

- 预算超时等拿不到原生 commandId 的场景，用合成 `pending-<uuid>` 顶替
  （server 只透传不关联，已核实 `sessions.py` execute_session_command）。
- `models.py` 的 ok 路径校验失败时**逐项点名缺失字段**（如
  "commandId must be a non-empty string"），不再抛笼统的 incomplete——
  下次同类问题从 ValueError 消息即可定位，不必再翻三层日志。
- **"结果尚不确定"这条报错文本在 TS 桥、Python connector、server 三层
  逐字存在**——凭消息无法定位来源层。定位方法：取 mtime 最新的
  `~/.agents-anywhere/logs/runtime-*.jsonl`，grep `executeCommand` 看
  duration 与 status（曾实证 status=ok duration_ms=5001：桥端正常返回、
  Python 校验拒绝）。

## 与上游 main 的分叉（自留，不提上游）

上游 compact-only 白名单是**刻意政策**（`0d150a6e` → PR #177，2026-09-28
由 t4we fan 全量直通后 3 小时内收窄），理由有二：①避免暴露依赖 DSH
客户端 UI 的命令入口；②模型/权限已有 AA 专用控件，开放命令会形成双
入口。skill 不开放则是因为命令通道承诺"绝不作为普通 prompt 发送、失
败保留草稿"，而 skill 执行本质就是发 prompt、无 registry 结算结果。

我们的直通 + skill 开放（`eee2a620`）靠 accepted 三件套 + 会话日志
`command/done` 异步落结果补齐了回执缺口，真机验证全链路可用。但这是
**产品取舍分歧而非缺陷修复**——2026-10-28 与 dae 确认：上游大概率
不接受，skill 开放/目录直通**自留自用，不开上游 PR**；若日后向上游
提 dsh 修复类 PR（如三件套契约、竞速超时），须剥离 skill 相关改动。

DSH `SessionSkillCatalog.list` 服务端只返回用户可调用技能
（SDK 声明 "user-invocable skills"），`modelInvocable` 仅表示"同一
技能是否也通告给模型"，是信息性标志——桥端无需再过滤。

### DSH NEXT 升级会覆盖本机 connector 源（2026-11-21）

DSH NEXT 桌面版自带一份 `bundled-connector`，profile 的
`~/.dsh/profiles/desktop/desktop-next.cordis.patch.json` 里
`connectorSourceDir` 指向它；DSH 启动时按内容 hash 复制到
`~/.agents-anywhere/dsh-bridge-next/connector-source/<hash>/` 再用 uv 跑。
**每次升级 DSH NEXT 都会把这个配置重置回 app 内置路径**，于是内置的
上游过滤版生效、目录里只剩 `/compact` 和 `/plan`，技能全部消失——表现为
"指令面板突然只剩两条"。桥端（`dsh-bridge-next`）走 profile 的 symlink
不受影响，所以只有目录/执行两侧被砍。

上游至今未采纳零过滤（`origin/main` 仍是 `filter(id == "compact" or
"plan")`），所以这是必须本机自维护的补丁。重放方式：

```bash
~/.agents-anywhere/dsh-bridge-next/sync-connector-patch.sh   # 然后重启 DSH NEXT
```

脚本以内置版为基底（保住上游新改动，如 `PROJECTION_REVISION=3`、thought
identity），复制到 `connector-custom/`，打三处补丁，再把配置指过去：
`list_commands` 零过滤、`execute_command` 撤销非 compact 拒绝、
`models.py` ack 错误点名字段。**不要**直接把 `connectorSourceDir` 指向
仓库 `connector/`——仓库可能落后上游（2026-11-21 实测仓库
`PROJECTION_REVISION=2` 而上游已 3），会丢上游新功能。等仓库 merge 到
上游最新后，才可以把源切回仓库省掉副本。

## DSH 0.2.2 的 workingDirectory 注入（2026-11-13）

DSH 基线升到 0.2.2-rc.1 后，`SessionSkillCatalog` 会注入
`workingDirectory`。桥端测试 fixture 若只组合 `SessionController` 而不
组合 `WorkingDirectory`，`catalog.list` 会失败并被桥端降级为「无技能」，
命令菜单里的用户技能全部消失。修法：`dsh-bridge-next/package.json` 的
devDependencies 补 `@deepseek-ai/dsh-working-directory`，并在
`tests/fixtures/agent-runtime.ts` 里
`await ctx.plugin(WorkingDirectory, { defaultDirectory: root })`，与真实
Host 的组合一致。升级 DSH 基线后先跑 `corepack yarn check`；这类
fixture 组合缺口只会以「技能列表为空」的形式出现。

## 桥端排障日志地图与联调回路（2026-10-28 实证）

排障先看对日志，别看错地方：

| 日志 | 内容 |
|---|---|
| `~/.agents-anywhere/logs/runtime-*.jsonl`（按 mtime 取最新） | **RPC 流量**：每条 `aa.dsh.v2.Bridge.executeCommand status=ok duration_ms=…` |
| `~/.agents-anywhere/dsh-bridge-next/logs/connector-output.json` | 只有 `[process]` 生命周期事件，**没有 RPC**——看它诊断指令问题是死路 |
| `~/.dsh/logs/desktop-next-<date>.0.jsonl` | DSH 应用自身日志 |

联调回路（改桥端 TS 后真机生效的最短路径）：

1. `~/.dsh/profiles/desktop` 里 `@agents-anywhere/dsh-bridge-next` 是
   **symlink 指向本仓**——`cd dsh-bridge-next && corepack yarn build` 的
   `lib/index.js` 即为 DSH 实际加载物，无需安装。
2. **必须重启 DSH** 才加载新 build；改 src 不 build、或 build 后不重启，
   真机跑的都是旧代码（本轮两轮无效复测的另一半原因）。
3. `corepack yarn check` 需 `AGENT_SERVER_TEST_DB_URL`；本机无 docker，
   用 Homebrew `postgresql@17`（`127.0.0.1:5432`，测试库
   `agents_anywhere_test`）。

## 错误模式

- 在 connector 加"客户端还支持不了 X"之类的过滤：菜单内容是运行时下发
  的，客户端只渲染；正确做法是桥端按能力收窄目录，或客户端按
  capabilities 隐藏。
- 文档漂移：`connector/docs/runtime-commands.md` 曾长期描述 compact-only
  旧政策——改这里必须同步该文档。
