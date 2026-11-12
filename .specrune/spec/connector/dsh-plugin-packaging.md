# DSH 插件独立打包契约

来源：2026-11-13 首次把 `dsh-bridge-next/` 提取为独立安装包。

## 包是什么

`dsh-bridge-next/` 就是 DSH 侧栏「远程控制」插件（`src/client/index.tsx`
注册 `sidebar.footer.action`），npm 包名
`@agents-anywhere/dsh-bridge-next`。它本身是完整 npm 包，不需要拆子模块；
「独立」指产物可脱离本仓库其他目录安装。

## 构建与打包

1. `cd dsh-bridge-next && corepack yarn check`（check:deps + typecheck +
   build + check:build + test）。
2. `npm pack --ignore-scripts --pack-destination ../dist/dsh-remote-control`
   —— 必须 `--ignore-scripts`，否则 `prepack` 会再跑一遍 `yarn check`。
3. 产物改名为 `dsh-bridge-next-<version>.tgz`，并写
   `dist/dsh-remote-control/INSTALL.md`（安装、兼容、数据目录、卸载/回滚）。

## 产物边界

- 必须含：`package/package.json`、`lib/index.js`、`lib/client.js`、
  `lib/bundled-connector/`、`locale/zh.json`、`locale/en.json`、
  `cordis.patch.yml`、`NOTICE`。
- 不应含：`src/`、`tests/`、`scripts/`、`node_modules/`。
- `dependencies` 是安装方从 registry 解析的 5 个包；`peerDependencies`
  （cordis / typert / schemastery / react）由 DSH 宿主提供。宿主还提供
  `@deepseek-ai/dsh-commands`、`dsh-llm`、`dsh-session`、
  `dsh-session-title` 等未声明的包，裸 Node `import lib/index.js` 会
  `ERR_MODULE_NOT_FOUND`，属既有形态。
- 版本跟随上游 `dsh-bridge-next/package.json`，不手工改；MINOR 升级时
  插件与 Connector / Server 要一起升。

## 校验

`tar -tzf` 抽查白名单、`npm pack --dry-run` 对文件数/大小、临时目录
`npm install --ignore-scripts <tgz>` 能解析。tarball 不保证逐字节可复现
（CSS-module 键序、gzip），`INSTALL.md` 记录实际 sha1 / sha512。
