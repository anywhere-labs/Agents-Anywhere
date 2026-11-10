# 更新日志

按版本记录用户能感知到的变化，最新版本在最前，每项一句话。接口变化、各端最低配套版本、数据库迁移和安装包记录见各版本的[发布说明](docs/releases/)。

## 未发布

### 升级须知

- Connector 现在遵守系统代理的例外列表，并在只设置了 `NO_PROXY` 时继续使用系统代理：同一台设备连接服务器的路径可能因此改变（走代理改为直连，或反过来），不符合预期时可在「Connector 网络」里指定。（[#549](https://github.com/anywhere-labs/Agents-Anywhere/pull/549)）
- Codex、Claude Code 统一目标模式需要 Server 执行 `v2_47` 数据库迁移，并配套更新 Connector 和客户端。（[#539](https://github.com/anywhere-labs/Agents-Anywhere/pull/539)）
- Server 执行 `v2_48` 数据库迁移：删除时间线表上不再使用的大索引，并为设备列表查询补上索引；已经手工调整过这两个索引的数据库执行后不变，请在停止 Server 和 worker 的维护窗口里运行，细节见[升级指南](docs/upgrading.md)。（[#553](https://github.com/anywhere-labs/Agents-Anywhere/pull/553)）
- Server 读数据库时不再给每次查询额外开启并回滚事务，从连接池取连接时的检查也只需一次往返，数据库往返和回滚数明显减少；升级后数据库统计里的提交数会上升、回滚数接近零，按提交与回滚比例设置的监控需要相应调整。（[#559](https://github.com/anywhere-labs/Agents-Anywhere/pull/559)）
- Server 执行 `v2_49` 数据库迁移：新增会话扫描记录，不重写已有会话；`sourceAvailabilityUpdatedAt` 改为来源状态最后一次写入的时间，详见[升级指南](docs/upgrading.md)。（[#557](https://github.com/anywhere-labs/Agents-Anywhere/pull/557)）
- 配置管理需要 Server 执行 `v2_50`、`v2_51` 和 `v2_52` 数据库迁移，升级前须停止旧 Server 进程，并配套更新 Server、Connector 和各客户端，旧 Connector 会保留原配置并提示升级；保存手动填写的 Key、链接 Tokens Anywhere 之前，部署者要把 `AGENT_SERVER_SECRET` 设为至少 32 个字符。（[#515](https://github.com/anywhere-labs/Agents-Anywhere/pull/515)）
- 链接 Tokens Anywhere 需要设置 `AGENT_SERVER_TOKENS_URL`（或由管理员在实例设置中填写 Tokens Anywhere 地址），并用 `AGENT_SERVER_PUBLIC_ORIGIN` 指定实例对外的地址；Tokens Anywhere 一侧要设置 `TOKENS_SECRETS_KEY`，否则 AA 拿不回托管 Key。（[#515](https://github.com/anywhere-labs/Agents-Anywhere/pull/515)）
- Runtime 配置中的模型网关 Key 改为只写，接口和实时快照不再返回已保存的 Key；旧版客户端编辑这类配置时需要重新填写 Key。（[#515](https://github.com/anywhere-labs/Agents-Anywhere/pull/515)）
- Server 执行 `v2_53` 数据库迁移：会按已经记录的使用事件回填按小时的汇总，事件多的实例迁移耗时会更长。（[#473](https://github.com/anywhere-labs/Agents-Anywhere/pull/473)）
- Server 执行 `v2_54` 数据库迁移：为每个会话记下最新一条记录的摘要并从已有数据回填，耗时随会话数增长，请在停止 Server 和 worker 的维护窗口里运行；客户端无须升级，细节见[升级指南](docs/upgrading.md)。（[#595](https://github.com/anywhere-labs/Agents-Anywhere/pull/595)）
- 设备设置需要 Server 执行 `v2_55` 数据库迁移（只给设备表加一列，不改写已有数据）；关机行为要等 Connector 和 Desktop 也升级后才按设置生效，旧版 Desktop 关机时仍会弹窗确认。（[#596](https://github.com/anywhere-labs/Agents-Anywhere/pull/596)）
- Desktop 不再信任私钥已泄露的 eMudhra 中间证书，连接 Server、登录和下载更新时不会被用这些证书伪造的服务器冒充；Desktop 从此版本起需要 macOS 13 及以上，macOS 12 用户请停留在 2.1.x。（[#605](https://github.com/anywhere-labs/Agents-Anywhere/pull/605)）

### 会话创建与消息交付

- 现在可以把本机安装的 Hermes Agent 作为 Agent 使用：支持对话、工具审批、文本和图片附件、运行中追加指令、中断与恢复；暂不支持浏览 Hermes 的旧会话。（[#591](https://github.com/anywhere-labs/Agents-Anywhere/pull/591)）
- Hermes、Pi 等 ACP Agent 未安装、ACP 入口不可用、需要登录、无法创建或恢复会话时，Web、Desktop、Android 和 iOS 按界面语言显示统一说明，英文界面不再出现中文。（[#599](https://github.com/anywhere-labs/Agents-Anywhere/pull/599)）
- 会话很多或多个会话同时运行时，会话列表的实时刷新不再拖慢 Server 数据库：读取会话列表不再逐个去查每个会话的最新记录，同一用户的连续变化最多每 2 秒合并推送一次，部署者可用 `AGENT_SERVER_DASHBOARD_MIN_INTERVAL_SECONDS` 调整。（[#552](https://github.com/anywhere-labs/Agents-Anywhere/pull/552)、[#595](https://github.com/anywhere-labs/Agents-Anywhere/pull/595)）
- 长时间运行的 Server 内存缓慢上涨时，部署者可以设置 `AGENT_SERVER_MALLOC_TRIM_INTERVAL_SECONDS`（例如 `300`），让每个工作进程定期把已释放的内存还给系统；默认不开启。（[#586](https://github.com/anywhere-labs/Agents-Anywhere/pull/586)）
- Connector 断线重连或集中补传积压记录时，会话写入不再卡住数小时，也不再长期占着数据库连接、阻塞清理，进而拖垮整个服务；许多会话同时写入时，也不再全部报数据库连接超时。（[#556](https://github.com/anywhere-labs/Agents-Anywhere/pull/556)）
- 使用 Redis 的部署里，Connector 断线重连时个别会话不再约 5 分钟写不进新消息、同步反复失败。（[#592](https://github.com/anywhere-labs/Agents-Anywhere/pull/592)）

### Codex 与 Claude

- Codex 的定时会话扫描只写入真正变化的会话，会话数量较多的部署数据库写入明显下降，并减少这些写入拖慢其他请求的情况。（[#557](https://github.com/anywhere-labs/Agents-Anywhere/pull/557)）
- Connector 的 Codex 会话清单没有变化时不再重复上报，只每隔约 10 分钟核对一次；重连和启动时的扫描也会错开，故障恢复时不再集中冲击 Server。（[#555](https://github.com/anywhere-labs/Agents-Anywhere/pull/555)）
- Codex 回合失败后只显示错误卡片，不再锁住输入框：可以直接继续发送或重试，下一轮开始时卡片自动消失。（[#581](https://github.com/anywhere-labs/Agents-Anywhere/pull/581)）
- Web、Desktop、Android 和 iOS 可用 `/goal` 设置目标，在输入区上方编辑、暂停、恢复或清除；停止时阻止自动续跑，完成结果留在会话历史中，长目标栏与输入框保持同宽并自动截断正文。（[#539](https://github.com/anywhere-labs/Agents-Anywhere/pull/539)）
- 在 Codex App 或 IDE 窗口里处理审批后，Agents Anywhere 里的会话不再一直显示「等待批准」。（[#532](https://github.com/anywhere-labs/Agents-Anywhere/pull/532)）
- Claude 工具结果里的图片（例如读取截图）不再以原文同步到云端，会话中改为显示 `[Image omitted: image/png, 1.2 MB]` 这样的摘要，不再显示一大段乱码；含大量截图的历史会话不再因请求过大（413）而每轮同步失败。（[#548](https://github.com/anywhere-labs/Agents-Anywhere/pull/548)）
- Codex 和 Claude Code 的历史会话超过服务器单次请求上限时改为分批上传，不再因 413 一直同步失败；服务器仍然拒收的会话会暂停重试（从约 10 分钟起逐次加倍，最长约 6 小时），不再每轮重新读取和上传、拖慢同一设备上其他会话的同步，暂停期间会话标题和状态照常更新。（[#589](https://github.com/anywhere-labs/Agents-Anywhere/pull/589)）
- 本机模式的 Pi 不能使用模型网关，切换到 AA 网关时会另建一个受管 Pi 实例，本机 Pi 及其历史不受影响。接入模型网关后恢复 Codex 已有会话时，继续使用会话原来的模型。（[#515](https://github.com/anywhere-labs/Agents-Anywhere/pull/515)）
- 接入模型网关后，Codex 中原本使用其他服务商（例如 kimi）的会话继续用原来的服务商，不再报「This chat uses …, but your current provider is …」；本机 Codex 是 0.166 或 0.167 时，配置了模型网关的 Codex 会改用 Agents Anywhere 自带的 Codex，避免重启后网关会话无法继续。（[#607](https://github.com/anywhere-labs/Agents-Anywhere/pull/607)）

### 本机连接

- 电脑关机、重启或注销时，Desktop 不再弹出「退出 Agents Anywhere？」阻止关机，而是直接停止本机连接并退出；需要确认的用户可以打开「关机时询问是否退出」。在 Desktop 里手动退出时仍会确认。（[#596](https://github.com/anywhere-labs/Agents-Anywhere/pull/596)）
- 打开「登录时打开」和「登录时静默启动」后，开机登录时 Desktop 不再弹出主窗口，即使本机连接要过很久才就绪；只有本机连接被其他程序占用或启动出错时才显示窗口。更新后由安装器重新启动时，隐藏的窗口也不再被拉到前台。（[#403](https://github.com/anywhere-labs/Agents-Anywhere/pull/403)）
- Desktop 和 DSH 插件的设置里新增「Connector 网络」，可选跟随系统、直连或自定义代理；Connector 的接口请求、实时连接和终端都走同一条路，日志里记录实际走的路径。（[#549](https://github.com/anywhere-labs/Agents-Anywhere/pull/549)）
- 在系统代理里把服务器地址加入例外现在对 Connector 生效；只设置 `NO_PROXY` 不再让 Connector 绕过系统代理。（[#549](https://github.com/anywhere-labs/Agents-Anywhere/pull/549)）
- 系统代理开关开着但本机代理软件已退出时，Connector 改为直连，不再一直连不上服务器。（[#549](https://github.com/anywhere-labs/Agents-Anywhere/pull/549)）
- `NO_PROXY` 里出现 `[::1]` 或写法有误的条目时，Connector 不再启动失败。（[#549](https://github.com/anywhere-labs/Agents-Anywhere/pull/549)）
- Windows 和 macOS 上 Connector 改用系统证书库校验服务器证书，不再因为 Python 自带或读到的证书过期而报「certificate has expired」；证书被拒时日志会说明可能是本机证书库的问题。（[#549](https://github.com/anywhere-labs/Agents-Anywhere/pull/549)）
- Intel Mac 首次准备 Connector 环境时不再因为缺少预编译包而长时间卡在编译 `cryptography`。（[#549](https://github.com/anywhere-labs/Agents-Anywhere/pull/549)）
- 本机 Connector 持续无响应时自动重建后台并恢复连接，短暂故障或主动停止时不会自动重启。（[#522](https://github.com/anywhere-labs/Agents-Anywhere/pull/522)）
- Codex 版本检测不再阻塞发现和配置验证期间的心跳与本机控制，并避免 Windows 管道读取线程卡住导致检测超时失效。（[#522](https://github.com/anywhere-labs/Agents-Anywhere/pull/522)）

### DSH 同步

- 经本地代理上传大批量会话时，不再因为等待服务器响应超过 60 秒而反复失败；上行很慢（低于约 64 KB/s）时每次重试会等得更久，不再在同一个大会话上反复重传、卡住后面所有会话的同步；上传失败的日志会写明错误类型、数据大小和耗时。（[#551](https://github.com/anywhere-labs/Agents-Anywhere/pull/551)、[#593](https://github.com/anywhere-labs/Agents-Anywhere/pull/593)）
- 连不上服务器时，DSH 插件会重发当前批次并在恢复后继续，不再断开同步后重新扫描全部会话。（[#551](https://github.com/anywhere-labs/Agents-Anywhere/pull/551)）
- Connector 启动后短暂忙碌时，DSH 插件不再判定启动失败并关掉它（`Call deadline exceeded`），设备可以正常上线。（[#558](https://github.com/anywhere-labs/Agents-Anywhere/pull/558)）
- 停用后重新启用 DSH 插件不再报 `ID BridgePayload already exists in the registry`，不需要重启 DSH。（[#558](https://github.com/anywhere-labs/Agents-Anywhere/pull/558)）
- DSH 插件登录和绑定设备时遇到瞬时网络错误会自动重试；可能已送达的写操作不会重复发送。（[#558](https://github.com/anywhere-labs/Agents-Anywhere/pull/558)）
- 内置 uv 缺少执行权限时，DSH 插件会自动修复，不再提示找不到 uv。（[#558](https://github.com/anywhere-labs/Agents-Anywhere/pull/558)）
- 超过 45 MiB（或因代理限制被分页）的 DSH 会话完整同步时，不再把第一页之后的历史整段删掉再写回，只改写有变化的条目；上传中途失败时，服务器上也不再只剩前半段历史。需要 Server 和 Connector 都升级到本版。（[#590](https://github.com/anywhere-labs/Agents-Anywhere/pull/590)）
- Connector 忙碌或同步流被重建时，DSH 不再因 Agents Anywhere 插件的连接调用被取消或超时而整个退出（`Call was cancelled`、`Call deadline exceeded`）。（[#547](https://github.com/anywhere-labs/Agents-Anywhere/pull/547)）
- 首次导入或重新同步 DSH 会话后，会话列表按最后使用时间排序，和 DSH 桌面端侧边栏一致，不再按同步先后打乱。（[#404](https://github.com/anywhere-labs/Agents-Anywhere/pull/404)）

### 本机连接、所有权与日志

- 管理员删除用户时，会先删除该用户的设备及其项目和会话，不再留下无主设备；用户项目里还有会话时返回冲突提示，不再报服务器错误。（[#550](https://github.com/anywhere-labs/Agents-Anywhere/pull/550)）
- 在 Web 里停止或删除运行时实例后，Connector 不再每 30 秒为它打一条日志，重连服务器时也不再为每个这样的实例输出带 traceback 的 ERROR；因其他原因不可用的实例改为一条说明原因的 INFO。（[#398](https://github.com/anywhere-labs/Agents-Anywhere/pull/398)）

### Web 与 Desktop 界面

- 新建 ACP 会话时，模型加载状态显示在 Agent 旁边，不再出现在输入框上方。（[#606](https://github.com/anywhere-labs/Agents-Anywhere/pull/606)）
- Desktop 的「关机时询问是否退出」开关统一放在「设置 → 启动与通知」，不再出现在 Desktop 设备详情页；其他客户端修改的设置仍会同步，设备离线时修改，会在它下次上线时生效。（[#596](https://github.com/anywhere-labs/Agents-Anywhere/pull/596)、[#598](https://github.com/anywhere-labs/Agents-Anywhere/pull/598)）
- Desktop 切回最近查看的会话时立即显示消息并恢复阅读位置，随后补齐新消息和运行信息，修复重连时漏补消息，以及切换会话或刷新登录凭据时消息、审批与模型和权限选择的状态错乱。（[#609](https://github.com/anywhere-labs/Agents-Anywhere/pull/609)）
- Agent 连接断开后，没有原生历史的会话会显示「恢复会话」，不用新建会话就能接着用，未确认的消息不会自动重发。（[#591](https://github.com/anywhere-labs/Agents-Anywhere/pull/591)）
- Tokens Anywhere 可以用 Agents Anywhere 账号登录：Web 会先显示「登录 Tokens Anywhere」确认页，确认后才向 Tokens Anywhere 提供名称、邮箱和头像，选「取消」则不提供任何信息。部署者设置 `AGENT_SERVER_TOKENS_ANYWHERE_CLIENT_SECRET` 和 `AGENT_SERVER_TOKENS_ANYWHERE_REDIRECT_URI` 后开启。（[#571](https://github.com/anywhere-labs/Agents-Anywhere/pull/571)）
- 侧边栏新增 Tokens Anywhere 入口，仅显示官网手写体字标：已链接账户时直接在页面里打开 Tokens Anywhere 控制台，不用再登录；未链接时点「授权 Tokens Anywhere」一次即可完成链接，Desktop 页面不再重复显示侧栏折叠按钮。不需要时可以在页面上或「设置 → 外观」里隐藏。实例设置了 Tokens Anywhere 地址后才会出现这个入口，自部署实例不需要重新构建。（[#571](https://github.com/anywhere-labs/Agents-Anywhere/pull/571)、[#515](https://github.com/anywhere-labs/Agents-Anywhere/pull/515)、[#598](https://github.com/anywhere-labs/Agents-Anywhere/pull/598)）
- 「设置 → 模型网关」可以选择默认网关，也可以手动添加模型服务；列表不单列「设备自带配置」，登录授权 Tokens Anywhere 后自动应用其网关，各端不再显示该账户的「应用」按钮，未登录时隐藏 Runtime 区域，退出后会自动切回设备自带配置；修复旧 Pi 受管实例重复切换及更新网关后仍以旧配置启动、核验失败的问题。保存时自动识别协议和模型，不调用模型。地址在内网、连不上或识别不出协议时可以改为手动选择，部署者也可以设置 `AGENT_SERVER_ALLOW_PRIVATE_MODEL_GATEWAYS=1` 允许识别内网地址。离线期间多次切换会在上线后追到最终网关。（[#515](https://github.com/anywhere-labs/Agents-Anywhere/pull/515)、[#598](https://github.com/anywhere-labs/Agents-Anywhere/pull/598)）
- 管理员可以在「管理 → 常规」里填写或清空 Tokens Anywhere 地址；已有账户链接时地址会锁定，全部断开后才能修改。Anywhere 账户用「退出」结束链接：使用该网关的 Runtime 先切回默认网关，全部完成后再撤销授权。（[#515](https://github.com/anywhere-labs/Agents-Anywhere/pull/515)）
- Beta 和实验性的 Runtime 会在状态旁显示「Beta」「实验性」标记。模型网关的 Key 保存后只保留开头和结尾几位；不改 Key 时可以留空，更换地址时需要重新填写。（[#515](https://github.com/anywhere-labs/Agents-Anywhere/pull/515)）
- 新建会话输入框下方不再显示模型加载时返回的原始错误提示，保留模型状态和重试入口。（[#515](https://github.com/anywhere-labs/Agents-Anywhere/pull/515)）
- 管理看板打开更快：使用报表改为读取按小时的汇总，耗时不再随使用事件增多而线性增长；顶部的实时状态也不再随设备数和事件数变慢。轮次耗时和审批等待分位数改为统计范围内的全部样本，不再只取最新的 20 万条。（[#472](https://github.com/anywhere-labs/Agents-Anywhere/pull/472)、[#473](https://github.com/anywhere-labs/Agents-Anywhere/pull/473)）

### Android

- Desktop 设备的详情页新增「设备设置」，可以远程打开或关闭「关机时询问是否退出」。（[#596](https://github.com/anywhere-labs/Agents-Anywhere/pull/596)）
- Agent 连接断开后，没有原生历史的会话可以点「恢复会话」接着用。（[#591](https://github.com/anywhere-labs/Agents-Anywhere/pull/591)）
- Android 的「模型网关」与 Web、Desktop 相同：首页列出网关和「已应用」（不单列「设备自带配置」，退出 Tokens Anywhere 后自动切回），点进网关后再应用、查看配置和 Runtime；Tokens Anywhere 按「账户／模型与连接／Runtime」分页，可以退出账户。（[#515](https://github.com/anywhere-labs/Agents-Anywhere/pull/515)、[#598](https://github.com/anywhere-labs/Agents-Anywhere/pull/598)）
- 所选 Agent 换了模型网关后，Android 新建会话页会重新准备并刷新模型列表，不再停留在旧网关的模型上。（[#587](https://github.com/anywhere-labs/Agents-Anywhere/pull/587)）
- Android 内置浏览器登录依赖视口高度的 OIDC 身份提供方时不再白屏，保留正常页头、页脚和登录卡片的布局，登录 URL 和第三方控制台输出不写入应用日志。（[#575](https://github.com/anywhere-labs/Agents-Anywhere/pull/575)）

### iOS

- Desktop 设备的详情页新增「设备设置」，可以远程打开或关闭「关机时询问是否退出」。（[#596](https://github.com/anywhere-labs/Agents-Anywhere/pull/596)）
- Agent 连接断开后，没有原生历史的会话可以点「恢复会话」接着用。（[#591](https://github.com/anywhere-labs/Agents-Anywhere/pull/591)）
- iOS 的「模型网关」与 Web、Desktop 相同：首页列出网关和「已应用」（不单列「设备自带配置」，退出 Tokens Anywhere 后自动切回），点进网关后再应用、查看配置和 Runtime；Tokens Anywhere 按「账户／模型与连接／Runtime」分页，可以退出账户。（[#515](https://github.com/anywhere-labs/Agents-Anywhere/pull/515)、[#598](https://github.com/anywhere-labs/Agents-Anywhere/pull/598)）
- 所选 Agent 换了模型网关后，iOS 新建会话页会重新准备并刷新模型列表，不再停留在旧网关的模型上。（[#588](https://github.com/anywhere-labs/Agents-Anywhere/pull/588)）

### 文档

- 项目许可证由 MIT 改为 Apache License 2.0，仓库提供许可证全文和 `NOTICE`；此前已发布的版本仍可按原 MIT 声明使用，DSH 插件的 npm 包也会附带这两个文件。（[#594](https://github.com/anywhere-labs/Agents-Anywhere/pull/594)）

## 2.2.0（日期待定）

[发布说明](docs/releases/2.2.0.md) · [与 2.1.0 的差异](https://github.com/anywhere-labs/Agents-Anywhere/compare/v2.1.0...main)

### 升级须知

- 这是接口更新：Server、Web、Desktop、Android、iOS、Connector 和 DSH 插件的版本号都是 2.2.0。2.1.0 客户端仍可登录并使用既有会话；统一 Plan、Pi，以及需要新 Connector 或 DSH 插件的行为要一起升级到 2.2.0。（[#546](https://github.com/anywhere-labs/Agents-Anywhere/pull/546)）
- Pi 优先复用本机兼容安装的模型、认证和配置；已有受管模型网关配置保持隔离，用户也可明确选择受管环境。（[#484](https://github.com/anywhere-labs/Agents-Anywhere/pull/484)）
- Pi 接入需要 Server 执行 `v2_45` 数据库迁移，并配套更新 Connector 和使用此功能的客户端。（[#484](https://github.com/anywhere-labs/Agents-Anywhere/pull/484)）
- 统一 Plan 需要 Server 执行 `v2_46` 数据库迁移，并配套更新 Connector、客户端和 DSH Bridge；DSH 还需组合原生 Plan 插件。（[#490](https://github.com/anywhere-labs/Agents-Anywhere/pull/490)）
- 用 Agents Anywhere 账号登录 Tokens Anywhere 已进入主线（[#571](https://github.com/anywhere-labs/Agents-Anywhere/pull/571) 取代了未合并的 [#470](https://github.com/anywhere-labs/Agents-Anywhere/pull/470)）。一键链接里的授权、申请 Key、模型渠道和断开也已进入主线（[#515](https://github.com/anywhere-labs/Agents-Anywhere/pull/515)、[#571](https://github.com/anywhere-labs/Agents-Anywhere/pull/571)）；[#510](https://github.com/anywhere-labs/Agents-Anywhere/issues/510) 仍打开：嵌入控制台还没有，Tokens Anywhere 地址也还没有内置的云端默认值。

### 统一 Plan

- 补齐 Web、Desktop、Android 和 iOS 计划卡片、审阅、阅读器及规划入口提示的中英文翻译，随客户端语言切换。

- 修复 Codex 规划模式调用旧写入路由接口导致首轮任务创建失败的问题，并避免异常日志展开运行时对象造成 Connector 卡顿和断连。
- 在 Codex、Claude Code 和 DSH 会话中可统一使用 `/plan`、`/plan <任务>` 与 `/plan off`；新会话首条任务即可进入原生规划，裸 `/plan` 只设置创建意图，不消耗空模型回合。（[#490](https://github.com/anywhere-labs/Agents-Anywhere/pull/490)）
- Web、Desktop、Android 和 iOS 新增流式计划卡片，在输入区直接「同意并执行／修改计划／暂不执行」，不再弹出审批窗口；计划卡片与确认面板沿用审批卡样式，长计划可展开全文，「打开计划」后可复制和导出完整计划，Web 和 Desktop 支持与聊天并排阅读。（[#490](https://github.com/anywhere-labs/Agents-Anywhere/pull/490)）
- 计划按不可变版本保存，设备离线仍可查阅；旧版本批准、重复执行和结果未知后的自动重发会被阻止，批准计划继续使用用户当前权限设置。（[#490](https://github.com/anywhere-labs/Agents-Anywhere/pull/490)）
- 提交修改意见后的新计划作为同一份计划的下一版本（版本 2、3…），旧版本在时间线中收为一行，可随时打开；计划卡片按产生时间排在时间线中，批准后紧贴在实施内容上方，Codex 不再额外显示一条重复的计划系统消息。（[#490](https://github.com/anywhere-labs/Agents-Anywhere/pull/490)）
- 斜杠菜单在支持规划的会话中提供 `/plan`，并显示中英文说明；Codex 内置指令的说明随客户端语言显示。（[#490](https://github.com/anywhere-labs/Agents-Anywhere/pull/490)）
- Runtime、工作区准备、会话创建和原生历史的错误改为按稳定错误码显示中英文文案，英文界面不再出现 Connector 或 Server 固定输出的中文；Android 新建会话的输入校验提示也随语言显示。错误码文案集中在 `contracts/runtime-errors/1.0/messages.json`，由脚本生成到四端。（[#490](https://github.com/anywhere-labs/Agents-Anywhere/pull/490)）
- 修复英文界面打开斜杠菜单时 `/plan` 说明文案解析失败报错；日期按应用语言而不是浏览器语言显示；Codex 与 Claude 的审批卡标题在中英文界面下各自显示对应语言。（[#490](https://github.com/anywhere-labs/Agents-Anywhere/pull/490)）
- 本机缺少 Pi 等启动前即可确定的工作区准备失败，改为明确的失败状态并显示对应原因，不再标记为「结果未知」后反复查询。（[#490](https://github.com/anywhere-labs/Agents-Anywhere/pull/490)）
- 计划执行开始后不再在时间线末尾长期保留「计划执行已开始」，执行状态改由计划卡片显示；以冒号结尾的引导句作为计划标题时不再保留冒号。（[#490](https://github.com/anywhere-labs/Agents-Anywhere/pull/490)）

### 会话创建与消息交付

- Desktop 准备本机 Connector 时，依赖安装与启动分开进行：安装过程单独显示进度，时间较长不再被误报为连接超时，取消或启动超时会停掉对应进程；同时准备 Pi 适配器及依赖，已有缓存有效时直接启动，不再每次弹出依赖准备窗口，首次创建 Pi 会话不再临时下载适配器。（[#460](https://github.com/anywhere-labs/Agents-Anywhere/pull/460)、[#518](https://github.com/anywhere-labs/Agents-Anywhere/pull/518)、[#527](https://github.com/anywhere-labs/Agents-Anywhere/pull/527)）

- Connector 重连恢复期间，Web 与 Desktop 会等待 Agent 就绪后再允许创建会话，显示 Agent 启动、模型加载和空目录状态，加载失败时可查看原因并重试，且仍可切换设备与 Agent；运行时启动不再等待所有历史会话的能力刷新。（[#518](https://github.com/anywhere-labs/Agents-Anywhere/pull/518)、[#523](https://github.com/anywhere-labs/Agents-Anywhere/pull/523)）

- 附件上传与下载改为流式处理，发送或打开大文件时不再整包占用服务端内存；图片附件同时提供缩略图地址，浏览大图更省流量。（[#492](https://github.com/anywhere-labs/Agents-Anywhere/pull/492)）

- 修复 Codex 查看图片的记录显示为 `unknown` 的问题，现可点击图片路径打开预览。（[#491](https://github.com/anywhere-labs/Agents-Anywhere/pull/491)）

- 修复接入 Codex 已有会话后，补入的旧消息出现在最新消息下方、历史消息交错或重排后顺序没有更新的问题；升级后同步会自动校准已有记录。（[#480](https://github.com/anywhere-labs/Agents-Anywhere/pull/480)）

- Pi 接入：
  - Web、Desktop、Android 和 iOS 会话列表统一显示 Pi 官方单色图标，并随应用主题着色。（[#514](https://github.com/anywhere-labs/Agents-Anywhere/pull/514)）
  - 沿用 Codex 的 Agent、模型、权限和发送入口，各端自动加载工作区模型；
  - 支持首条及后续附件、工具审批、运行中追加指示和会话恢复；
  - 可以浏览本机原生历史，退出对应 CLI 会话后用「继续任务」恢复原会话；
  - 检测到外部历史变化时停止继续写入；
  - 附件卡片在历史同步和恢复后仍然保留，运行中追加的指示和扩展自动发送的消息各自单独显示，不会和你的消息混在一起；
  - 所选模型不支持图片时，各端在发送或新建前就会提示，会话仍可继续使用，在执行前被拒绝的消息显示为失败；
  - 本机 Pi 支持 1.2.0 及之后的 1.x 版本，不再只认 1.4.0；升级本机 Pi 后已有的 Pi 实例可以继续使用，遇到不兼容的版本会说明原因；
  - 本机 Pi 尚未登录或没有可用模型时，新建会话会提示先运行 `pi` 完成登录或模型配置，不再只显示「Agent 初始化未完成」。

  [#484](https://github.com/anywhere-labs/Agents-Anywhere/pull/484)、[#509](https://github.com/anywhere-labs/Agents-Anywhere/pull/509)

- Desktop 刷新本机设备列表时不再反复返回 Connector 启动页。（[#484](https://github.com/anywhere-labs/Agents-Anywhere/pull/484)）

- Connector 上报的时间线条目序号超出范围时只拒绝这条上报，同批其他消息照常保存，不再让整个会话之后的消息都存不进数据库；升级前已经积压的条目会按原顺序排到时间线末尾保存，持续写入失败的会话也不再每秒重试刷屏日志。（[#464](https://github.com/anywhere-labs/Agents-Anywhere/pull/464)）

### DSH 同步

- 首次同步大量或很长的会话时，即使有 Agent 正在持续输出，也不再因事件积压反复从头同步、一直停在「正在同步 DSH 会话…」；积压过多时只重新校准占用最多的那个会话。（[#511](https://github.com/anywhere-labs/Agents-Anywhere/pull/511)）
- 上传同步数据（包括会话的完整历史）时连接偶尔中断或 Server 短暂返回 5xx，会先自动重试，不再立即中断并重新同步全部会话。（[#511](https://github.com/anywhere-labs/Agents-Anywhere/pull/511)、[#525](https://github.com/anywhere-labs/Agents-Anywhere/pull/525)）
- 较长的 DSH 会话（历史在 45 MiB 以内）重新同步时一次提交完，Server 只改写有变化的消息，不再先删掉后半段历史再重新写入；同步中途出错，其他设备上也不会只剩前半段历史。（[#525](https://github.com/anywhere-labs/Agents-Anywhere/pull/525)）
- 代理拒收过大的同步请求（413）时，Connector 会自动缩小分页重新上传，很长的 DSH 会话不再因此停止同步。（[#525](https://github.com/anywhere-labs/Agents-Anywhere/pull/525)）
- DSH 上传很长的会话历史时，同一设备上 Codex、Claude 等其他会话的实时消息不再排队等它传完。（[#525](https://github.com/anywhere-labs/Agents-Anywhere/pull/525)）
- DSH 会话流式输出时，连续的回复更新改为约每 0.25 秒提交一次，Server 的请求量和写入量明显下降。（[#525](https://github.com/anywhere-labs/Agents-Anywhere/pull/525)）
- 被 Server 拒收的 DSH 会话改为按退避时间重试，不再每次有新变化就整段重新上传；DSH 同步重连或重建后也会记得这些会话，不会马上再传一遍。（[#525](https://github.com/anywhere-labs/Agents-Anywhere/pull/525)）
- DSH 0.2.2 的实验性 Computer Use 请求控制应用时，授权提问重新出现在 AA 里并以中文显示，可以在手机上选择允许或拒绝；这类提问只能从给出的选项中选择。（[#538](https://github.com/anywhere-labs/Agents-Anywhere/pull/538)、[#540](https://github.com/anywhere-labs/Agents-Anywhere/pull/540)）
- 在 DSH 0.2.2 上安装 DSH 插件时，不再提示 Cordis、Schemastery 版本不满足。（[#538](https://github.com/anywhere-labs/Agents-Anywhere/pull/538)）

### Web 与 Desktop 界面

- Web 对话里已经选中文字时，右键打开浏览器自带菜单；没有选中文字时仍可复制文本、item ID 和 item JSON。（[#416](https://github.com/anywhere-labs/Agents-Anywhere/pull/416)）

### Android

- Android 会话可以显示 Markdown 图片和 HTML 图片，支持点击放大、双指缩放与加载失败后重试。（[#542](https://github.com/anywhere-labs/Agents-Anywhere/pull/542)）

- 修复开启接管后输入框有时仍提示「当前运行时状态下不可发送消息」、需要重新进入会话才能发送的问题。（[#519](https://github.com/anywhere-labs/Agents-Anywhere/pull/519)）

- Android 可以直接添加和管理 Agent，不必再去桌面端操作：
  - 设备页可以快速添加、配置、重命名、启停和删除 Agent，配置项按 Agent 类型自动生成，包括路径、模型 Gateway、环境变量和自定义模型等；
  - 连接设备后直接打开「为这台设备选择 Agent」，可一键配置；离开配对页后设备才上线时，也会提示添加 Agent；
  - 进入主界面仍没有 Agent 时会弹窗提醒，「添加 Agent」直接打开这个面板；已添加但离线的 Agent 不会误触发提醒；
  - 删除 Agent 配置前会说明关联的会话、消息记录和附件将被永久删除。

  [#513](https://github.com/anywhere-labs/Agents-Anywhere/pull/513)、[#521](https://github.com/anywhere-labs/Agents-Anywhere/pull/521)

- 终端文件页可以预览工作区图片；对话里工具和命令输出提到的工作区截图，点一下即可加载缩略图，再点可打开大图。（[#493](https://github.com/anywhere-labs/Agents-Anywhere/pull/493)）

## 2.1.0（2026-10-27）

[发布说明](docs/releases/2.1.0.md) · [GitHub Release](https://github.com/anywhere-labs/Agents-Anywhere/releases/tag/v2.1.0) · [与 2.0.3 的差异](https://github.com/anywhere-labs/Agents-Anywhere/compare/v2.0.3...v2.1.0)

### 升级须知

- **本机三端一起升级**：Desktop、Connector 和 DSH 插件之间的本机通道改用 MeshCall，2.0.x 与 2.1.0 互不兼容。只升级一端时，2.0.x Connector 会一直停在「等待 DSH」。（[#353](https://github.com/anywhere-labs/Agents-Anywhere/pull/353)）
- **数据库迁移**：Server 需要执行迁移 `v2_42`–`v2_44`。`/api/v2/admin/dashboard/*` 已删除，2.0.x 的 Web / Desktop 打开看板会得到 404。（[#296](https://github.com/anywhere-labs/Agents-Anywhere/pull/296)、[#299](https://github.com/anywhere-labs/Agents-Anywhere/pull/299)、[#290](https://github.com/anywhere-labs/Agents-Anywhere/pull/290)）
- **移除 SQLite 和 v1 导入工具**：Server 不再支持 SQLite 后端，也去掉了 v1 导入工具。仍在 v1 的部署要先用 2.0.x 完成导入；部署配置里的 `AGENT_SERVER_DB_BACKEND` 可以删除。（[#299](https://github.com/anywhere-labs/Agents-Anywhere/pull/299)）
- **单独安装的 Connector CLI 和 DSH 插件**：PyPI 的 `anywhere-cli` 和 npm 的 `@agents-anywhere/dsh-bridge-next` 同步发布 2.1.0，在 Linux 上用 CLI 或手动安装插件的用户要一起升级。
- **手机端**：Android 和 iOS 的 2.0.3 仍然可以使用，但登录续期、按供应商分组模型、「未同步」状态等需要 2.1.0。

### 会话创建与消息交付

- 新建会话失败后保留草稿、附件和创建请求，可以返回编辑或手动重试；重试前会重新检查模型、权限和 Agent 模式。（[#368](https://github.com/anywhere-labs/Agents-Anywhere/pull/368)）
- 只有 Runtime 实际收到消息才算创建成功。被明确拒绝时清理空会话、暂存附件和运行标记；结果未知时保留会话入口，避免重复创建。（[#368](https://github.com/anywhere-labs/Agents-Anywhere/pull/368)）
- DSH 模型目录尚未就绪时禁止提交，加载失败的目录可以重新加载。（[#368](https://github.com/anywhere-labs/Agents-Anywhere/pull/368)）
- 修复退出登录后迟到的创建响应、后台创建成功时抢占当前页面，以及附件预览的生命周期问题。（[#368](https://github.com/anywhere-labs/Agents-Anywhere/pull/368)）
- 附件下载失败时，会话里会列出没送到的文件名；正文和其他附件照常发送，即使这条提醒本身发送失败也不影响任务。（[#270](https://github.com/anywhere-labs/Agents-Anywhere/pull/270)）
- 下载端断开或传输过期后释放上传任务，修复本地文件中转永久阻塞。（[#270](https://github.com/anywhere-labs/Agents-Anywhere/pull/270)）

### Codex 与 Claude

- 接入 Codex App / IDE 插件的 IPC 协议，在 Codex 窗口里打开的会话也能在 AA 中继续操作，包括发消息、中断、审批、切换模型和权限、发送附件；支持 macOS 和 Windows。（[#299](https://github.com/anywhere-labs/Agents-Anywhere/pull/299)、[#334](https://github.com/anywhere-labs/Agents-Anywhere/pull/334)）
- 新增 `/open-in-codex-app` 和 `/kill-chatgpt` 命令：前者在 Codex App 中打开当前会话，后者退出 App 以释放写锁。（[#299](https://github.com/anywhere-labs/Agents-Anywhere/pull/299)）
- 写入（包括 `/compact`）发往当前持有会话的一方；会话被 Codex App 占着、却没有窗口显示它时，先让正在运行的 App 打开这个会话再发送（由设置「把被锁定的线程交给 Codex App」控制），仍联系不上持有方才报错，不会和 App 抢写锁。（[#437](https://github.com/anywhere-labs/Agents-Anywhere/pull/437)、[#455](https://github.com/anywhere-labs/Agents-Anywhere/pull/455)、[#506](https://github.com/anywhere-labs/Agents-Anywhere/pull/506)）
- 只读取状态或在后台同步时不再接管会话，Codex Desktop 和 AA 可以在同一个会话里同时对话。（[#445](https://github.com/anywhere-labs/Agents-Anywhere/pull/445)）
- Connector 作为 IPC 路由时，为每个请求单独查找处理方，修复两端互相等待 10 秒、导致 AA 的写入被误拦截。（[#446](https://github.com/anywhere-labs/Agents-Anywhere/pull/446)）
- AA 新建的会话会立即出现在 Codex App 里，App 新建的会话也会被立即跟随，两边都不用重启。（[#334](https://github.com/anywhere-labs/Agents-Anywhere/pull/334)）
- 修复 App 发给 AA 会话的消息被吞、Connector 重启后发消息报 502、启动回合超时被误判为失败。（[#334](https://github.com/anywhere-labs/Agents-Anywhere/pull/334)）
- 模型或权限读不到时显示「未同步」，发消息时不再把界面上的回退值写回 Runtime；AA 改过的权限不再被旧值覆盖，切回工作区写入权限时保留目录范围。（[#438](https://github.com/anywhere-labs/Agents-Anywhere/pull/438)、[#334](https://github.com/anywhere-labs/Agents-Anywhere/pull/334)）
- 在 AA 或 Codex Desktop 里修改 Connector 持有会话的模型和权限会立即生效，不再等下一条消息；权限按配置名传递，Desktop 不再把完全访问显示成「请求批准」。（[#453](https://github.com/anywhere-labs/Agents-Anywhere/pull/453)）
- Codex 的异步提问显示为可以作答的表单，答案只投递一次，Connector 重启后仍保持已回答状态。（[#439](https://github.com/anywhere-labs/Agents-Anywhere/pull/439)）
- 实时消息和历史记录中的同一条目不再出现两次（例如搜索）；新一轮开始时就关闭上一轮的失败卡片。（[#433](https://github.com/anywhere-labs/Agents-Anywhere/pull/433)、[#351](https://github.com/anywhere-labs/Agents-Anywhere/pull/351)）
- Claude 的模型名显示实际版本和上下文窗口，兼容 Bedrock、Vertex 等模型 ID；没有标题的会话名会压缩空白、截到 48 字。（[#289](https://github.com/anywhere-labs/Agents-Anywhere/pull/289)、[#219](https://github.com/anywhere-labs/Agents-Anywhere/pull/219)）

### DSH 同步

- 同步时显示「启动中 · 正在同步」，不再显示为错误；同步期间的会话操作不会打断同步。（[#299](https://github.com/anywhere-labs/Agents-Anywhere/pull/299)）
- 被截断的 emoji、乱码等孤立的 Unicode 字符不再让整个同步卡住，同时兼容旧插件的哈希。（[#326](https://github.com/anywhere-labs/Agents-Anywhere/pull/326)）
- 大历史上传更可靠：
  - 超过 8 MiB 的快照分页上传；
  - 先写临时文件再流式发送；
  - 不再受固定 ACK 等待窗口限制；
  - 第一页失败时直接报错，只有后续页会重试。

  [#332](https://github.com/anywhere-labs/Agents-Anywhere/pull/332)、[#324](https://github.com/anywhere-labs/Agents-Anywhere/pull/324)、[#353](https://github.com/anywhere-labs/Agents-Anywhere/pull/353)
- 某个会话的历史被 Server 拒绝时只隔离这个会话，其他会话照常同步。（[#328](https://github.com/anywhere-labs/Agents-Anywhere/pull/328)）
- 状态上报失败不再结束同步任务，任务意外退出后会自动重建。（[#327](https://github.com/anywhere-labs/Agents-Anywhere/pull/327)）
- 同步进度只在数据真正写入后才推进，快照和批次按顺序处理；关闭同步时会取消正在进行的上传和重新抓取。（[#353](https://github.com/anywhere-labs/Agents-Anywhere/pull/353)）
- 合并重复的失效通知，避免通知洪泛卡住首次扫描；适配 DSH 0.2.1 交互连接中本地所有者的改名。（[#339](https://github.com/anywhere-labs/Agents-Anywhere/pull/339)）
- 插件扫描历史会话后释放缓存，内存不再随会话数增长。（[#431](https://github.com/anywhere-labs/Agents-Anywhere/pull/431)）
- 0 字节的同步状态文件当作空状态处理，Connector 不再一启动就退出。（[#432](https://github.com/anywhere-labs/Agents-Anywhere/pull/432)）
- 没有保存默认 Agent 模式时，新建会话改为跟随 DSH 自己的默认模式，不再报错。（[#410](https://github.com/anywhere-labs/Agents-Anywhere/pull/410)）
- 内容哈希按实际传输的 JSON 计算，插件和 Connector 两侧算出的结果一致。（[#373](https://github.com/anywhere-labs/Agents-Anywhere/pull/373)）
- 插件所选的 PyPI 镜像缺少的包会自动从官方 PyPI 补齐，选清华、中科大、北外镜像时不再必然安装失败，与 Desktop 的处理方式一致。（[#451](https://github.com/anywhere-labs/Agents-Anywhere/pull/451)）
- 插件「设置 → 维护」新增「重装依赖环境」：依赖下载中断或环境损坏时一键删除并重新安装，进行中的安装会被中断，账号、设备连接和设置都保留。（[#452](https://github.com/anywhere-labs/Agents-Anywhere/pull/452)）

### Desktop

- 把本地文件夹拖进侧栏就能创建项目。重复目录、普通文件和一次拖入多项时会给出提示；拖拽结束或窗口失焦时，提示自动消失。（[#82](https://github.com/anywhere-labs/Agents-Anywhere/pull/82)）
- Connector 启动失败时显示真实原因，可以复制错误信息、打开日志目录。（[#294](https://github.com/anywhere-labs/Agents-Anywhere/pull/294)）
- 依赖下载失败时，可以在启动弹窗里切换 PyPI 镜像或 Python 下载镜像、重试，或者「清空缓存并重试」；所选镜像缺少的包会自动从官方 PyPI 补齐。（[#450](https://github.com/anywhere-labs/Agents-Anywhere/pull/450)）
- 启动之后的错误、后台进程退出、Connector 崩溃都会显示出来，后台退出后可以一键重新启动；后台起不来时立即报错，退出也不会再卡住。（[#450](https://github.com/anywhere-labs/Agents-Anywhere/pull/450)、[#383](https://github.com/anywhere-labs/Agents-Anywhere/pull/383)）
- 修复 Windows 中文用户名下首次启动卡在状态检查，以及 Node 或项目路径带空格时开发启动和打包失败。（[#380](https://github.com/anywhere-labs/Agents-Anywhere/pull/380)、[#384](https://github.com/anywhere-labs/Agents-Anywhere/pull/384)）
- 打包时排除用不到的 Router 二进制，修复 macOS universal 打包冲突，安装包也更小。（[#353](https://github.com/anywhere-labs/Agents-Anywhere/pull/353)）
- 「立即更新」会从官网 www.agents-anywhere.com 下载对应系统的最新安装包（macOS、Windows），不再提示「更新下载暂未开放」。（[#458](https://github.com/anywhere-labs/Agents-Anywhere/pull/458)）

### 本机连接、所有权与日志

- 本机控制和 DSH 桥接改用 MeshCall：Router 意外退出后自动重启；状态和日志断线后接着上次的位置继续，不需要重启 Connector。（[#353](https://github.com/anywhere-labs/Agents-Anywhere/pull/353)）
- 启动、停止、重启和保存配置按顺序执行，有操作正在进行时新操作直接拒绝；取消配对后，旧流程不会再保存凭据或自动连接。（[#353](https://github.com/anywhere-labs/Agents-Anywhere/pull/353)）
- 插件管理锁和机器记录锁改为随机端口加连接核实，修复 Windows 保留端口导致的启动失败。（[#329](https://github.com/anywhere-labs/Agents-Anywhere/pull/329)、[#330](https://github.com/anywhere-labs/Agents-Anywhere/pull/330)）
- 插件能识别本地开发版 Desktop，并在关键阶段重新确认由谁管理 Connector，避免两边同时启动它。（[#366](https://github.com/anywhere-labs/Agents-Anywhere/pull/366)）
- 插件和 Desktop 的日志页统一读取集中日志，可以按来源筛选、分页查看，并展示结构化的异常信息；Connector 还没启动时也能看到本次的启动诊断。（[#361](https://github.com/anywhere-labs/Agents-Anywhere/pull/361)、[#365](https://github.com/anywhere-labs/Agents-Anywhere/pull/365)、[#369](https://github.com/anywhere-labs/Agents-Anywhere/pull/369)）
- 日志损坏时自动恢复，日志目录不可用时改为只在内存中记录，日志问题不再阻止 Connector 启动；日志中的 token 和认证头会被脱敏。（[#353](https://github.com/anywhere-labs/Agents-Anywhere/pull/353)）
- 修复代理环境下 `NO_PROXY` 里 IPv6 回环地址的兼容问题。（[#373](https://github.com/anywhere-labs/Agents-Anywhere/pull/373)）

### Web 与 Desktop 界面

- 跳过教程或未添加 Agent 就继续时会提醒配置，进入主界面仍无 Agent 时可直接在弹窗中添加，已添加但离线的 Agent 不会触发空配置提醒，添加期间设备离线也可关闭弹窗。（[#513](https://github.com/anywhere-labs/Agents-Anywhere/pull/513)）

- 管理看板重做：
  - 新增概览、用户、使用量、设备与 Runtime、运行质量视图；
  - 支持选择时间范围，并显示实时指标；
  - 统计改为按事件记录，打开看板时不再重算历史数据；
  - 新增会话读取次数和只读会话统计。

  [#296](https://github.com/anywhere-labs/Agents-Anywhere/pull/296)、[#319](https://github.com/anywhere-labs/Agents-Anywhere/pull/319)
- 管理页和设置页改为侧栏导航，公告、身份认证、邮件和服务配置各自成页；这两类页面不再加载工作区和推送数据。（[#317](https://github.com/anywhere-labs/Agents-Anywhere/pull/317)）
- 在主页和管理 / 设置之间切换时，侧栏左右并排滑动。（[#317](https://github.com/anywhere-labs/Agents-Anywhere/pull/317)）
- 身份认证页按手机和桌面客户端分组，并修正 OAuth 回调地址。（[#317](https://github.com/anywhere-labs/Agents-Anywhere/pull/317)）
- 有多个供应商时，模型列表按供应商分组，同名模型也能分清来源；从 2.0.x 升级的 Server 也会显示分组，Connector 上报的模型目录不再被当作冲突拒绝。（[#411](https://github.com/anywhere-labs/Agents-Anywhere/pull/411)、[#463](https://github.com/anywhere-labs/Agents-Anywhere/pull/463)）
- 修复回复已经结束却一直显示「正在工作」。（[#393](https://github.com/anywhere-labs/Agents-Anywhere/pull/393)）
- 长会话的流式输出更流畅，减少整页重绘和输入卡顿。（[#394](https://github.com/anywhere-labs/Agents-Anywhere/pull/394)）
- 多个任务并行输出时，侧栏里的项目不再反复跳动。（[#311](https://github.com/anywhere-labs/Agents-Anywhere/pull/311)）
- 置顶 / 取消置顶、归档 / 恢复归档分别使用不同的图标。（[#162](https://github.com/anywhere-labs/Agents-Anywhere/pull/162)）
- 代码块统一为新样式，修复开启「减少动态效果」时 Mermaid 图异常放大、初始显示空白。（[#436](https://github.com/anywhere-labs/Agents-Anywhere/pull/436)）
- 登录、注册和找回密码改用原生表单，密码管理器能正确自动填充；按 Enter 和点主按钮都会提交，其他按钮不再误触发提交。（[#375](https://github.com/anywhere-labs/Agents-Anywhere/pull/375)）
- 浏览器标签页图标跟随系统亮暗色切换。（[#401](https://github.com/anywhere-labs/Agents-Anywhere/pull/401)）
- 快速设置里每种 Agent 只显示一次；删除 Runtime 后会真正移除，不再占用配置名额。（[#290](https://github.com/anywhere-labs/Agents-Anywhere/pull/290)）

### Android

- 扫码登录的 token 过期后自动续期，终端重连前也会刷新凭据，修复项目列表一直加载。（[#260](https://github.com/anywhere-labs/Agents-Anywhere/pull/260)）
- 输入框随软键盘上移，不再被键盘挡住。（[#255](https://github.com/anywhere-labs/Agents-Anywhere/pull/255)）
- Markdown 支持 LaTeX 公式；修复引用块里含代码块或公式时闪退。（[#382](https://github.com/anywhere-labs/Agents-Anywhere/pull/382)、[#390](https://github.com/anywhere-labs/Agents-Anywhere/pull/390)）
- 流式生成时保持当前的阅读位置。（[#428](https://github.com/anywhere-labs/Agents-Anywhere/pull/428)）
- 长会话流式输出的开销降低；模型设置里，不同供应商的同名模型不再被合成一项。（[#394](https://github.com/anywhere-labs/Agents-Anywhere/pull/394)、[#411](https://github.com/anywhere-labs/Agents-Anywhere/pull/411)）
- 「立即更新」会从官网 www.agents-anywhere.com 下载最新 APK。（[#458](https://github.com/anywhere-labs/Agents-Anywhere/pull/458)）

### iOS

- 跳过 Agent 配置或关闭连接引导时会提醒确认，进入主界面尚无 Agent 时可从提醒弹窗打开现有配置面板，没有设备时引导连接设备。（[#513](https://github.com/anywhere-labs/Agents-Anywhere/pull/513)）

- 启动和回到前台时展示公告，已读记录按服务器分别保存。（[#248](https://github.com/anywhere-labs/Agents-Anywhere/pull/248)）
- 模型选择器按供应商分组，与其他端一致。（[#449](https://github.com/anywhere-labs/Agents-Anywhere/pull/449)）
- 不再隐藏 Claude 的中断和空回复消息。（[#321](https://github.com/anywhere-labs/Agents-Anywhere/pull/321)）
- 设置里可以关闭文字浮现动画。（[#321](https://github.com/anywhere-labs/Agents-Anywhere/pull/321)）
- 本地归档改在后台读取，单条损坏的消息不再导致整份归档恢复失败。（[#321](https://github.com/anywhere-labs/Agents-Anywhere/pull/321)）
- 修复重新登录后头像和资料仍对应旧账号。（[#321](https://github.com/anywhere-labs/Agents-Anywhere/pull/321)）
- 流式输出和长会话性能全面优化：
  - 网络数据移出主线程处理，时间线增量更新；
  - Markdown 只重新解析还没写完的部分；
  - 界面只刷新实际变化的部分；
  - 缓存消息、代码高亮、头像和登录信息；
  - 断线重连后积压的消息一次性显示；
  - 只保存有变化的会话，发消息前不再等待全部会话写盘。

  [#321](https://github.com/anywhere-labs/Agents-Anywhere/pull/321)

### 文档

- README 补回 iOS TestFlight 下载入口，并注明 DeepSeek 官方的 DeepSeek Harness Desktop 不内置 AA 插件。（[#250](https://github.com/anywhere-labs/Agents-Anywhere/pull/250)、[#388](https://github.com/anywhere-labs/Agents-Anywhere/pull/388)）
- DSH 插件说明补充在 DeepSeek Harness Desktop 中安装插件的两种方式：在「插件」页面输入包名，或把提供的提示词发给 DSH 里的 AI 代装；同时说明了升级和卸载的方法。（[#457](https://github.com/anywhere-labs/Agents-Anywhere/pull/457)）

## 2.0.3 及更早

见 [2.0.3 发布说明](docs/releases/2.0.3.md) 和 [2.0.0 发布说明](docs/releases/2.0.0.md)。
