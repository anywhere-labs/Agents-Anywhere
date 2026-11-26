# Agents Anywhere v3 Desktop（`desktop-v3`）

> **已停用（2026-11-26）**：旧 v3 实现，已移入 `_deprecated/`，不参与构建与 CI。v3 按 [新版全栈架构](../../docs/v3/next-architecture-proposal.md) 干净重写；需要复用某个模块时把它移回新项目并按新架构改写。

v3 的桌面客户端（Electron + TypeScript）。它做三件事：

1. **在本地提供 v3 Web 工作台**：把 [`web-v3`](../web-v3/) 构建成静态导出打进安装包，用自定义协议 `app://aa/` 加载，**从不加载远程页面**。所以在端到端加密模型里 Desktop 是「已验证客户端」（绿锁），见 [v3 新版全栈架构整理方案](../../docs/v3/next-architecture-proposal.md) 第 2 节。
2. **管理本机的 [`connector-v3`](../connector-v3/)**：随安装包分发，用 Electron 自带的 Node（`ELECTRON_RUN_AS_NODE=1`）作为独立的后台子进程运行，不再下载任何运行时。
3. **管理本机的 `meshcall-router`**：Connector 以 Local-First 模式启动（`start --local-router`），在 `127.0.0.1` 随机端口上拉起本地 Router；注册到控制面以后，同时挂到控制面的 Router 上。

关闭窗口只是隐藏窗口，Connector 和正在运行的会话继续在后台工作（托盘 / 菜单栏图标）；从托盘菜单或应用菜单「退出」才会停止 Connector 和本地 Router。

## 架构

```
desktop-v3/
  src/main/
    main.ts               主进程：窗口、托盘、单实例、agents-anywhere:// 深链、应用菜单、IPC
    app-protocol.ts       app://aa/：静态导出的路由映射 + 控制面 HTTP 代理
    connector-manager.ts  受管 Connector：启动参数、状态、注册（调用 CLI）、配对二维码、日志
    process-manager.ts    通用子进程托管：日志轮转、健康检查、指数退避重启、优雅停止
    admin-client.ts       Connector 本地管理 socket（与 connector-v3/src/cli.ts 同一协议）
    secure-store.ts       safeStorage（系统钥匙串）加密的密钥存储
    settings-store.ts     桌面设置（默认控制面地址）
    shell-env.ts          读取登录 shell 的环境变量（PATH），让 Connector 找到 claude、codex、agy、pi 等
    deep-link.ts          agents-anywhere:// → 工作台路由
    paths.ts              开发与安装包里的各种路径
  src/preload/preload.ts  window.aaDesktop：最小的类型化桥接（contextIsolation + sandbox）
  src/shared/bridge.ts    主进程 / preload / 渲染进程共用的 IPC 通道与类型
  scripts/
    build-web.mjs         AA_DESKTOP_EXPORT=1 构建 web-v3 静态导出 → build/web
    bundle-connector.mjs  构建 connector-v3，连同生产依赖闭包和本平台 Router 二进制 → build/connector
    after-pack.cjs        electron-builder 不会复制 extraResources 里的 node_modules，打包后补上
    dev.mjs               yarn dev
  tests/                  进程托管、密钥存储、协议映射与代理、Connector 管理的单元测试
```

### 进程关系

```
Agents Anywhere（Electron 主进程）
└── connector-v3（Electron 以 Node 方式运行：desktop-entry.mjs start --local-router）
    ├── meshcall-router（127.0.0.1 随机端口，--shutdown-on-stdin-close：Connector 退出它就退出）
    └── 各会话的 ACP Agent 进程（claude / codex / agy / pi …）
```

- **健康检查**：每 10 秒通过管理 socket 问一次 `status`，连续 3 次没有回答就重启 Connector。
- **重启退避**：意外退出后按 1s、2s、4s… 最长 30s 重启；连续运行满 60s 后退避清零。
- **停止**：先 SIGTERM（Connector 会停掉 Router 和 Agent），10s 内没退出再 SIGKILL。Connector 还会每 5 秒检查父进程，Desktop 异常退出时它自己结束。
- **日志**：`<应用数据目录>/logs/connector.log`，超过 5 MB 轮转为 `connector.log.1`；界面「这台电脑」卡片里可以查看。
- **数据目录**：`<应用数据目录>/connector-v3`（`identity.json`、`settings.json`、会话快照等）。用 `AA_DESKTOP_CONNECTOR_DATA_DIR` 可以改到别处，例如和命令行 `aa-connector` 共用 `~/.agents-anywhere/connector-v3`。

### Web 工作台怎么打包

`web-v3` 用 `AA_DESKTOP_EXPORT=1` 构建为静态导出（`output: "export"`，产物在 `web-v3/.next-desktop`，不影响同时运行的 `next dev`）：

- 动态路由（`/devices/[deviceId]`、`/sessions/[deviceId]/[sessionId]`）在导出时只为占位参数 `_` 生成一页（各路由的 `layout.tsx` 里的 `generateStaticParams`）。`app://` 协议把任意 id 的页面和 RSC 数据请求都映射到占位页；页面通过 `useRouteParams` 从地址栏读取真实 id，并在路径变化时重新挂载，和 Web 部署的行为一致。
- 普通 Web 构建（`output: "standalone"`）不受影响：`generateStaticParams` 返回空数组，所有 id 照旧按需渲染。
- `/api/control/*` 由主进程转发到设置里的控制面地址（相当于 Web 部署时 Next.js 的 rewrite）；登录页填写的绝对地址走 `/api/remote?url=…`，同样由主进程转发，所以控制面不需要为 Desktop 配置 CORS。
- 连接 MeshCall Router 的 WebSocket 请求去掉 `Origin` 头（和原生客户端一样），Router 不需要把 `app://aa` 加进 `--http-cors-origin`。

### 安全边界

- 渲染进程：`contextIsolation`、`sandbox`、无 Node；只允许 `app://aa` 内导航，其他链接交给系统浏览器；拒绝新窗口和 `<webview>`。
- 只有来自 `app://aa` 页面的 IPC 调用会被处理。
- 客户端 E2E 私钥和各账号的 refresh token 通过 `window.aaDesktop.secureStore` 存进系统钥匙串（Electron `safeStorage`，加密后写入 0600 的 `secure-store.json`）；IndexedDB 里只留占位符。Linux 上没有密钥环（`basic_text`）时视为不可用，回退到和浏览器相同的行为。
- 注册设备时 access token 只通过环境变量交给一次性的 `aa-connector register` 进程，不出现在命令行参数里，也不会传给常驻的 Connector。
- 配对链接带有配对密钥，二维码在主进程本地生成，不经过服务端。

## 首次使用

1. 打开 Desktop，在登录页登录控制面（默认地址见下文「配置」；也可以点「编辑」填写别的控制面）。
2. 首页「这台电脑」卡片显示本机 Connector 和本地 Router 的状态。填写设备名称、选择「普通模式」或「加密模式」，点「注册这台电脑」。Desktop 会停下 Connector、调用 `aa-connector register`、再以注册后的身份重新启动。
3. 加密模式下，先点「配对本应用」（Desktop 通过本机管理 socket 拿到一次性配对链接，直接与本机设备完成 Noise 配对，显示绿锁），再用「配对其他设备」显示二维码给手机等客户端扫描。

## 命令

```bash
cd desktop-v3
corepack yarn install

corepack yarn dev            # 编译主进程；build/web 或 build/connector 不存在时先构建；启动 Electron
corepack yarn dev --rebuild  # 强制重新构建 web-v3 静态导出和 connector 包
corepack yarn build          # 编译主进程 + 构建 web-v3 静态导出 + 打包 connector-v3
corepack yarn typecheck
corepack yarn test           # 单元测试（不启动 Electron）
corepack yarn package        # electron-builder：macOS dmg/zip、Windows NSIS、Linux AppImage/deb（未签名）
corepack yarn package:dir    # 只生成未压缩的应用目录，便于本地检查
```

`build:web` 和 `build:connector` 会在 `../web-v3`、`../connector-v3` 里安装依赖并构建；用 `AA_DESKTOP_WEB_SRC`、`AA_DESKTOP_CONNECTOR_SRC` 可以指向别的检出目录。

在隔离环境里调试（不碰真实数据）：

```bash
AA_DESKTOP_CONTROL_URL=http://127.0.0.1:8790 corepack yarn dev \
  --user-data-dir=/tmp/aa-desktop-v3 --remote-debugging-port=9333
```

`--user-data-dir` 会同时隔离设置、钥匙串密文文件、日志和 Connector 数据目录。

## 配置

| 来源 | 作用 |
| --- | --- |
| `config.json` 的 `defaultControlUrl` | 打包进应用的默认控制面地址（目前是本地开发地址，v3 正式部署后改成线上地址） |
| `AA_DESKTOP_CONTROL_URL` | 覆盖默认控制面地址 |
| `<应用数据目录>/desktop-settings.json` | 用户保存的控制面地址（`window.aaDesktop.settings.setControlUrl`） |
| `AA_DESKTOP_CONNECTOR_DATA_DIR` | Connector 数据目录 |
| `AA_DESKTOP_LOCAL_ROUTER_PORT` | 本地 Router 固定端口（默认随机） |
| `AA_CONNECTOR_PRESETS` | 额外的 ACP Agent 预设文件，原样传给 `aa-connector start --presets` |
| `AA_DESKTOP_NO_CONNECTOR=1` | 启动时不拉起 Connector（只调试界面） |
| `AA_DESKTOP_WEB_DIR`、`AA_DESKTOP_CONNECTOR_ENTRY` | 开发时改用别处的 Web 静态导出或 Connector 入口 |

## 打包

- `electron-builder` 配置在 `package.json` 的 `build` 字段：`app.asar` 里是主进程、preload 和 Web 静态导出；`Resources/connector/` 里是 Connector（`dist`、`node_modules`、`desktop-entry.mjs`），因为 Router 是原生二进制，需要真实文件。
- 只会带上**构建机这个平台**的 `meshcall-router-<os>-<arch>` 包。为其他平台或 CPU 打包前，需要在 `connector-v3` 里装好对应平台的 Router 包（或在对应平台的机器上构建）。
- 目前不签名、不公证（macOS `notarize: false`），也没有自动更新。

## 已知限制

- 只在 macOS（arm64）上实际运行和打包验证过；Windows、Linux 的托盘、深链、钥匙串和打包都还没有验证。
- 未签名、未公证、无自动更新。
- OIDC 登录和 Tokens Anywhere 授权的回调地址由页面的 `location.origin`（`app://aa`）生成，外部身份提供方不会跳回这个地址；`agents-anywhere://auth/oidc/callback` 深链已经能打开对应页面，但 web-v3 还需要在 Desktop 里改用这个回调地址。
- 工作台目前只通过控制面的 Router 访问设备；本地 Router 已经在运行（断网时 Connector 也能在本机提供服务），但工作台还不会直接连本地 Router。
- 设备在控制面被删除后，Connector 拿不到 Router token 会按退避不断重启，「这台电脑」卡片会显示错误，但还没有「重新注册」入口。
- 控制面地址只能通过 `config.json`、环境变量或登录页的「编辑」修改，还没有单独的设置界面。
