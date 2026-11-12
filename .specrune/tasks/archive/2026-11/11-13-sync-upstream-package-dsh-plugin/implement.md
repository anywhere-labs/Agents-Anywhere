# 实施清单：同步上游并独立打包 DSH 远程控制插件

## 前置

- [ ] 工作树当前在 `feat/ios/duo-cover-original-shell`；确认 `.specrune/` 的未提交改动与 `.agents/skills/` 不会被合并覆盖（合并前先提交或 stash）。
- [ ] `git fetch origin --prune` 已完成，`origin/main` = `986fc8f5`。

## 同步上游

- [ ] `git checkout main`，确认 `main` = `baac287e`。
- [ ] `git merge --no-ff origin/main`，逐项处理 8 个冲突：
  - [ ] `.gitignore`：取并集。
  - [ ] `connector/connector/runtimes/dsh/runtime.py`：保留双方逻辑。
  - [ ] `dsh-bridge-next/src/host/dsh-runtime/commands.ts`：手工合并，检查重复方法。
  - [ ] `ios/.../project.pbxproj`：取我们侧（`DEVELOPMENT_TEAM=85V4S34K64`）。
  - [ ] `ios/.../Localizable.xcstrings`：程序化 union + JSON 校验。
  - [ ] `ios/.../NewSessionView.swift`、`SessionChatView.swift`、`ChatShellView.swift`：手工合并。
- [ ] `grep -rn '^<<<<<<<\|^>>>>>>>'` 确认无残留冲突标记。
- [ ] `git diff --stat origin/main main` 检查只剩本地自留差异。
- [ ] `cd dsh-bridge-next && corepack yarn typecheck`（重点抓 `commands.ts` 重复定义）。

## 打包插件

- [ ] `cd dsh-bridge-next && corepack yarn check`（typecheck + build + check-build + test）。
- [ ] `npm pack --pack-destination ../dist/dsh-remote-control`（或 `yarn pack --out`），确认文件名 `dsh-bridge-next-2.2.0.tgz`（合并后上游版本）。
- [ ] `tar -tzf` 校验白名单文件存在，且没有 `src/`、`node_modules/`、`.map` 之外的意外内容。
- [ ] 写 `dist/dsh-remote-control/INSTALL.md`。
- [ ] 可选：在临时目录 `npm install --ignore-scripts <tgz>` 验证可解析。

## 风险与回滚

- `commands.ts` 自动合并可能追加重复方法 → typecheck 必须过。
- xcstrings 手工去标记会坏 JSON → 用 Python `json.load` 验证。
- pbxproj 取我们侧可能丢上游新增文件条目 → 合并后检查 `git diff origin/main -- '*.pbxproj'` 是否只有签名/构建号差异。
- 回滚：`git reset --hard ORIG_HEAD`（合并前记录）或 `git revert -m 1 <merge>`。
