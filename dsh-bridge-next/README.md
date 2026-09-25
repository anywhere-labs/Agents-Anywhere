# DSH Bridge Next

Agents Anywhere 的 DSH 插件。支持没有安装 AA Desktop 时的账号登录、手机扫码连接、本机 Connector 管理及 Web onboarding。AA Desktop 与承载插件的 DSH Desktop 是两个应用。

职责与后续开发见 [开发计划](./DEVELOPMENT_PLAN.md)，完整产品设计见 [Onboarding 业务方案](./ONBOARDING_PLAN.md)，检查命令与手动验收见 [验证记录](./VERIFICATION.md)。

## 已实现

```text
DSH 左侧边栏「设置」上方 → 远程控制 → 云端登录或连接自己的服务器
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
- 本机设备被删除时，点击“重新配置”会先创建并连接新设备，再打开 Web 完整引导。链接携带新设备 ID 和新的流程标识，从欢迎页开始，随后进入设备配置、手机连接和完成页；浏览器未自动打开时可点击“继续配置”。
- Agent 配置展示设备上全部可添加项，可稍后添加。手机连接可跳过；下载和扫码内容直接嵌入页面。
- Web 完成页的桌面端下载和官网地址目前为空，显示“暂未开放”和“官网即将上线”。地址统一在 `web-next/src/lib/product-links.ts` 配置。Android 沿用现有 Releases 入口，iOS 下载入口暂未开放。
- 引导页关闭后，已上线的 Connector 继续运行；退出插件账号或卸载 Host 服务会停止插件自己的进程。

插件界面跟随 DSH 的语言设置，支持中文和英文；切换语言后，已打开的面板和确认弹窗立即更新，并保留表单、二维码与日志展开状态。原始运行日志和用户提供的名称不做翻译。

侧栏「远程控制」提供三个标签页；登录和设置功能仍按 AA Desktop 检测结果开放：

- **登录和连接**：登录前可选云端或自建服务器；登录后显示头像、账号和 Connector 运行状态，提供打开 Web、手机连接和退出登录。手机连接按钮下方直接展开二维码，不显示安装链接；扫码后可确认或拒绝，过期可刷新，完成后显示手机已连接。关闭或切换页签停止前端轮询，退出登录和 Host 卸载清除内存中的二维码流程。
- **设置**：查看设备 ID 与服务器，启动、停止或重启 Connector；设置 uv 绝对路径（留空自动查找）、PyPI 镜像和同步间隔。插件启动时自动恢复已授权的本机连接，连接时始终同步已有会话，心跳与重连间隔分别固定为 20 秒和 3 秒。设置保存后重启正在运行的 Connector；停止状态下保存不会启动进程。
- **桥接日志**：只读取 Anywhere Bridge 的运行日志，显示最近 200 条，每 2 秒刷新，可暂停或手动刷新。即使 CLI 正占用 Connector、尚未登录、安装检测失败或 AA Desktop 已安装，也可以查看。记录连接、RPC、会话读取、快照、同步批次和 ACK；错误带会话标识、阶段、错误码和调用栈位置，不记录请求正文、原生事件内容、令牌或原始异常消息。
- **维护**：并排提供打开数据目录、打开日志目录和恢复出厂设置三个按钮，不展示数据与日志路径；headless 环境禁用打开目录。日志仅记录经过筛选的生命周期事件，滚动保留约两份 512 KiB 文件，不记录原始进程输出和凭据。恢复出厂设置先撤销当前设备凭据，再清理本插件的账号、绑定、同步缓存、日志及设置；服务端撤销失败时先保留本地状态，用户可另行确认仅清理本地。DSH 会话、运行时端点、共享 `connector-runtime.json` 和下载好的 Python 环境保留。

桥接日志另存于插件数据目录的 `logs/dsh-runtime.jsonl`，滚动保留当前和上一份约 2 MiB 文件；同时输出到 DSH 的 `agents-anywhere-runtime` 日志分类。默认位置为 `~/.agents-anywhere/dsh-bridge-next/logs/`，自定义 `stateRoot` 时跟随该目录。已有 Connector 生命周期日志继续单独保留。

已安装 AA Desktop 时连接功能仍显示原占位页，桥接日志始终可用，管理权限不自动切换。手机连接复用已有 `/auth/mobile-login/qr`、`status`、`confirm` 接口；二维码包含手机扫描协议要求的临时登录凭据，使用当前账号的后端地址，不使用 DSH 地址或 OAuth Web 开发端口。无需新增 AA Server 接口。

插件基于 DSH `0.1.7-rc.2`，支持附件和模型/effort/权限、Agent 模式配置。Runtime 提供 DSH 一键配置、官方侧栏过滤、原生会话和历史读取、首次完整校准、归档同步、实时事件、文本、图片和普通文件新建/续聊、中断、`ask_user_question` 以及受限操作的单次批准或拒绝。新建使用 AA 显式传入的模型和权限选择；已有会话可切换配置。AA 发来的 PNG/JPEG/WebP/GIF 使用图片接口，普通文件通过本机暂存文件和官方 `fileUploads.uploadStream` 上传，RPC 只传文件元数据。平台发出的附件保留 AA 文件引用；不回传 DSH 本地产生的附件。首次会话清单成功提交到平台之前，runtime 保持初始化状态；同步中断时自动重试。

实机日志定位到官方历史读取器拒绝一个序号不连续的会话，进而拖断整个同步流。当前通过 `ctx.sessionQuery` 读取，按会话隔离读取失败，保留 AA 已接收的历史，并允许后续刷新重试。图片及配置恢复后，包含坏历史的完整回传测试继续通过。桥接日志页、Python 启动互斥、ID 历史和 Desktop 安装信息职责调整保留；检查与实机状态见 [验证记录](./VERIFICATION.md)。

RPC 解析、执行、响应大小、取消和超时错误按请求返回，不会关闭已鉴权连接或取消其他请求。同步读取与投影按会话隔离；全局清单、ACK 超时或后端交付失败时只重建同步订阅，正常 RPC 继续可用。模型目录异常也不会关闭消息发送。AA Server 的会话操作检查与页面统一读取实时能力，避免旧缓存拒绝下一条消息；读取能力失败会明确报错并允许重试，不会默认为允许。

会话同步检查点由 Connector 保存到 `<dataRoot>/<connectorId>/<runtimeId>/sync-state.json`，沿用现有读写接口、数据源隔离以及定期/退出刷盘。runtime 首次启动时，Connector 将旧 `connector-state.json` 与 `connector-kv.json` 全量复制到实例目录，后者保存为 `kv.json`；已有实例目录不覆盖，旧文件保留。新版两端协商检查点协议后，历史相关批次等待服务端 ingestion 成功才推进状态；收页 ACK 或通知入队不算同步成功。DSH Host 重启或销毁后重连，会本地读取、重建投影并比较指纹：先重放至已提交检查点并校验历史前缀；匹配且检查点处已结束生成时，只上传后续事件产生的新增或修改项，未变化历史不再上传。检查点处仍在生成、历史前缀变化或出现删除项时，补该会话快照。清单、元数据、当前状态和待处理请求仍会校准，下一条在线事件继续增量同步。检查点缺失、格式/投影版本不匹配或旧版 Connector 连接时完整校准；手动刷新仍强制补该会话快照。本地仍需读取与重放历史，网络上传按后缀投影的变化项恢复。

原生历史读取失败只影响对应会话：桥接日志显示会话 ID、`read_failed` 和官方读取错误，其他会话继续同步；AA 已有历史不会被空快照覆盖。修复 DSH 原生历史后可刷新该会话重试，插件不会自行修改原始会话文件。

## 本地构建与安装

需要 Node.js `^22.19.0 || >=24`、Corepack，插件通过 npm 依赖 `@dataiku/uv` 提供 uv，运行 Connector 时按需准备 Python 3.12+。开发 Python 子项目时仍可使用本机 uv。项目使用 Yarn；DSH 安装命令内部使用其自己的包管理器。

```bash
cd /Users/t4wefan/code/github/Agents-Anywhere
uv sync --project connector
uv sync --project server

cd /Users/t4wefan/code/github/Agents-Anywhere/dsh-bridge-next
corepack yarn install
corepack yarn check

DSH_HOME="$HOME/.dsh" npx -y -p @deepseek-ai/dsh@0.1.7-rc.2 \
  dsh plugin --profile desktop add "link:$PWD"
```

链接安装方式已在全新临时 `DSH_HOME` / profile 中验证，并通过 `--dump-config` 确认插件层。安装后重启目标 DSH Desktop，点击左侧边栏「设置」上方的 **远程控制**。

Python 依赖用于跨语言测试，必须在首次执行 `check` 前准备。仓库不提交依赖锁文件；如果父目录存在本地 `yarn.lock`，导致 Yarn 报当前包不属于父项目，在本目录执行 `touch yarn.lock` 后再安装，声明独立项目边界。该文件继续遵循仓库忽略规则。

旧 `dsh-bridge` 如果还在管理同一个账号或设备，应先在 DSH 中停用旧插件，再测试 Next；本项目不会接管旧插件或 Desktop 的进程与凭据。

服务端和 Web 必须使用包含本次改动的版本：新增插件 OAuth client 与 Web 引导路由需要配套。自行启动仓库的本地 Server / Web：

```bash
cd /Users/t4wefan/code/github/Agents-Anywhere
./local-up.sh
```

该命令默认只启动 Server 和 Web。测试本流程时，Connector 由插件在授权后启动，无需传 `--with-connector`。在插件弹窗中点击“连接到你自己的 Agents Anywhere 服务实例”，只输入后端地址 `http://127.0.0.1:8000`，再点击“连接服务器”。插件先检查后端 `/api/v2/health`，通过后打开本地 Web 登录页。

地址规则与 Desktop 一致：支持省略 `https://`，允许末尾带 `/api/v2`，保存时规范化为服务器 origin。Web/OAuth 地址由后端推导，远程服务使用同源 Web；本地开发的 `localhost`、`127.0.0.1`、`[::1]` 的 `8000` 端口映射为 `5174`，其他端口保持原样。浏览器与插件 Host 必须在同一台机器。

“登录 Agents Anywhere Cloud”始终选择与 Desktop 相同的云端 `https://web.agents-anywhere.com`，不会沿用表单中输入的自建地址。本地测试请选择自建服务入口。已登录时，“继续设置”和 Host 重启恢复沿用当前账号的后端地址。

本地扫码还要求手机能够访问服务地址；仅监听回环地址时可先跳过手机步骤。默认本地启动脚本需要 Docker 提供 PostgreSQL 和 Redis。

若更新后 Web 报 `oauth client not found`，先确认正在运行的后端已加载新增的 `agents-anywhere-dsh-plugin` 内置 OAuth client。没有启用源码重载的旧进程需要重启；使用本仓库 Dev Control 时，可在仓库根目录执行 `./dev-control.sh restart server`，然后回插件重新发起登录。无需手动创建数据库中的 OAuth client。

升级到本版时同时更新插件和 Connector（插件构建会携带新版 Connector）。时间线投影升级为 v3，首次重连会重新校准旧 v2 检查点对应的历史，修复旧映射遗漏的工具结果和 PTC 子调用；之后恢复增量同步。CLI 管理的 Connector 也需要更新。

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
| `corepack yarn test` | 单元与集成测试；运行前需已完成 build 和 Python 依赖准备 |
| `corepack yarn check` | 完整构建和自动化验证，可在 headless 环境运行 |

## 前端组件与样式

入口通过官方 `sidebar.footer.action` 扩展点挂载，位于左侧边栏「设置」按钮上方。展开时显示 Lucide `Smartphone` 图标和「远程控制」，收起时只显示图标并提供名称提示。点击入口打开官方 `Modal` 弹窗，支持关闭按钮、Esc 和点击遮罩关闭；关闭后保留 Host 的连接状态，再打开时重新检查本机。插件不再向设置页面注册入口。

弹窗使用 `@deepseek-ai/dsh-client-ui-primitives` 的 `Modal`、`Tooltip`、`Button`、`Input`、`StateDot`。这些组件由 DSH 的平台模块提供，插件不打包自己的副本；`clsx` 和实际使用的 Lucide 图标内联进 Client bundle。

登录弹窗沿用 Desktop 的中文登录文案和简洁纵向布局。初始视图显示标题「登录到 Agents Anywhere」、说明、云端登录按钮和自建服务入口；展开后显示 OR 分隔、带服务器图标的单个地址输入框和「连接服务器」按钮。账号状态、连接进度和错误只在需要时显示。

登录成功后，整个弹窗切换为紧凑的「已登录」面板：账号头像、昵称、邮箱（有设置时）、当前服务器，Connector 运行状态，以及「打开 Web」「退出登录」两个按钮。头像来自账号接口；未设置或图片加载失败时显示 DSH 官方用户图标。旧账号的头像、邮箱会在打开面板时后台补全，读取失败时保留已有资料。

Connector 状态读取其现有 stdio `connector/state` 通知，反映实际运行任务而非仅判断 Python 控制进程存活。凭据失效后，Host 立即查询当前账号下的这个设备：确认已删除时，在 Connector 状态区域显示「本机设备已被删除，是否重新创建？」和「重新创建」按钮；设备仍存在时显示「本机设备已断开连接，是否重新连接？」和「重新连接」按钮。弹窗沿用每 1.5 秒的状态刷新，关闭弹窗不影响 Host 接收通知。

恢复必须由按钮触发：重新连接只给当前 Connector ID 通过现有 `/revoke` 接口签发凭据；重新创建使用新注册键，丢失响应后保留该键以便幂等重试。重启插件也不会自动续签失效凭据或重建已删除设备。网络错误不判断为删除，显示「重新检查」；账号凭据失效则提示重新登录。这里的失效是 Connector 长期凭据被撤销或设备被删除，短期 access token 的正常刷新仍由 Connector 自行处理。

「打开 Web」直接进入当前服务器的 Web 应用，不重复发起 OAuth 或设备配对。「退出登录」停止本机连接并切回登录表单；失败时保留账号面板并显示错误。

入口与弹窗布局位于 `src/client/features/onboarding/entry.module.css`，连接内容布局位于同目录的 `section.module.css`，使用 CSS Modules 和官方 `--dsw-alias-*` / `--dsw-font-*` 主题变量。页面跟随 DSH 的明暗主题，不声明全局主题或固定颜色。

弹窗标题复用 Desktop/Web 左上角的 wordmark 样式：Caveat、20px、字重 500。`src/client/assets/caveat-latin.woff2` 复制自 Desktop 的同名字体，构建时内嵌到 Client CSS，无需网络或额外静态资源路由。

外部插件无法直接使用官方仓库未发布的构建 helper，因此 `scripts/client-css.ts` 按其输出契约处理 CSS：监听源文件、生成局部类名，在 Client factory 执行时注入带 `data-plugin` / `data-plugin-css` 的样式，供 DSH HMR 清理和重新加载。实现参考官方 `docs/web-styling.zh.md` 与 `packages/client/tsdown.client.ts`。

`check:build` 在 headless DOM 中加载真实官方组件，验证侧边栏展开/收起、弹窗打开/关闭/焦点恢复、云端与自建服务登录、单地址输入校验、取消、登录后面板切换、头像回退、Connector 状态、打开 Web 和退出登录，以及卸载时弹窗与入口清理；同时检查样式去重及 HMR 清理后的重新注入。Node 中的 CSS loader 仅用于验证，不进入插件产物。

## 配置与本地状态

Host 配置位于 DSH 的插件配置行。常用项如下：

| 配置 | 默认值 / 行为 |
|---|---|
| `apiBaseUrl` | 默认云端后端地址；上次连接时保存的后端地址优先 |
| `stateRoot` | 操作系统用户主目录下 `.agents-anywhere/dsh-bridge-next` |
| `connectorSourceDir` | 包内 `lib/bundled-connector`；覆盖时必须为绝对路径 |
| `uvPath` | 优先使用显式配置或 `UV_PATH`，否则使用 npm 依赖 `@dataiku/uv` 中的平台二进制；依赖不可用时尝试系统 PATH |

设置页将 uv 路径、Python 下载镜像、PyPI 镜像和同步间隔原子写入 `connector-settings.json`；下次启动时恢复，uv 路径覆盖配置行中的 `uvPath`。首次初始化且没有保存过镜像选择时，Host 根据系统首选语言自动设置镜像：包含中文时直接使用阿里云，否则使用官方 PyPI，不弹出询问。macOS 读取系统语言列表，其他平台使用 Intl / POSIX 语言环境，headless 启动同样生效。选择在创建 venv 前持久化，并通过 `UV_DEFAULT_INDEX`、`UV_INDEX_URL` 和 `PIP_INDEX_URL` 传给实际子进程；已保存的镜像（包括手动选择默认 PyPI）保持不变。恢复出厂设置会重新应用系统默认镜像。

Python 下载镜像独立于 PyPI 镜像，提供官方源与 npmmirror。首次初始化缺少该设置时，中文系统默认使用 npmmirror，其他语言使用官方源；已有的手动选择保持不变，恢复出厂设置重新应用语言默认值。选择通过 `UV_PYTHON_INSTALL_MIRROR` 传给 uv，仅影响解释器下载。`@dataiku/uv` 的平台可选依赖由包管理器安装，Host 直接执行其中的原生二进制，不要求 postinstall 脚本运行。

日志页可以切换 Bridge 和 Connector。Connector 日志记录 uv/Python 的 stderr 与进程状态，按时间从上往下显示，首次及每次分页读取 200 行，滚到顶部加载更早记录。日志最多保留 10,000 行，写入前移除终端控制字符并脱敏凭据；stdout 保留为子进程 RPC 通道。日志在 `<stateRoot>/logs/connector-output.json` 中持久化，通过 Host RPC `readConnectorLogs` 分页读取。

受限权限请求通过 DSH 官方 `approval/request` 转成 AA 交互通知，显示工具名与申请原因，提供“允许一次”和“拒绝”。结果通过官方待处理请求返回 DSH，不修改会话权限模式或批准策略。原生客户端作答或请求取消后，远端通知同步关闭；重连恢复同一个待处理请求，重复提交不会重复批准。计划审批 `plan-review` 复用问答卡片，展示完整计划正文和 DSH 提供的选项，也可填写修改意见。批准选项按 DSH 声明的标签匹配，不按位置推断；原生客户端作答、取消和重连沿用同一待处理请求。

Bridge 的独占锁决定端点文件的写入权。获得锁后会重建残留或损坏的 `endpoint.json`，PID 仅用于诊断；关闭时只移除当前实例的端点，再释放锁。


旧配置中的自动启动、心跳、重连及已有会话同步选项在加载时移除，不再影响连接行为。Host 重载自动恢复已授权设备；首次安装等待登录，已安装 Desktop 时仍交由 Desktop 管理。同步间隔及固定的连接参数写入实际 `connector/connector.json`。`logs/connector.jsonl` 记录本机 Connector 生命周期。

数据目录中保存 `settings.json`、`account.json`、按服务和账号隔离的 `bindings/`、`connector/` 与 `connector-venv/`。`settings.json` 只保存 `apiBaseUrl`，不保存 Web 或 OAuth 地址；加载旧配置时自动移除旧的 `webBaseUrl`，保留匹配后端的账号。切换服务器前先检查健康状态，地址无效或无法连接时保留已有账号和连接。凭据文件以原子替换方式写入，POSIX 权限为 `0600`。退出登录删除用户凭据并停止连接，保留设备绑定供下次复用。

同一数据目录只允许一个插件实例管理设备。插件根据规范化后的数据目录选取一个本机回环管理端口，由操作系统保证独占，异常退出后自动释放；该端口不提供 HTTP 或业务接口。端口若被其他程序占用会明确报错，不尝试抢占或启动第二个管理进程。

本机共享记录固定为 `<操作系统用户主目录>/.agents-anywhere/connector-runtime.json`。Python Connector 统一负责启动互斥、运行 PID/启动来源和有序 Connector ID 历史，CLI 也在同一范围内。Desktop 只校验和发布安装信息；插件只读取共享记录，不写 ID、运行记录或安装信息。Desktop 与 Python 的短期文件事务保证并发写入不覆盖对方字段。

插件先保存私有绑定，再通过 RPC 启动 Python Connector。Python 核验已有 PID 确实对应原来的 Connector 进程，接受启动时追加缺失 ID；冲突返回 `-32009 / connector_already_running`。插件展示错误并保留绑定供重试，关闭自己被拒绝的子进程；不会因冲突重复注册。正常退出后由 Python 清除自己的运行记录，异常退出后根据 PID 和进程身份判断残留记录；仅停止后端连接不会释放仍存活的 RPC 进程占用。

默认插件数据统一放在 `~/.agents-anywhere/dsh-bridge-next/`；插件启动的 Connector 使用其 `connector/` 子目录，实例检查点和 KV 继续按 `<connectorId>/<runtimeId>/` 隔离。首次启动在读取账号和启动 Connector 前，从旧 `~/.agentsanywhere/dsh-bridge-next/` 复制全部持久数据，保留原文件；新目录已有文件优先。复制使用新旧目录的管理锁，旧插件仍运行时会报告冲突。复制失败会阻止管理器启动，修复后可重试。成功后的 `.legacy-state-migrated.json` 防止退出登录或重置后重新导入旧数据，请勿删除该记录。自动生成的 `connector-venv` 不复制，由 uv 在新位置重建；Connector 配置中指向旧根目录的状态路径随迁移更新。显式 `stateRoot` 不自动迁移，继续使用配置的位置。

安装检测每次重新读取；可执行文件已不存在时保留历史 ID 并允许 Web 流程，记录损坏或无权限时报告错误。Host 兼容读取旧 `.agentsanywhere/machine.json` 和 `desktop/install.json`，迁移由 Python 在成功写入时完成。

首次 OAuth 后插件获取当前用户的设备列表，与共享 ID 按本地记录顺序匹配；多个匹配取第一个，用现有 `/revoke` 接口换新 Connector token，随后上线并进入原 Web Agent 配置引导。旧插件私有绑定作为最后一个本机候选保留兼容；首次无匹配时注册新设备。已经保存的设备若被删除或凭据失效，先进入上述人工恢复分支，不自动创建或续签。读取、列设备或重连失败都不会降级为新建。普通恢复已有有效 token 时不重复轮换。共享文件不含凭据，详见[本机共享记录契约](../contracts/local-machine/2.0/README.md)。

插件启动时以及每次打开「远程控制」弹窗时均先检测 Desktop，与是否登录无关。弹窗在本次检测完成前显示检查状态；发现有效安装时显示「检测到本机已安装 Agents Anywhere 桌面端，请点击下面按钮在 Agents Anywhere 进行配置。」和「打开 Agents Anywhere 进行配置」按钮，不展示登录表单或已登录面板。未安装时继续原有登录/账号流程，检测失败时提供重试。

点击该按钮由 Host 重新校验安装记录，生成一次性 `flowId`，再通过 `agents-anywhere-desktop://onboarding?source=dsh-plugin&flowId=...` 唤起桌面端；macOS 走系统协议处理器，Windows、Linux 和开发态用记录中的可执行文件与启动参数传参。URL 由 Host 拼装，不接受客户端传入的路径、命令或回跳地址，也不携带任何凭据。桌面端每次收到该入口都进入自己的引导页，与是否已完成过引导无关。

检测到有效 Desktop 安装时，插件跳过 Connector 自动恢复和账号资料刷新，账号、设备与 Connector 全部交由桌面端管理；插件只保留 DSH runtime 端点（`<DSH_HOME>/agents-anywhere/bridge/endpoint.json`）和桥接日志。安装未首启时的补查仍属于后续工作。

## 验证范围

自动化覆盖实际 rc.2 Typert Gateway 对编译后 Host 的调用及卸载、OAuth 本地回调和二次跳转、设备复用、取消、重复操作，以及用独立 stdio 测试进程验证 Connector 启停。跨端测试从插件 OAuth 新建开始，经真实共享文件进入 Desktop 首次配对或已删除设备重连，断言只创建一台设备；另覆盖真实 Python CLI/Desktop/插件进程竞争、异常退出后的重试、Desktop 安装信息与 Python ID 写入并发，以及登记失败后保留私有绑定。Web 测试实际挂载页面组件，覆盖 Agent 添加、手机跳过/扫码、二维码过期、权限检查和登录后的路由恢复。

本轮没有自动启动真实开发服务、登录真实账号或进行 DSH GUI 联调。首次手动联调时按上面的链路操作，确认 Web 完成页可达；Windows 实机进程行为仍需在对应环境验证。

2026-09-08 的原分支基线检查与后续 Python 职责调整分别记录，具体测试数量、提交范围和 CI 状态见 [验证记录](./VERIFICATION.md)。插件事件与问答测试使用原有后端 ASGI app 和临时 SQLite；本地开发及生产 Server 仍使用 PostgreSQL。持续检查由 [DSH Bridge Next 工作流](../.github/workflows/dsh-bridge-next.yml)执行；这些结果不代替真实模型、手机、Windows 或长期运行验收。

## 目录职责

```text
src/contracts/          插件前后端共享接口，不包含 DSH Agent 协议
src/host/config.ts      连接地址、数据目录、运行路径
src/host/desktop/       只读安装检测与本机 ID 历史读取
src/host/onboarding/    OAuth 回调、流程状态和 Web 交接
src/host/account/       用户授权、设备绑定及凭据恢复
src/host/connector/     内部 Python Connector 的进程管理
src/host/rpc/           公开的连接管理接口
src/host/storage/       私有文件存储与实例锁
src/host/dsh-runtime/   DSH 原生读写、可见性、Timeline 投影与事件端点
src/client/            DSH 侧边栏入口、连接弹窗和 Host 调用
scripts/               构建、源码复制与产物检查
tests/                 单元及集成测试
```

Host 输出 `lib/index.js`，Client 输出 DSH 模块加载格式的 `lib/client.js`，不能当独立网页打开。目标 Harness 为 `0.1.7-rc.2`；Cordis、Typert 与 Schemastery 使用 Host 提供的 peer 依赖，以免破坏服务类型身份。依赖、构建产物和锁文件遵循仓库现有忽略规则。
