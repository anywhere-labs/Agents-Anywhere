# 设计：同步上游并独立打包 DSH 远程控制插件

## 边界与顺序

两件事共享同一棵工作树，且有先后依赖：插件包必须从**合并后**的源码构建，否则会把上游 #615 的远程面板修复漏掉。因此顺序固定为：

1. 在 `main` 上合并 `origin/main`，解决 8 个冲突。
2. 树级比对 + `dsh-bridge-next` typecheck，确认没有坏合并。
3. 构建并打包 `dsh-bridge-next`。
4. 在 `dist/dsh-remote-control/` 放 tarball 与安装说明。

当前分支 `feat/ios/duo-cover-original-shell` 是 `main` 的 7 个提交分叉。合并先在 `main` 完成；是否把 `main` 再合回该分支，等冲突成本明确后再决定（该分支已归档任务，继续合并只影响后续开发起点）。

## 冲突处置

按 `.specrune/spec/ios/upstream-sync.md` 的矩阵执行：

| 文件 | 处置 |
| --- | --- |
| `ios/.../project.pbxproj` | 取我们侧，保留 `DEVELOPMENT_TEAM=85V4S34K64`；合并后检查上游新增文件是否需要在 pbxproj 里补条目 |
| `ios/.../Localizable.xcstrings` | `git checkout --theirs` 后，以**上游 JSON 为底**，把仅本地有的 key 并回去，按键排序，`json.load` 验证 |
| `ios/.../ChatShellView.swift` 等 | 手工合并：保留本地 Duo 合盖外壳改动，同时吸收上游行为 |
| `connector/.../runtime.py` | 手工合并，保留双方逻辑 |
| `dsh-bridge-next/.../commands.ts` | 手工合并；重点检查是否出现第二个 `executeSkill` 之类的重复方法 |
| `.gitignore` | 取并集 |

## 打包形态

`dsh-bridge-next` 本身已经是完整 npm 包，不需要拆子模块：

- `yarn build` → `lib/index.js`（host）、`lib/client.js`（client）、`lib/bundled-connector/`（Connector 源码副本）。
- `npm pack` / `yarn pack` → `dsh-bridge-next-2.1.0.tgz`，按 `files` 白名单收包。
- 运行时依赖分两层：`dependencies`（`@dataiku/uv`、`meshcall`、`qrcode`、`clsx`、`lucide-react`）由 npm 安装；`peerDependencies`（cordis、typert、schemastery、react）由 DSH 宿主提供。

产物放到 `dist/dsh-remote-control/`，与源码构建目录分离，避免把 `dist` 混进 npm 包。

## 兼容与回滚

- 版本跟随上游：合并 `origin/main` 后 `package.json` 已是 `2.2.0`，peer 范围 `>=0.2.0-rc.1 <0.3.0-0`（cordis `~4.0.4 || ~4.1.0`、schemastery `~3.18.4 || ~3.19.0`）；不手工改回 `2.1.0`。
- 回滚：合并提交可 `git revert -m 1 <merge>`；tarball 是新增产物，删除 `dist/` 即回滚。
- 安装说明要写清「插件数据在 `~/.agents-anywhere/dsh-bridge-next/`，卸载不删除」。

## 备选方案

- **A. 直接 `yarn pack` 现有包（采用）**：改动最小，产物就是 DSH 官方支持的 npm 包形态；缺点是无法裁掉与本机 Connector 管理相关的代码。
- **B. 拆出新的子包/新仓库，只保留「远程控制」面板**：边界更干净，但要重新处理 host/client 入口、Connector 捆绑和 peer 依赖，且容易与上游插件演进分叉；本次不采用。
- **C. 只把 `lib/` 目录拷出来给用户**：不是标准安装包，DSH 插件页无法直接装；不采用。
