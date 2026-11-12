# 同步上游并独立打包 DSH 远程控制插件

## Goal

把 `origin/main` 上落后的 92 个提交合并进本地 `main`，并按仓库已有的上游同步契约解决冲突；同时把仓库里的 DSH「远程控制」插件 `dsh-bridge-next/` 提取为一个不依赖本仓库其他目录、可直接安装的独立包。

## Confirmed Facts

- 本地 `main` 与 `origin/main` 的分叉点是 `34f7cbf5`；`main` 领先 96 个提交，落后 92 个提交。
- 双方都改过的文件有 13 个；`git merge-tree` 预演得到 8 个内容冲突：`.gitignore`、`connector/connector/runtimes/dsh/runtime.py`、`dsh-bridge-next/src/host/dsh-runtime/commands.ts`、iOS 的 `project.pbxproj`、`Localizable.xcstrings`、`NewSessionView.swift`、`SessionChatView.swift`、`ChatShellView.swift`。
- 仓库已有 `.specrune/spec/ios/upstream-sync.md` 规定冲突处置：pbxproj 取我们侧（保留 `DEVELOPMENT_TEAM=85V4S34K64`）；xcstrings 用程序化 union；自动合并后要树级比对，防止 `commands.ts` 出现重复方法定义。
- `dsh-bridge-next/` 就是 DSH 侧栏「远程控制」插件：`src/client/index.tsx` 注册 `sidebar.footer.action`，文案为「远程控制」；npm 包名 `@agents-anywhere/dsh-bridge-next`，当前版本 `2.1.0`。
- 该插件已具备独立打包条件：`package.json` 的 `files` 覆盖 `lib`、`locale`、`cordis.patch.yml` 和文档；`yarn build` 会生成 host/client 两个 bundle，并把 Connector 源码复制进 `lib/bundled-connector`。
- 本机环境：Node `v26.11.1`、Yarn `4.18.0`；`dsh-bridge-next/node_modules` 已存在；`corepack yarn build` 实测成功（exit 0）。
- 上游本次包含与插件直接相关的修复：`25ab3150 fix(dsh): 修复其他插件浮层导致远程控制面板无法关闭 (#615)`，合并后应一并带上。

## Requirements

- 在 `main` 上完成 `origin/main` 合并，冲突处置遵循 `upstream-sync.md`；合并结果不能丢掉本地 iOS Duo 分叉。
- 合并后做树级比对，确认 `dsh-bridge-next` 没有重复方法定义或坏合并，并跑通该包的 headless 检查。
- 从合并后的源码构建 `dsh-bridge-next`，产出可安装的 tarball；tarball 必须包含运行所需的 `lib/`、`locale/`、`cordis.patch.yml` 和 `package.json`。
- 提供中文独立安装说明，覆盖 DSH Desktop 插件页安装、命令行 `dsh plugin add <tarball>` 安装、版本兼容与卸载/回滚。
- 不修改插件业务功能；打包只是把现有模块独立出来。

## Acceptance Criteria

- [x] `main` 已包含 `origin/main` 的全部 92 个提交，合并后工作树无冲突标记；8 个冲突文件按 `upstream-sync.md` 处置（pbxproj 取我们侧、xcstrings 程序化 union、Swift 文件手工合并）。证据：`git rev-list --count main..origin/main` = 0；`41f3f4ec` 父提交为 `baac287e` + `986fc8f5`；review.md AC1。
- [x] 合并提交后 `git diff --stat origin/main main` 只剩本地自留改动，且 `cd dsh-bridge-next && corepack yarn typecheck` 通过（无重复方法定义等坏合并）。证据：100 文件均为本地自留；typecheck exit 0；`commands.ts` 仅 1 处 `executeSkill`；review.md AC2。
- [x] `cd dsh-bridge-next && corepack yarn check` 通过（typecheck + build + check-build + test）；若有仅由本机环境导致的失败，在任务记录里逐项写明。证据：exit 0，243 tests / 241 pass / 0 fail / 2 skipped（仅 `AGENT_SERVER_TEST_DB_URL`）；review.md AC3。
- [x] 产出 `dsh-bridge-next-2.2.0.tgz`（合并后上游版本），`tar -tzf` 能看到 `package/package.json`、`package/lib/index.js`、`package/lib/client.js`、`package/locale/zh.json`、`package/cordis.patch.yml`，且 tarball 大小与 `npm pack --dry-run` 清单一致。证据：330 项、含 NOTICE、无 `src/`/`node_modules/`；sha1 `db0ab5a2…`；review.md AC4。
- [x] `dist/dsh-remote-control/INSTALL.md` 给出 DSH Desktop 插件页与命令行两种安装方式、版本兼容范围、卸载与回滚步骤，并说明包内包含什么、不包含什么。证据：INSTALL.md:42-137；review.md AC5。

## Deliverables

- `main` 上的上游合并提交（含冲突处置）
- 独立安装包 `dsh-bridge-next-2.2.0.tgz`
- 独立安装说明 `dist/dsh-remote-control/INSTALL.md`

## Out of Scope

- 不推送 `origin` / `fork`，不建 PR（除非收尾时用户另行要求）。
- 不改 iOS 业务逻辑，只解决合并冲突；不重跑 iOS 真机构建（无 Xcode 环境时以静态检查为准）。
- 不发布到 npm registry，不做签名/公证。
- 不把插件拆成新的子模块或新仓库；「独立」指产物可脱离本仓库安装。

## Open Questions

- 无阻塞问题。假设「同步上游」指更新本地 `main`；当前分支 `feat/ios/duo-cover-original-shell` 是否跟进合并由收尾时按冲突成本决定并记录。
