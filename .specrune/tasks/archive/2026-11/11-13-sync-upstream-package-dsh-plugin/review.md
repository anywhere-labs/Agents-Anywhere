# Review — 同步上游并独立打包 DSH 远程控制插件（round 1）

- 工作树：`feat/ios/duo-cover-original-shell` @ `668b49df`
- 对照对象：`origin/main` = `986fc8f5`（分叉点 `34f7cbf5`）、`main` = `78cc351d`
- 本轮只写本文件，未改代码/规范/任务产物；`git status --porcelain --untracked-files=no` 仍只有 4 个既有 `.specrune/*` 改动。

## 验收标准逐项结论

| # | 验收标准 | 结论 | 证据 |
|---|---|---|---|
| 1 | `main` 含 `origin/main` 全部 92 提交；无冲突标记；8 个冲突文件按 `upstream-sync.md` 处置 | pass | `git rev-list --count main..origin/main` → `0`；`41f3f4ec` 父提交为 `baac287e` + `986fc8f5`（= origin/main tip）；`git grep -nE '^(<<<<<<<|>>>>>>>)' main` 与对 `HEAD` 同查均无输出。8 文件：`.gitignore`（`git diff origin/main main` 仅 `+.worktrees/`，其余上游行都在）；`connector/.../runtime.py`（见下）；`commands.ts`（全文件仅 1 处 `executeSkill` 定义，`commands.ts:231`）；`project.pbxproj`（`DEVELOPMENT_TEAM = 85V4S34K64`，`:275/:335`；`MARKETING_VERSION = 2.2.0`、`CURRENT_PROJECT_VERSION = 12`）；`Localizable.xcstrings`（`json.load` 通过，1400 个上游 key 全部存在，另加 4 个仅本地 key）；3 个 Swift 文件用「上游新增行是否仍在」比对：ChatShellView 45/45、NewSessionView 10/10、SessionChatView 71/71 全部保留 |
| 2 | 树级 diff 只剩本地自留改动；`corepack yarn typecheck` 通过（无重复方法） | pass | `git diff --stat origin/main main` = 100 文件，全部可归为本地自留：`.specrune/**`（本地规范/会话）、`connector/**`（本地透传 + 具名错误）、`dsh-bridge-next/**`（技能目录/model 选择器）、iOS Duo 分叉（`Compact*`、`SidebarDrawer`、`ChatPageToolbar` rail、`specrune-logo`、AppIcon）、`server/run_local.py`。`cd dsh-bridge-next && corepack yarn typecheck` → exit 0；`commands.ts` 方法名去重无重复项 |
| 3 | `corepack yarn check` 通过；2 个跳过用例仅 `AGENT_SERVER_TEST_DB_URL` | pass | `corepack yarn check` → exit 0；`tests 243 / pass 241 / fail 0 / cancelled 0 / skipped 2`。两个 skip 点唯一：`tests/integration/runtime-events.test.ts:594`、`tests/integration/user-questions.test.ts:245`，条件均为 `skip: !process.env.AGENT_SERVER_TEST_DB_URL && 'AGENT_SERVER_TEST_DB_URL is not set'` |
| 4 | tarball 含 6 个白名单文件、无 `src/` 与 `node_modules/`、版本 2.2.0 | pass | `tar -tzf` 共 330 项，含 `package/package.json`、`package/lib/index.js`、`package/lib/client.js`、`package/locale/zh.json`、`package/cordis.patch.yml`、`package/NOTICE`；`grep -c '^package/src/'` 与 `node_modules` 均为 0；`tar -xzOf ... package/package.json` → `"version": "2.2.0"`；`npm pack --dry-run --ignore-scripts` 同样 330 files / 1.1 MB / 4.1 MB unpacked；sha1 `db0ab5a2…`、sha512 `tgzkDNRR…` 与 `INSTALL.md:23-24` 一致；`lib/bundled-connector/` 312 项与 `INSTALL.md:128` 一致；`diff -rq` 证明 tarball 内 Connector 源码与工作树 `connector/` 逐字节一致（仅缓存目录除外），tarball 不是旧树产物 |
| 5 | `INSTALL.md` 覆盖两种安装方式、版本兼容、数据目录、卸载/回滚、包含与不包含 | pass | `dist/dsh-remote-control/INSTALL.md`：插件页安装 `:42-58`、CLI `dsh plugin --profile desktop add <tgz>` `:60-76`（与本机 `dsh 0.2.2-rc.1` 的 `dsh plugin --help` 一致：`--profile <name>` + pnpm 透传 `add`）、版本兼容 `:78-92`（peer `>=0.2.0-rc.1 <0.3.0-0`、cordis/schemastery 范围与 `package.json` 一致）、数据/日志目录 `:94-99`（`~/.agents-anywhere/dsh-bridge-next/`、卸载不删）、卸载与回滚 `:101-117`、包含/不包含 `:119-137`（明示无 `src/`、无 `node_modules/`、无宿主 `@deepseek-ai/*`） |

补充核对（不在 AC 内，但属于本次交付的事实声明）：

- 版本一致性：`dsh-bridge-next` / `web-next` / `desktop-workbench` / `connector` / `server` 均为 `2.2.0`；Android `versionName = "2.2.0"`；iOS `MARKETING_VERSION = 2.2.0`、build `12`。全部 2.2.0。
- `IPHONEOS_DEPLOYMENT_TARGET = 26.3` 是**本地有意保留**，不是丢上游：分叉点 `34f7cbf5` 与上游 `986fc8f5` 都是 `26.5`，本地提交 `1b7e683e chore(ios): 部署目标降至 26.3——支持 iPad Pro 11寸(2nd gen, iOS 26.3.1)` 降到 26.3；同步窗口内上游没有再动过部署目标（`git log -S'...= 26.5' 34f7cbf5..986fc8f5` 为空）。
- `dist/` 为交付物且已入库（`git ls-files dist/` 命中两文件）；`HEAD` 相对 `5806d96b` 只多 `dist/` 两文件，故 `INSTALL.md:25` 的「构建来源提交 5806d96b」属实。
- 合并语义抽查：`commands.ts` 本地技能目录（`:138-148` list、`:231-247 executeSkill`）与上游 `/plan` 门控（`:98-100 planModeAvailable`、`:118`、`:158`）并存，构造函数 5 参（`:44`）与 `native.ts:80` 的 5 实参一致；`connector/.../runtime.py` 保留本地透传（`list_commands` 只剔除「plan 且 planning 端口不可用」）与上游 planning 分支，`_commands_unavailable` 仍在两处调用，错误处理未丢；连接器 `uv run pytest tests/test_dsh_commands.py -q` → 52 passed。
- iOS 静态检查：`xcrun swiftc -parse`（251 个 app 源文件）exit 0；`LocalizationProbe.swift` 单独 parse 也 exit 0。`swiftc -typecheck` 被 `no such module 'Textual'`（本地 SPM 未构建）挡住，符合 PRD「无 Xcode 环境以静态检查为准」。

## Findings

### Blocker

无。

### Major

无。

### Minor

无。

### Nit

1. **`.gitignore:55` 与 `:29` 重复 `.worktrees/`**（main 与工作树一致）
   证据：`git show main:.gitignore | sort | uniq -d` → `.worktrees/`；`git diff origin/main main -- .gitignore` 只显示 `+.worktrees/`，说明上游 `:29` 已有，并集合并又在文件尾追加了一次。
   影响：无功能影响（同一模式重复）。
   修复：删除 `:55` 那一行，保持单一来源。

2. **`Localizable.xcstrings` 被整体按码点重排，产生 12,874 行改动**
   证据：`main` 的 key 序列满足 `keys == sorted(keys)`（首键为 `""`），上游与分叉点均不满足（首键为中文 key）。上游 1400 个 key 一个没丢，本地 4 个 key 也都在，内容正确；差异几乎全部来自顺序。
   影响：`upstream-sync.md` 明确要求「按键排序」，所以这是按契约执行，不算违规；但每次同步都会让整个文件重新冲突，review 时也难看出真实内容变化。
   修复（建议，非阻塞）：在 `.specrune/spec/ios/upstream-sync.md` 补一句「本地 xcstrings 按码点排序，与 Xcode 写入顺序不同，整文件 diff 属预期」，避免下次同步把它当坏合并。

3. **`Localizable.xcstrings` 中 `回复`、`设置与账号` 两个 key 的 `localizations` 为空对象**
   证据：`json` 解析后两条均为 `{}`；它们在分叉点与上游都不存在，但 `baac287e`（合并前的本地 main）里已经是 `{}`，即合并前的既有状态，不是本次 union 引入。
   影响：`回复` 在 `Views/Chat/SessionTurnActions.swift:20` 被 `String(localized:)` 使用，缺翻译时回落到 key 本身（中文），英文界面会显示中文。
   修复：给两条补 `en`（如 `Reply` / `Settings & Account`）与 `zh-Hans`，或在确认不用后删掉。属既有问题，可留到后续 iOS 任务。

4. **`dist/dsh-remote-control/dsh-bridge-next-2.2.0.tgz` 以 1.1 MB 二进制入库，且不可逐字节复现**
   证据：`HEAD` 相对 `5806d96b` 只多该 tgz 与 `INSTALL.md`；重新 `yarn build` 后 `lib/index.js`、`index.d.ts`、`client.d.ts` 与包内逐字节相同，`lib/client.js` 仅 CSS-module 类名映射的键顺序不同（两者同为 244,440 字节），`npm pack --dry-run` 的 sha1 也与包内不同（gzip 打包非确定）。
   影响：无；只是「按 sha1 复现构建」不可行，`INSTALL.md` 已记录实际 sha1/sha512 供核对。
   修复：无需动作；若要可复现，可在打包后把 `npm pack` 输出的 shasum 直接写进 `INSTALL.md`（现状已经是真实值）。

## 未验证项（不是失败）

- 未做真实 iOS 构建/真机验证（PRD 已接受）；`swiftc -typecheck` 仅被未构建的 `Textual` SPM 模块阻断，符号一致性靠 `-parse` + 上游新增行比对 + 人工抽查。
- `runtime-events.test.ts:594`、`user-questions.test.ts:245` 两条跨 Python/后端集成测试因未设 `AGENT_SERVER_TEST_DB_URL` 跳过，合并后的端到端链路（技能/plan 实际过桥）未在本轮跑过；AC3 只要求跳过来自该变量，已满足。
- DSH Desktop「插件」页能否直接吃 tarball 绝对路径（`INSTALL.md:47-53`）无法在本机验证；文档已给出「只接受包名时改用命令行」的退路。

Candidate: green

Verdict: green（main session，review round 1，2026-11-13；无 Blocker / Major / Minor，4 个 Nit 不阻塞收尾）
