# DSH Bridge Next

Agents Anywhere 的 DSH 插件。当前已实现**没有安装 AA Desktop 时，从 Web 登录到完成 onboarding** 的流程。AA Desktop 与承载插件的 DSH Desktop 是两个应用。

职责与后续开发见 [开发计划](./DEVELOPMENT_PLAN.md)，完整产品设计见 [Onboarding 业务方案](./ONBOARDING_PLAN.md)。

## 已实现

```text
DSH 设置 → Agents Anywhere → 在浏览器中登录
  → Web 登录 / 注册、授权插件
  → 插件 127.0.0.1 回调，交换用户凭据
  → 复用或注册本机设备，启动插件内部的源码 Connector
  → 等待服务端确认设备在线
  → Web 独立引导页：添加 Agent → 可选手机连接 → 设置完成
  → 点击“立即体验”进入 Web App
```

- 插件负责账号、设备凭据和自己启动的 Connector；账号与设备 token 不进入页面状态或跳转 URL。
- OAuth 使用临时回环端口、state、PKCE S256 和一次性授权码。取消、超时、重复回调有明确处理。
- 同一账号与服务复用已有设备。重试丢失的注册响应不会重复创建设备，失效凭据可恢复。
- Agent 配置展示设备上全部可添加项，可稍后添加。手机连接可跳过；下载和扫码内容直接嵌入页面。
- Web 完成页的桌面端下载和官网地址目前为空，显示“暂未开放”和“官网即将上线”。地址统一在 `web-next/src/lib/product-links.ts` 配置。Android 沿用现有 Releases 入口，iOS 下载入口暂未开放。
- 引导页关闭后，已上线的 Connector 继续运行；退出插件账号或卸载 Host 服务会停止插件自己的进程。

`src/host/dsh-runtime/` 仍是占位，本轮没有实现 DSH 会话、消息、模型等业务，也没有修改 Python DSH 适配器。引导完成代表设备连接与引导步骤完成，不代表本插件的 DSH 对话能力已实现。

## 本地构建与安装

需要 Node.js `^22.19.0 || >=24`、Corepack，以及运行 Connector 所需的 uv / Python 3.12+。项目使用 Yarn；DSH 安装命令内部使用其自己的包管理器。

```bash
cd /Users/t4wefan/code/github/Agents-Anywhere/dsh-bridge-next
corepack yarn install
corepack yarn check

DSH_HOME="$HOME/.dsh" npx -y -p @deepseek-ai/dsh@0.1.2-rc.1 \
  dsh plugin --profile desktop add "link:$PWD"
```

链接安装方式已在全新临时 `DSH_HOME` / profile 中验证，并通过 `--dump-config` 确认插件层。安装后重启目标 DSH Desktop，再打开设置中的 **Agents Anywhere**。

旧 `dsh-bridge` 如果还在管理同一个账号或设备，应先在 DSH 中停用旧插件，再测试 Next；本项目不会接管旧插件或 Desktop 的进程与凭据。

服务端和 Web 必须使用包含本次改动的版本：新增插件 OAuth client 与 Web 引导路由需要配套。自行启动仓库的本地 Server / Web：

```bash
cd /Users/t4wefan/code/github/Agents-Anywhere
./local-up.sh
```

该命令默认只启动 Server 和 Web。测试本流程时，Connector 由插件在授权后启动，无需传 `--with-connector`。默认服务地址是 `http://127.0.0.1:8000`，Web 地址是 `http://127.0.0.1:5174`；地址不同可在插件页面的“连接地址”中修改。远程部署使用 HTTPS，浏览器与插件 Host 必须在同一台机器。

本地扫码还要求手机能够访问服务地址；仅监听回环地址时可先跳过手机步骤。默认本地启动脚本需要 Docker 提供 PostgreSQL 和 Redis。

## 开发模式

```bash
cd /Users/t4wefan/code/github/Agents-Anywhere/dsh-bridge-next
corepack yarn dev
```

`dev` 监听并重新生成 `lib/`，无需每次创建压缩包或重新执行链接安装。启用官方 `client-hmr` 的 DSH Desktop 会自动加载前端 TSX 和 CSS 变化；未启用时刷新 DSH 页面。Host、依赖、manifest 或插件集合变化后重启目标 DSH 实例。此命令不启动 DSH、AA Server、Web 或 Connector。

构建时自动把仓库 `connector/` 的 Python 源码复制到 `lib/bundled-connector/`。发布内容不依赖旁边另一个仓库目录。开发时修改 Connector 源码后，重新执行 `build` 或重启 `dev` 以更新副本。虚拟环境在插件数据目录创建，不写入源码目录。

| 命令 | 用途 |
|---|---|
| `corepack yarn typecheck` | Host、Client、构建脚本类型检查 |
| `corepack yarn build` | 构建两端产物并复制 Connector 源码 |
| `corepack yarn dev` | 持续构建 |
| `corepack yarn check:build` | 产物导入、官方 UI 交互、CSS 热更新契约、Client 注册与释放、源码副本检查 |
| `corepack yarn test` | 单元与集成测试；先执行 build |
| `corepack yarn check` | 完整构建和自动化验证，可在 headless 环境运行 |

## 前端组件与样式

设置页通过官方 `settings.section` 扩展点挂载，使用 `@deepseek-ai/dsh-client-ui-primitives` 的 `Button`、`Input`、`StateDot`。这些组件由 DSH 的平台模块提供，插件不打包自己的副本；`clsx` 作为普通辅助依赖内联。

页面布局位于 `src/client/features/onboarding/section.module.css`，使用 CSS Modules 和官方 `--dsw-alias-*` / `--dsw-font-*` 主题变量。页面跟随 DSH 的明暗主题，不声明全局主题或固定颜色。

外部插件无法直接使用官方仓库未发布的构建 helper，因此 `scripts/client-css.ts` 按其输出契约处理 CSS：监听源文件、生成局部类名，在 Client factory 执行时注入带 `data-plugin` / `data-plugin-css` 的样式，供 DSH HMR 清理和重新加载。实现参考官方 `docs/web-styling.zh.md` 与 `packages/client/tsdown.client.ts`。

`check:build` 在 headless DOM 中加载真实官方组件，验证登录、取消、地址保存和设置页卸载；同时检查样式去重及 HMR 清理后的重新注入。Node 中的 CSS loader 仅用于验证，不进入插件产物。

## 配置与本地状态

Host 配置位于 DSH 的插件配置行。常用项如下：

| 配置 | 默认值 / 行为 |
|---|---|
| `apiBaseUrl` / `webBaseUrl` | 上述本地地址；页面保存的地址优先 |
| `stateRoot` | 操作系统用户主目录下 `.agentsanywhere/dsh-bridge-next` |
| `connectorSourceDir` | 包内 `lib/bundled-connector`；覆盖时必须为绝对路径 |
| `uvPath` | `UV_PATH` 环境变量或 PATH 中的 `uv`；GUI 找不到时填写 uv 可执行文件的绝对路径 |
| `autoStart` | `true`；Host 重载时尝试恢复已授权设备，首次安装不会自动启动 Connector |

数据目录中保存 `settings.json`、`account.json`、按服务和账号隔离的 `bindings/`、`connector/` 与 `connector-venv/`。凭据文件以原子替换方式写入，POSIX 权限为 `0600`。退出登录删除用户凭据并停止连接，保留设备绑定供下次复用。

同一数据目录只允许一个插件实例管理设备。插件根据规范化后的数据目录选取一个本机回环管理端口，由操作系统保证独占，异常退出后自动释放；该端口不提供 HTTP 或业务接口。端口若被其他程序占用会明确报错，不尝试抢占或启动第二个管理进程。

Desktop 检测每次读取固定的 `<操作系统用户主目录>/.agentsanywhere/desktop/install.json`，验证版本、平台和可执行路径。没有记录时提示“未找到安装记录”；记录损坏或路径失效时阻止进入本机管理流程。Desktop 的记录写入、安装未首启时的补查、协议唤起和 Desktop onboarding 属于后续工作。

## 验证范围

自动化覆盖实际 rc.1 Typert Gateway 对编译后 Host 的调用及卸载、OAuth 本地回调和二次跳转、设备复用、取消、重复操作，以及用独立 stdio 测试进程验证 Connector 启停。Web 测试实际挂载页面组件，覆盖 Agent 添加、手机跳过/扫码、二维码过期、权限检查和登录后的路由恢复。

本轮没有自动启动真实开发服务、登录真实账号或进行 DSH GUI 联调。首次手动联调时按上面的链路操作，确认 Web 完成页可达；Windows 实机进程行为仍需在对应环境验证。

## 目录职责

```text
src/contracts/          插件前后端共享接口，不包含 DSH Agent 协议
src/host/config.ts      连接地址、数据目录、运行路径
src/host/desktop/       共享安装记录的只读检测
src/host/onboarding/    OAuth 回调、流程状态和 Web 交接
src/host/account/       用户授权、设备绑定及凭据恢复
src/host/connector/     内部 Python Connector 的进程管理
src/host/rpc/           公开的设置页管理接口
src/host/storage/       私有文件存储与实例锁
src/host/dsh-runtime/   待实现的 DSH Agent 业务
src/client/            DSH 设置页和 Host 调用
scripts/               构建、源码复制与产物检查
tests/                 单元及集成测试
```

Host 输出 `lib/index.js`，Client 输出 DSH 模块加载格式的 `lib/client.js`，不能当独立网页打开。目标 Harness 为 `0.1.2-rc.1`；Cordis、Typert 与 Schemastery 使用 Host 提供的 peer 依赖，以免破坏服务类型身份。依赖、构建产物和锁文件遵循仓库现有忽略规则。
