# Desktop Workbench

Agents Anywhere Desktop 把 Web 工作台与一个本地托管的 Connector 合并进同一个
Electron 应用。

Connector、它的日志、Desktop 设置与本地绑定都运行在一个独立的后端进程中
（`child_process.fork` + `ELECTRON_RUN_AS_NODE`）。后端绝不触碰窗口，因此后端被
阻塞或崩溃也不会冻结用户界面。后端提供回环 HTTP + SSE API；Electron Main 把它
重新暴露在应用 origin 的 `/desktop-api` 下，renderer 始终只与这个同源端点通信，
既看不到端口也看不到每次启动的 token。原生 shell 相关职责——窗口、托盘、更新、
通知、OAuth 与文件对话框——留在 Main，通过 IPC 交互。

```text
Renderer -> /desktop-api（同源） -> Electron Main -> 回环 HTTP+SSE -> Desktop 后端 -> anywhere-cli rpc -> Server
Renderer -> 窄口径 preload IPC --------------------------------------------------> Electron Main（窗口、更新、OAuth、对话框）
```

回环服务器开始监听后，后端立即上报就绪。Connector 属主检查、登录 shell 环境快照
与安装记账随后运行，都不会拖慢窗口。Connector 日志在到达 renderer 之前先合并成
批次，避免一个话痨 Connector 造成每行一次渲染。

在 Windows 上，关闭窗口会把它隐藏到系统托盘并保持本地 Connector 运行。点击托盘
图标或选择**打开 Agents Anywhere** 重新打开窗口；从托盘菜单选择**退出**确认退出
并停止本地 Connector，取消则应用继续运行。

## 运行

从仓库根目录，本地 Desktop 启动器会启动 Docker 支撑的 PostgreSQL 与 Redis、固定
端口 `8000` 的 Server、固定端口 `5174` 的 Web 应用（Desktop 的开发登录页），以及
固定端口 `5184` 的 Desktop。它会释放这三个应用端口上已有的监听，始终把 Desktop
指向本地 Server，并像 `./local-up.sh` 一样保持在前台，流式输出带前缀的 Server、
Web 与 Desktop 日志（同时写入 `.local-dev/logs/`）。Ctrl-C 停止它启动的所有进程；
`down` 可以停止仍在另一个终端里运行的启动器：

```bash
./desktop-local-up.sh
./desktop-local-up.sh down
```

使用 `./desktop-local-up.sh --skip-install` 复用已有依赖。

单独运行 Desktop：

```bash
cd desktop-workbench
yarn install
yarn dev
```

`yarn dev` 会从 `5184` 起找到第一个可用本地端口启动内置的 `renderer` Next 应用，
等待它就绪后打开 Electron。默认情况下，内置 Web 应用连接
`https://web.agents-anywhere.com`。Desktop shell 默认使用 `/api/v2` API
namespace。

## 登录与服务器配置

登录页提供 **Agents Anywhere Cloud** 和一个可展开的自托管服务器表单。两者都会
检查 `GET /api/v2/health`，并要求 `status: "ok"` 才进入登录。HTTP 错误、非法响应
与 10 秒超时都会停留在登录页，以便修正地址后重试。

`config.json` 是官方 Cloud 后端/Web origin、API namespace、健康检查超时与
Desktop OAuth client 设置的共享来源。构建与开发启动器读取同一个文件。OAuth
协议还必须与 `package.json` 中注册的 scheme 以及服务器第一方 client 注册表一致。

与 iOS 一样，Desktop 假定自托管服务器把 Web 应用暴露在同一 origin 上。它以
`response_type=code`、Desktop 的 client ID/redirect URI、随机 `state` 和 S256
PKCE challenge 打开 `WEB_ORIGIN/#/desktop-oauth`。`agents-anywhere-desktop://oauth/callback`
之后，Main 校验 `state`，并在所选后端的 `/api/v2/oauth/token` 交换 code 与原始
verifier。健康检查不提供也不发现 Web origin。

打包后的应用使用系统浏览器。开发模式使用一个独立的 Web 窗口走同样的 OAuth 流程，
直接拦截回调，不安装 OS 协议处理器。登录成功后，服务器会记住在 Electron
user-data 目录的 `desktop-server.json` 中；API 请求、下载与 WebSocket 都跟随该
服务器。Cloud 登录始终选择官方 Cloud 地址，忽略之前输入过的自托管地址。

对分离部署的 API/Web，把 `WORKBENCH_API_ORIGIN` 与 `WORKBENCH_OAUTH_WEB_ORIGIN`
设置为匹配的一对，然后在自托管表单里填该 API origin。覆盖只作用于该后端。开发
模式下，回环 API 端口 `8000` 默认对应 Web 端口 `5174`。

## Renderer 启动

让 Electron 指向一个已在运行的 Web 应用：

```bash
cd desktop-workbench
WORKBENCH_WEB_URL=http://127.0.0.1:5184 yarn start
```

针对静态导出运行：

```bash
cd desktop-workbench
yarn build:web
yarn start
```

要使用带默认 `/api/v2` namespace 的其他后端，需要提供用于浏览器 Desktop OAuth 的
配套 Web origin。本地开发默认把端口 `8000` 的 API 对应到端口 `5174` 的 Web 应用：

```bash
cd desktop-workbench
WORKBENCH_API_ORIGIN=http://127.0.0.1:8000 WORKBENCH_OAUTH_WEB_ORIGIN=http://127.0.0.1:5174 yarn dev
```

要使用根 API 路径的后端，显式提供空 namespace：

```bash
cd desktop-workbench
WORKBENCH_API_ORIGIN=http://127.0.0.1:8000 WORKBENCH_API_NAMESPACE= yarn dev
```

开发模式使用与打包应用相同的 `uv` 运行仓库级 `../connector` 项目，因此开发启动
不依赖开发者机器的 PATH。`yarn dev` 与 `yarn start` 在首次使用时把该 uv 下载到
`build/uv/<platform>-<arch>/uv[.exe]`（一次性的，之后缓存在 `.cache/uv` 下）；
`yarn ensure:uv` 做同样的事但不启动应用。

`uv` 的解析顺序是：已保存的 `uvPath` 设置，然后是内置的
`build/uv/<platform>-<arch>/uv[.exe]`（打包构建从 `resources/uv` 读取同一目录），
最后是 PATH 上的 `uv`。修改 `UV_BUNDLE_VERSION` 后可用 `yarn bundle:uv` 显式重新
打包，它同时会抓取随包分发的第三方许可声明。必要时覆盖 Connector 源或启动器：

```bash
WORKBENCH_CONNECTOR_DIR=/absolute/path/to/connector yarn dev
WORKBENCH_CONNECTOR_CLI=/absolute/path/to/anywhere-cli yarn dev
WORKBENCH_UV_BUNDLE_DIR=/absolute/path/to/uv-bundle yarn dev
WORKBENCH_PYTHON_BUNDLE_DIR=/absolute/path/to/python-bundle yarn dev
```

Python 解释器的解析顺序是：已保存的 `pythonPath` 设置，然后是
`build/python/<platform>-<arch>/` 的内置 CPython（Windows 为 `python.exe`，其他
平台为 `bin/python3`；打包构建从 `resources/python` 读取）。结果传给
`uv run --python`，因此 uv 既不搜索也不下载解释器。开发模式不会自动下载
bundle：在没有执行 `yarn bundle:python`（或之前的 `yarn pack`）时，uv 会自己挑选
解释器，可能会下载一个。bundle 存在之后开发模式也会使用它，uv 会在其上重建仓库
的 `connector/.venv` 一次。

之后的首次启动还会运行 `uv sync`，下载全部 Connector 依赖（没有内置解释器时包括
解释器本身）。属主探测等待它时窗口显示准备中界面；仅这个探测允许最多 15 分钟，
之后每个 RPC 都保持 30 秒期限。当既有环境由另一个解释器创建时（例如 Desktop
内置 Python 之前用 uv 下载的 Python），处理方式相同：uv 会替换那个环境。已保存
的 `uvPypiIndexUrl` 镜像通过 `UV_DEFAULT_INDEX`、`UV_INDEX_URL` 与
`PIP_INDEX_URL` 覆盖包下载。已保存的 `uvPythonInstallMirror` 为 Python 解释器
下载设置 `UV_PYTHON_INSTALL_MIRROR`（为空时使用 GitHub python-build-standalone）；
它只在没有内置或已保存解释器时有意义，设置页会在其他情况下隐藏该配置。
`UV_HTTP_TIMEOUT` 默认 60 秒。

应用运行期间不要用同一份 Desktop 配置再启动第二个 Connector。独立 CLI 设备仍然
受支持，但应使用各自的配置。

## 检查

```bash
yarn typecheck
yarn test:main
yarn renderer:typecheck
yarn workspace agents-anywhere-desktop-renderer test
yarn workspace agents-anywhere-desktop-renderer protocol:check
```

`test:main` 覆盖 Desktop 配给、账号隔离、本地断开、本地与远程的重连行为、退出
处理、API 路由以及日志中的凭据脱敏。Renderer 测试覆盖配对、项目解析与排序、偏好
设置、剪贴板回退以及终端清单/恢复行为。这些检查都以 headless 方式运行，不需要
启动 Electron 或开发服务器。

## 打包

发布构建会打包 Connector 源（仅 `pyproject.toml`、`README.md` 与 `connector/`
包，与 DSH 插件一致；不含 `uv.lock`、测试或缓存）、平台专用的 `uv`，以及平台专用
的 CPython。依赖在首次运行时安装；Python 永远不会被下载。打包后的应用绝不在自己
的 bundle 内运行 `uv`：它先把内置源镜像到 `userData/connector-source/<content-hash>/`
（与 DSH 插件相同），让 `uv.lock` 写在那里，签名过的 bundle 保持不动：

```bash
yarn dist:mac               # macOS universal DMG（Apple Silicon + Intel）
yarn dist:mac --universal   # 一个覆盖 Apple Silicon 与 Intel 的 DMG
yarn dist:win               # Windows NSIS 安装器（x64）
yarn pack                   # 不打包的 Electron 应用
yarn dist                   # 当前主机平台发布（macOS 为 universal）
```

`dist`、`dist:mac` 与 `dist:win` 读取签名环境，以剥离签名材料的方式运行 `uv` 与
Python bundle 以及应用构建，然后只把它们交给 electron-builder。签名材料因此对
任何构建或测试子进程都不可见。加 `--arm64`、`--x64` 或 `--universal`（macOS）
选择架构，`--dir` 生成不打包构建。`dist:mac` 必须在 macOS 上运行，`dist:win`
必须在 Windows 上运行。

| 环境变量 | 作用 |
| --- | --- |
| `MAC_CERT_P12_BASE64` + `MACOS_SIGN_IDENTITY` + `CSC_KEY_PASSWORD` | 从 Base64 PKCS#12 做 macOS 签名，映射为 `CSC_LINK`/`CSC_NAME` |
| `CSC_LINK` + `CSC_KEY_PASSWORD`（`CSC_NAME` 可选） | 从证书文件或 URL 签名 |
| `CSC_NAME` | 选择一个 Keychain 身份；缺省时自动发现挑选一个 |
| `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID` | 通过 notarytool 公证 |
| `APPLE_API_KEY` + `APPLE_API_KEY_ID` + `APPLE_API_ISSUER` | 通过 App Store Connect API key 公证 |
| `APPLE_KEYCHAIN_PROFILE`（`APPLE_KEYCHAIN` 可选） | 通过已存储的 keychain profile 公证 |
| `WIN_CSC_LINK` + `WIN_CSC_KEY_PASSWORD`，或 `WIN_CERT_P12_BASE64` + `WIN_CSC_KEY_PASSWORD` | Authenticode 签名 |
| `CSC_IDENTITY_AUTO_DISCOVERY=false` | 强制不签名构建 |

一组凭据要么全配要么全不配：半配置的发布会在打包前失败。没有任何凭据时产出不
签名的构建，脚本会说明跳过了哪些步骤。签名后的 macOS 构建会运行 `codesign --verify`
（公证过的还会运行 `xcrun stapler validate`）。

设置 `UV_BUNDLE_TARGETS=all` 或逗号分隔的目标列表可以做多平台 artifact 准备；
`dist:mac --universal` 会自动准备两个 macOS `uv` 构建。打包构建把 Connector
虚拟环境、uv 缓存、配置、绑定与日志都放在 Electron `userData` 下；签名资源在
运行期间绝不被修改。`bundle:uv` 在把上游归档拷入 `build/uv` 之前会校验其校验和。

`bundle:python` 把一个 python-build-standalone CPython（`install_only_stripped`，
版本固定在 `scripts/prepare-python.mjs`）放到 `build/python/<platform>-<arch>/`，
对照发布版的 `SHA256SUMS` 校验，并缓存在 `.cache/python` 下。它会移除 Connector
从不加载的内容（Tk/Tcl、IDLE、turtle 示例与解释器自带的 pip），并在
`THIRD_PARTY_LICENSES` 下附带 CPython 许可证。`PYTHON_BUNDLE_TARGETS` 的选择方式
与 `UV_BUNDLE_TARGETS` 相同，`dist`/`dist:mac`/`dist:win` 准备的目标也与 `uv`
一致。macOS 与 Linux 解释器包含符号链接，请在 macOS 或 Linux 上准备。
`PYTHON_BUNDLE_VERSION` 与 `PYTHON_BUNDLE_RELEASE` 可选择其他构建，
`PYTHON_BUNDLE_MIRROR` 从具有相同发布布局的镜像下载，例如
`https://registry.npmmirror.com/-/binary/python-build-standalone`。在安装器压缩
之前，bundle 每个架构约增加 40 MB；macOS universal 应用同时携带两个架构。

## Desktop 更新

认证完成、工作台打开后，Main 会检查已保存服务器的 `/api/v2/health`。已认证会话
必须与保存的服务器匹配；登录页、缺失的服务器记录与默认配置都不会触发更新检查。
退出登录会取消进行中的工作并关闭更新对话框。服务器的 `version` 会与构建时记录的
Server 版本做数值比较，而不是与 `app.getVersion()` 比较。`yarn build:main`（以及
`yarn dev`、`yarn build`、`yarn dist:*`）会运行 `scripts/write-build-info.mjs`，
把 `server/pyproject.toml` 的版本复制进生成的 `build-info.json`。活的 Server 比
该基线新意味着存在更新的 Desktop 构建；否则 Desktop 与 Server 的 PATCH 版本可以
不同（见[版本号规则](../docs/versioning.md)）。不使用专门的发布 API。

针对较旧 Server 构建的 Desktop 会打开更新对话框，提供**忽略此版本**与**立即更新**。
点击外部与 Escape 不会关闭它，也没有关闭图标。忽略会把该服务器的精确版本持久化
在 `<Electron userData>/updates/state.json`，按服务器区分。更新的服务器版本会
再次提示。只要 Server 领先于构建基线，账号头像旁的下载图标就保持可见，包括忽略
某个版本之后。

分发前，把 `config.json` 里的 `updates.downloadUrl` 设置为固定的 HTTPS 安装器
地址。`.invalid` URL 是显式占位符，不会下载安装器。下载流式写入
`<Electron userData>/updates/downloads` 并显示进度，失败/退出时移除不完整文件，
完成后交给操作系统打开安装器。安装新应用仍由安装器完成。

## 共享本机记录

每次启动（包括 `yarn dev`）Main 都会校验自己的实际安装，并只把 `desktop` 字段
发布到 `<OS user home>/.agents-anywhere/connector-runtime.json`。未变化的安装
元数据不会重写。开发记录包含 Electron 可执行文件、项目路径与启动参数；打包记录
包含已安装的应用与可执行文件路径。DSH 插件只读这份元数据，不修改。

有序的 `connectorIds` 历史与运行时属主只由 Python Connector 维护。每次被接受的
启动（包括 CLI 与重连）都会把缺失的 ID 追加一次。Desktop 用与 Python 相同的短
文件事务写安装元数据，保留 ID、运行时属主与未知字段。宿主读取旧记录但不迁移；
Python 在一次成功写入时执行迁移。

Desktop 与 DSH 插件把本地 ID 与登录用户的服务器设备列表匹配。首次登录配给和
设备删除后的重新配对复用本地顺序中的第一个匹配 ID 并轮换其 token。交集为空时
创建设备；列表或 token 轮换失败会停止配给以供重试。Python 拒绝启动时私有绑定与
凭据都会保留，因此重试不会创建重复设备。token 保持私有。见
[共享记录契约](../contracts/local-machine/2.0/README.md)。

侧栏设备使用固定的中文拼音/名称排序与 ID 决胜，因此轮询、在线状态变化与同名设备
不会打乱列表顺序。

## Desktop 引导

Desktop 在 `#/onboarding` 拥有自己的引导流程：四页（认识 Agent → 配置设备 →
连接手机 → 准备就绪）原样复制自
`web-next/src/components/onboarding/reference`。只有数据来源不同——Desktop 配给
自己的本地设备，而不是读取插件交接的设备。完成页通过
`workbench:onboarding:complete` 记录完成；进入流程本身不记录。

| 入口 | 行为 |
| --- | --- |
| 用户正常启动 Desktop | 只显示一次，直到共享记录中存在 `onboarding.completedAt`。 |
| 来自 DSH 插件的 `agents-anywhere-desktop://onboarding?source=dsh-plugin&flowId=<id>` | 始终显示，无论标志是否存在。重复投递的 `flowId` 被忽略；每次新的点击开始新流程。 |
| 静默的登录项启动 | 从不显示，也从不记录。 |

标志保存在 `<OS user home>/.agents-anywhere/connector-runtime.json` 的
`onboarding` 下，由后端在安装元数据的同一短文件事务中写入，Main 在创建窗口前
读取。插件既不读也不写。引导入口绕过 Connector 属主检查，用户可以在本地
Connector 就绪前完成设置。开发构建不注册 OS 协议，插件入口通过 argv 而不是
`open-url` 到达。

## Connector 生命周期

启动互斥完全在 Python 中实现，并覆盖 CLI、Desktop 与 DSH 插件的 Connector。
Main 在配给之前调用 `connector.acquireOwnership`；Python 记录实际 PID 与启动
来源，并验证记录的 PID 仍指向那个 Connector 进程。它从不把 Electron 或 uv 父
进程当作属主。RPC 冲突使用 `-32009 / connector_already_running`。Desktop 显示
可重试的冲突并停止自动重启；RPC 通道保持可用，重试会再次询问 Python。
`connector.stop` 停止后端连接；只要那个 Python 进程存活就保留属主。显式 Quit
会终止它。下一次启动可以替换崩溃进程留下的记录。

- Desktop 登录成功复用匹配的本地设备，或用已认证用户的 Connector API 配给一个
  `connectorKind: "desktop"` 设备。
- 本地连接成功、重连、CLI 配对与配对码完成会刷新设备列表，不打开 Agent 快速设置
  对话框。
- Electron Main 持久化返回的 `connectorId` 与 `connectorToken`，再通过
  `connector.saveConfig` 发给 `anywhere-cli rpc`。
- 在 macOS 上关闭窗口保持应用与 Connector 在后台运行。显式 Quit 停止运行时并
  终止整个进程树。
- 开机自启、静默启动、自动启动 Connector、`uv` 路径、Python 路径、PyPI 镜像、
  Python 下载镜像与日志保留都是 Desktop 设置。设置页显示解析后的 uv 与 Python，
  并在使用内置或已保存解释器时隐藏 Python 下载镜像。
- 首次初始化且没有保存过镜像选择时，Main 检查操作系统首选语言：中文系统选择
  阿里云 PyPI 与 npmmirror 的 Python 构建，否则使用官方源。该选择在任何 `uv`
  配给进程之前持久化，并通过 `UV_DEFAULT_INDEX`、`UV_INDEX_URL` 与
  `PIP_INDEX_URL` 生效，无需 renderer 提示。既有选择（包括官方 PyPI）都会保留；
  恢复出厂会重新应用系统默认。
- 认证失败会上报给 renderer，且不会自动重试。重连必须在那台物理 Desktop 上确认。
- 恢复出厂会先在 Server 上吊销当前 Desktop 凭据。吊销失败不会悄悄抹掉唯一的
  本地绑定。经过显式的二次确认后，`forceLocal: true` 允许在无登录会话的情况下
  做离线本地重置；它同时清除 Electron web 存储与缓存。

## 工作台终端

终端使用与 Web 相同的 Connector 生命周期。打开终端工具时先查询所选设备与工作区
再创建 shell。重载 renderer 会从 Connector 恢复既有终端 ID 与输出；本地存储只
保存视图偏好，并限定在实际的服务器与账号上。关闭终端标签即关闭该终端。离开页面、
退出登录或退出 Desktop 都不会发送终端关闭请求。

Electron 不跟踪终端凭据、不把终端升级为持久模式、也不续租。常规的 Connector
清理规则继续负责：默认 30 分钟不活动，退出的记录保留 15 分钟。Desktop 退出时
内置的本地 Connector 仍会停止，因此其终端随该进程结束。运行在独立 Connector 上的
终端可以在其常规清理规则下保持可用。

## Token 边界

- renderer 只在显式的创建、重连、断开或恢复出厂调用中提供用户 token。
- 用户 token 由 Electron Main 短暂使用；绝不写盘、打日志或传给 Connector 进程。
- `connectorToken` 以受限文件权限持久化，但绝不通过 preload IPC 返回。
- Connector 只收到 `serverUrl`、`connectorId` 与 `connectorToken`，继续使用
  Connector 范围的认证。

## 说明

- 本包在 `renderer` 下内嵌了一份复制的 Next renderer。
- 仓库级 `../web-next` 应用不会被 desktop 开发脚本启动或修改。
- 把 `../web-next` 视为共享 renderer 代码的上游。同步源码、messages、public
  资产、脚本、测试与共享配置到 `renderer`，再重新套用 Desktop 专属的小型集成层。
- Desktop 专属行为包括 Electron 窗口与协议桥、renderer 包身份与端口、嵌套
  workspace 的 Next 配置、原生标题栏间距、窗口拖拽区域、shell 头部以及 Desktop
  侧栏行为。
- 不要从 `../web-next` 复制 `.next`、`node_modules`、`.yarn`、`out` 等生成或安装
  内容。
- 生产/静态模式期望 `renderer/out`，或自定义的 `WORKBENCH_WEB_OUT_DIR`。

2026-09-06 同步的共享 Web 修复包括设备配对、紧凑设置分区、项目/目录默认值与
创建、项目排序与展开持久化、工具卡片、文件编辑防护以及终端恢复。范围与验证见
[前端/Desktop 交接文档](../docs/migrations/main-to-v2/frontend-desktop-follow-up.md)。
配对与手机登录使用所选的公开服务器地址；原生 renderer URL 绝不作为连接地址共享。

### macOS universal 安装器

在 macOS 上，`yarn dist` 与 `yarn dist:mac` 默认为 Apple Silicon 与 Intel 构建
universal DMG，并为两个架构打包 uv。显式的 `--arm64` 或 `--x64` 构建仍可用于
诊断。两个命令使用相同的签名与公证凭据检查。

应用构建完成后可用 `yarn dist:mac --skip-build` 重试打包；它要求已存在的编译
产物与两个 uv bundle。修改应用源码后请执行完整构建。为 universal 打包，Yarn 会
安装可选原生依赖的两个 CPU 变体。

离线重试打包时，把 `WORKBENCH_ELECTRON_DIST` 设为一个包含两个 macOS 架构对应
Electron ZIP 的目录。
