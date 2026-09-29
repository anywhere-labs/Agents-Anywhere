<!-- tm_board_write · 2026-09-26T18:41:42.696Z · role=implementer · session=20260926-213919 -->
# OpenCode V2 插件加载 · 完全隔离实测报告（file 源）

> 任务：以完全隔离实验验证 OpenCode V2 如何加载我们的插件包，为"用户如何安装"敲定方案。
> 方法：仓库**只读**；一切操作在临时副本 + 临时 HOME 内完成。本机 opencode-cli **2.0.18**。

## 0. 一句话结论

**file 源（本地目录）的入口解析只看目录根的 `INDEX_FILES`（index.ts/tsx/js/mjs/cjs），package.json 的 `exports` 完全不参与；解析不到时【静默跳过】——既无 `loading plugin`，也无 `failed to load plugin`。**
因此「exports 指向 lib/index.js」这一形态在本机 file 源下**无论 lib/ 在不在都不加载**；而**只要仓库根放一个 index.ts/index.js，加载即成功，Bun 会直接编译 TS**。

## 1. 实验设置（隔离证据）

- 临时根：`C:\Users\34296\AppData\Local\Temp\opencode\aa-dist\`
- 副本（robocopy，**排除 node_modules**）：
  - `pkg-a`：原样（`exports:{".":{"types":"./lib/index.d.ts","default":"./lib/index.js"}}`），`lib/` 从仓库复制（存在）
  - `pkg-a-nolib`：同 pkg-a 但**删掉 lib/**
  - `pkg-b`：`exports` 改为 `".":"./src/server/index.ts"`、`"./tui":"./src/tui/index.ts"`（方案 B）
- 隔离：`USERPROFILE/HOME` 指向 `aa-dist\home`，`XDG_CONFIG_HOME=…\home\.config`（**不是** `…\.config\opencode`，否则会多套一层）、`XDG_DATA_HOME=…\home\.local\share`、`XDG_CACHE_HOME=…\home\.cache`。
  `opencode debug paths` 实测：config=`…\aa-dist\home\.config\opencode`、data=`…\home\.local\share\opencode`、log=`…\home\.local\share\opencode\log` → **用户配置与用户日志全程未被触碰**。
- 启动方式：`opencode-cli.exe run --standalone --print-logs --log-level info --agent build hello`（私有 server），每次跑 12–16s 后 `taskkill /PID <自己> /T /F`。
- 成功判据（双证据）：① 日志 `msg="loading plugin" … entrypoint=`；② 插件自身副作用 `<home>\.agents-anywhere\opencode-bridge\endpoints\<servicePid>-<port>.json`（每次运行前清空该目录）。

## 2. 矩阵结果

| # | spec 形态 | 入口文件 | 结果 |
|---|---|---|---|
| Z1 | 目录 pkg-a（exports→lib/index.js，lib **存在**，无根 index.\*） | — | **静默无操作**：无 `loading plugin`、无 `failed to load plugin`、endpoints 无文件 |
| Z7 | 目录 pkg-a-nolib（lib **缺失**，无根 index.\*） | — | **静默无操作**（同上，**没有任何报错**） |
| Z2 | 文件 `pkg-a/lib/index.js`（存在） | — | **静默无操作** |
| Z3 | 文件 `pkg-b/src/server/index.ts`（存在） | — | **静默无操作** |
| Z6 | 文件 `pkg-a/index.js`（存在，shim） | — | **静默无操作** |
| y3 | 目录 pkg-a + 根 `index.js`（`export {default} from './lib/index.js'`） | index.js | **加载成功** |
| Z4 | 目录 pkg-b + 根 `index.ts`（`export {default} from './src/server/index.ts'`） | index.ts | **加载成功**（TS 由 Bun 直接编译） |
| Z5 | 项目 `.opencode/plugins/aa-opencode/`（含根 index.ts），**无任何配置** | index.ts | **自动发现加载成功** |
| Z9 | 复现 Z4/Z5（同时存在时两行都加载） | index.ts ×2 | **加载成功 + 端点发布** |
| 对照 | 全局 config `plugins:["definitely-not-a-real-pkg@9.9.9"]` | — | `failed to load plugin … NpmInstallFailedError (cause: … 404 Not Found …)` → **证明 plugins 键确被读取** |
| 对照 | `file:///C:/definitely/nonexistent/thing.js` / `C:/definitely/nonexistent/thing.js` | — | `failed to load plugin … ENOENT: no such file or directory, stat 'C:/definitely/nonexistent/thing.js'` → **证明路径 spec 确被处理** |
| 对照 | 项目根 `opencode.json` 的 `plugins` 键（pkg-a 绝对路径） | — | **完全不加载**（无日志、无副作用）→ 项目级 config 的 plugins 键**不生效** |

## 3. 对两个方案的判定

### 方案 A（提交构建产物 lib/，exports→./lib/index.js）
- ① **lib/ 不存在**（Z7）：**不失败、不报错、静默不加载**。任务假设"应失败"**不成立**——它是**无声**的。
- ② **lib/ 已构建**（Z1）：**同样静默不加载**。
- → **按现状不可行**。只有在仓库根**另加一个 index.js shim** 后才可行（y3 证明，入口为根 index.js）。
- 结论：`lib/` 本身不是加载条件；**加载条件是目录根存在 index.***。

### 方案 B（仓库零产物，exports 直指 TS 源）
- 仅改 exports（pkg-b 目录，未加根 index.ts）：**静默不加载**。
- **加根 `index.ts` 后：加载成功**，`entrypoint=file:///…/pkg-b/index.ts`，Bun 直接编译 TS。Z4/Z5/Z9 三次复现。
- → **可行**，前提同样是**仓库根有 index.ts**；exports 改 TS 对 file 源**不是必要条件**（file 源不读 exports），但对 npm/git 渠道仍建议保留。

### `.tui` 入口（exports["./tui"]）
- 本轮**未观察到任何 `./tui` 被解析/加载的日志**。file 源的加载器按目录根 INDEX_FILES 取**唯一入口**，不消费 exports 子路径。
- Z4/Z5/Z9 的成功加载均只经 `.` 入口 → **`./tui` 在 file 源下未被加载**（判定：不可用 / 无对应通道）。
- 对照 P0：TUI 插件通道是 `role=cli / message="plugin reconciliation"`，属 CLI 侧，与本轮 server 侧无关。

## 4. 推荐方案（可直接写进 README）

**推荐：方案 B′ —— 仓库零构建产物 + 一个根 `index.ts`。**

### 4.1 需要修改 package.json（具体行）
```diff
-  "main": "./lib/index.js",
-  "types": "./lib/index.d.ts",
+  "main": "./index.ts",
+  "types": "./index.ts",
   "exports": {
-    ".": {
-      "types": "./lib/index.d.ts",
-      "default": "./lib/index.js"
-    },
-    "./tui": {
-      "types": "./lib/tui.d.ts",
-      "default": "./lib/tui.js"
-    },
+    ".": "./index.ts",
+    "./tui": "./src/tui/index.ts",
     "./package.json": "./package.json"
   },
   "files": [
-    "lib",
+    "index.ts",
+    "src",
     "README.md"
   ],
```
并**新增仓库文件** `opencode-plugin/index.ts`：
```ts
export { default } from './src/server/index.ts'
```

### 4.2 用户安装步骤（README 形态，二选一，均已实测）
**方式 1 — 项目级，零配置（推荐给开发者）**
```bash
# 目录内必须有 index.ts（本方案已提交）
mkdir -p .opencode/plugins/agents-anywhere-opencode
git clone https://github.com/<org>/Agents-Anywhere .tmp-aa
cp -r .tmp-aa/opencode-plugin/. .opencode/plugins/agents-anywhere-opencode/
rm -rf .tmp-aa
```
启动 OpenCode 即自动发现，无需任何配置。

**方式 2 — 全局配置加一行（推荐给普通用户）**
在 `~/.config/opencode/opencode.jsonc` 追加：
```jsonc
"plugins": ["file:///C:/绝对路径/Agents-Anywhere/opencode-plugin"]
```
（裸 `C:/…` 亦可；`plugin add` 命令只写全局配置，不写项目配置。）

### 4.3 自检（因失败是静默的，README 必须给出）
启动日志中应出现：`msg="loading plugin" … entrypoint=file:///<path>/opencode-plugin/index.ts`；
并出现端点文件 `~/.agents-anywhere/opencode-bridge/endpoints/<pid>-<port>.json`。两者缺一即未装上。

## 5. 风险 / 未证（交给 P3 落实前决策）

1. **git 渠道未在本轮实测**。用户日志里 `@te-river/opencode-team-mode@latest entrypoint=…/node_modules/<pkg>/dist/index.js` 说明 **npm/git 渠道会消费 exports/main**，与 file 源规则不同 → git 渠道下 `exports`→TS 是否被接受仍属未证。**建议两条渠道都覆盖**：保留 `exports`→TS，同时提交根 `index.ts`。
2. `index.ts` 内 `from './src/server/index.ts'` 这一带 `.ts` 后缀的 specifier 在 `tsc` 下可能需 `allowImportingTsExtensions`；本轮未跑 typecheck（副本无 node_modules）。P3 落实后应跑一次 `corepack yarn typecheck`；若有问题改写为 `'./src/server/index.js'`。
3. **静默失败是最危险的形态**：目录 spec 解析不到入口时**零日志**，用户完全无从察觉。任何安装文档都必须配 4.3 的自检步骤。
4. 项目根 `opencode.json` 的 `plugins` 键**不生效**（用户机器上 `opencode.json` 里还残留一个 `"plugin": []` 单数键）——不要把它写进安装文档。

## 6. 进程与文件清单

- 启动的进程：每次实验一条 `run --standalone`（父）+ 其子 `serve --stdio`，均在 12–16s 后按各自 PID 树 `taskkill /T /F`；**全部已关闭**。
- 结束时 `Get-CimInstance Win32_Process -Filter "name='opencode-cli.exe'"` 只剩用户自己的 **PID 9016**（`serve --service`），**全程未被干扰**；未占用 49374。
- 仓库：**未写入任何文件**（`opencode-plugin/index.ts`、`index.js` 仍不存在；`package.json`、`lib/` 原状）。
- 临时产物（保留，按要求）：`C:\Users\34296\AppData\Local\Temp\opencode\aa-dist\`（`pkg-base/pkg-a/pkg-a-nolib/pkg-b`、`proj-*`、`home\`、`logs\*.err|*.out` 全部原始日志）。
