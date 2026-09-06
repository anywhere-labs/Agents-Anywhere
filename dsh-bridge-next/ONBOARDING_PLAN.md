# Onboarding 业务方案

状态：无 AA Desktop 的登录、设备上线、Web Agent 配置、可选手机连接和完成页已实现。按最新开发范围，本轮止于 onboarding 结束，不实现 DSH runtime，也不改造 Connector 的 DSH 适配器。

运行与验证说明见 [README](./README.md)。以下同时保留后续 Desktop 和 runtime 的目标设计；尚未接入的部分不代表当前已可用。

## 1. 名称与前提

- **Desktop**：Agents Anywhere 桌面应用，负责 AA 账号、设备和 Connector 管理。
- **DSH Desktop / DSH Host**：承载本插件、实际运行 DSH Agent 的应用或进程。它与上述 Desktop 是两个产品。
- **插件**：`dsh-bridge-next/`，其中 `src/host/dsh-runtime/` 实现所有 DSH 相关 Agent 业务。
- **Web**：Agents Anywhere Web 应用；未安装 Desktop 时，后半程 onboarding 在 Web 的专门页面完成。
- **本机**：运行插件 Host 的计算机及当前操作系统用户。安装检测由 Host 完成，浏览器前端通过插件接口取得结果。

首期覆盖 DSH Host 与执行本地 OAuth 回调的浏览器在同一台机器上的使用。远程浏览器中的 `localhost` 指向浏览器所在机器，不能把这种情况当成本机流程已经支持。

## 2. 两种模式的职责

| 能力 | 已安装 Desktop | 未安装 Desktop |
|---|---|---|
| AA 账号和用户凭据 | Desktop 管理 | 插件 Host 管理 |
| 本机设备注册、自动配对 | Desktop 管理 | 插件 Host 管理 |
| Connector 凭据和进程 | Desktop 管理 | 插件管理内部以源码运行的 Connector |
| onboarding 页面 | Desktop 专门页面 | 插件发起，OAuth 后进入 Web 专门页面 |
| DSH Agent 实现 | 插件 `host/dsh-runtime/` | 插件 `host/dsh-runtime/` |
| DSH 协议转发 | Connector 的 `runtimes/dsh/` | Connector 的 `runtimes/dsh/` |

无论是否安装 Desktop，Connector 的 DSH 适配器只负责公共接口接入、通信和协议转发；会话、模型、审批、历史、实时输出、DSH ID 关联及版本适配均在插件中实现。

插件 Host 的 DSH 端点与设置页是否打开无关。已有 Desktop 时，插件不再启用自己的账号、设备和 Connector 进程管理模块；保留运行时、安装检测和打开 Desktop 的入口。

Desktop 已安装但暂未运行、没有登录或打开失败，不等于未安装。不能因此自动启动第二个由插件管理的 Connector。

## 3. Desktop 安装记录与跨平台路径

### 3.1 固定的是路径规则，不是用户名和磁盘盘符

新共享安装记录统一约定为：

```text
<当前操作系统用户主目录>/.agentsanywhere/desktop/install.json
```

典型路径：

```text
macOS:   /Users/<用户名>/.agentsanywhere/desktop/install.json
Windows: C:\Users\<用户名>\.agentsanywhere\desktop\install.json
```

Windows 用户目录可能位于其他盘符，因此不能硬编码 `C:\Users`；macOS 也不能硬编码用户名。两端固定同一组相对路径片段，由操作系统解析用户主目录。

建议 Desktop 主进程与插件 Host 使用相同的解析规则：以 Node.js `os.userInfo().homedir` 获取操作系统当前用户的主目录，再由 `path.join` 拼接上述片段。这样避免一端的 `HOME` / `USERPROFILE` 环境变量覆盖影响 `os.homedir()`，导致双方读写到不同目录。

`.agentsanywhere` **不会天然存在**。Desktop 写入前必须递归创建目录，读取方要正常处理不存在的目录、文件和权限错误。两个程序必须以同一操作系统用户运行；不同用户、容器或远程主机不共享这一约定。

路径不随工作目录、仓库位置、DSH profile 或 `DSH_HOME` 改变。解析失败时报告检测失败，不悄悄使用另一个路径。

本次选择的 `.agentsanywhere` 专用于新的共享发现约定。仓库已有 Connector 数据目录是 `.agents-anywhere`；不要把二者误认为同一路径，也不要在本次开发中静默迁移既有 Connector 配置和凭据。

参考：[Node.js OS API](https://nodejs.org/api/os.html#osuserinfooptions)、[递归创建目录](https://nodejs.org/api/fs.html#fspromisesmkdirpath-options)。

### 3.2 记录内容与写入者

记录至少包含版本、平台、Desktop 应用路径和可执行文件路径。macOS 记录 `.app` 与内部可执行文件；Windows 记录实际 `.exe`，不假定安装在默认目录。

- 正式运行的 Desktop 负责记录自身真实安装地址，不能根据工作目录推测。
- 记录不放 user token、Connector token 等凭据。
- 使用原子替换方式更新，避免插件读到半份 JSON。
- 不记录需要每次启动变化的检查时间戳，以免破坏“内容正确就不重写”的约定。

### 3.3 Desktop 每次启动都检查

1. 取得当前应用实际安装位置，验证应用身份和启动目标。
2. 读取固定路径的已有记录，并验证记录指向的位置。
3. 若记录正确且与当前实际位置一致，保留文件，不重复写入。
4. 若没有记录、记录损坏、地址失效或安装位置改变，则更新为本次验证过的地址。
5. 写入失败要暴露诊断信息；不能因为有“首次初始化完成”标记而跳过检查。

**检查每次执行；写入只在必要时发生。**

### 3.4 插件每次进入 onboarding 都检查

1. 前端请求 Host 检测，不能由浏览器直接读取本地文件。
2. Host 重新读取共享记录并检查目标是否存在、是否为预期 Desktop 应用且具备启动条件。
3. 返回明确状态：已安装、未找到、记录失效或检测失败。前端不能永久缓存第一次结果。
4. 有效安装走 Desktop 分支；明确未找到走 Web 分支；权限问题或文件损坏提供重试和说明，不能伪装成正常检测结果。

还要覆盖“安装后从未启动 Desktop”和“卸载后残留记录”：只靠首次启动写文件无法完整判定安装情况。后续 Desktop 接入需通过安装器同步写入记录，或由检测器补查系统注册信息及有限的常见位置；未注册且无法确认的情况应说明检测结果，而不是断言一定未安装。插件进入流程前必须先读约定文件，补查用于处理文件缺失或失效。

在新旧管理模式之间切换时，要先确认原 Connector 的拥有者和退出状态，避免 Desktop 与插件同时管理同一设备。首期不实现自动迁移或双进程接管。

## 4. 统一的 onboarding 步骤

```text
登录 → 检查本机设备 → 配置 Agent
     → 是否连接手机 → 下载手机端 → 手机扫码登录 → 完成
```

两端复用相同的步骤语义和完成条件，但执行者不同。登录和设备检查已有有效状态时自动通过，不重复创建账号或设备。

- onboarding 是独立页面流程，完成前不先进入主页面再打开弹窗。
- Agent 配置列出该设备上所有可添加的 Agent，允许顺便添加其他 Agent，不只显示 DSH。
- 插件来源需检查目标 DSH 实例是否已配置且可用，不能因为另一个 DSH 实例或其他 Agent 存在就误判完成。
- 手机连接是可选步骤：提供“连接手机”和“暂时跳过”。跳过直接进入完成页，不自动授予手机登录。
- Agent 配置、手机下载和扫码登录复用现有内容组件及交互逻辑，剥离 Dialog 外壳后嵌入步骤页面。
- 异步操作失败停留在当前步骤并可重试；刷新或重复进入通过真实账号、设备和 Agent 状态恢复，不能以展示过页面代替完成。

普通 Desktop 首次启动也使用这一流程，其 Agent 配置面向全部可添加 Agent，不要求用户事先安装 DSH。

## 5. 已安装 Desktop 的流程

### 5.1 插件打开 Desktop

插件页面检测到有效安装后显示“打开 Agents Anywhere”。用户点击后，Host 启动或唤起记录中的 Desktop，并携带专门的 onboarding 入口信息。

建议沿用 Desktop 应用协议，新增与 OAuth 回调分离的 onboarding 入口。以下为待接入的协议形态，不表示已经实现：

```text
agents-anywhere-desktop://onboarding?source=dsh-plugin&flowId=<本次流程标识>
```

入口上下文要能定位发起插件的 DSH 实例，防止多实例时配置错对象。使用经过校验的实例标识或受限的本机上下文读取方式；URL 不携带账号或 Connector 凭据，不允许调用方传任意可执行命令或任意回跳地址。

Desktop 已运行时，同样处理入口并显示 onboarding 页面。重复来源请求按 `flowId` 避免重复创建设备；新的插件打开请求仍进入一次新的引导流程。

### 5.2 Desktop 专门页面的执行顺序

1. **登录**：没有有效登录时先登录；已登录则继续。
2. **检查本机设备**：未配对时，复用 Desktop 已有本地自动配对逻辑，用 user token 注册/恢复本机设备，取得 Connector ID 和 token，交给 Desktop 管理的 Connector 并确认上线。已有绑定时复用，凭据失效时进入恢复步骤。
3. **检查和配置 Agent**：目标 DSH 已配置且就绪则继续；尚未配置则显示页面内的快速添加 Agent 内容，列出全部可添加项。已配置但不可用显示修复状态，不重复添加。
4. **询问手机连接**：说明可以在手机上发起对话和继续任务，用户决定连接或跳过。
5. **手机下载引导**：在当前 onboarding 页面显示手机端下载内容。
6. **手机扫码登录**：在当前页面显示登录二维码和确认状态，沿用现有扫码授权流程。
7. **完成**：标题“设置完成”，说明“现在可以开始使用 Agents Anywhere 了”，显示“打开应用”。点击后才进入 Desktop 主页面。

### 5.3 普通首启与插件入口的区别

| 打开方式 | 是否进入 onboarding |
|---|---|
| 用户普通启动 Desktop，尚未完成引导 | 进入 |
| 用户普通启动 Desktop，已经完成引导 | 直接进入主页面 |
| 用户从插件点击打开 Desktop | 每次都进入，不受已完成标记阻挡 |

建议将完成状态保存到 `<用户主目录>/.agentsanywhere/desktop/onboarding.json`，由 Desktop 独占写入。在完成页点击“打开应用”后记录完成；中途退出不记录。插件来源完成后也可写入完成标记，但下次插件来源仍必须进入流程。

“每次进入”不代表重复登录、重复配对或重复添加 Agent。每次重新验证实际状态，已满足的步骤自动通过。

## 6. 未安装 Desktop 的流程（第一期）

### 6.1 插件作为本机管理端

此时插件承担一个精简 Desktop 的本机职责：用户管理、设备绑定、凭据持久化，以及内部源码 Connector 的运行管理。插件 Host 保存凭据，Web 提供后续引导页面。

Connector 的源码位置、运行环境和数据目录显式配置。源码虚拟环境与状态目录独立管理，避免污染插件构建目录。关闭 onboarding 页面不应停止已上线的 Connector；插件 Host 停止时负责清理自己创建的子进程和连接。

### 6.2 OAuth 与两次跳转

```text
插件页面点击登录
  → Host 创建 OAuth state、PKCE 和一次性本地回调
  → 浏览器打开 AA Web 的插件授权入口
  → 用户登录并授权
  → 浏览器回到插件 localhost，携带授权码与 state
  → Host 校验回调并换取 user token
  → 检查/注册本机设备，取得 Connector ID 和 token
  → 保存凭据并交给内部 Connector，确认上线
  → 本地回调页面再重定向到 AA Web onboarding，携带 connectorId
  → Web 检查当前账号和设备归属，显示该设备的引导步骤
```

这是给本机插件授权，不能只完成浏览器登录就宣告完成。账号 token 由 Host 通过授权码兑换；发给 Connector 的是 Connector ID 和 Connector token，而不是用户 token。

实现约束：

- 本地 OAuth 回调使用回环 HTTP 端点，与供 DSH 转发使用的 TCP/RPC 端点职责分离，不能把两种协议混为一个地址。
- 复用已有有效本机设备绑定；刷新、重试或重复登录不能创建重复设备。
- 本地回调只接受匹配且未消费的 state，授权码一次性消费，并使用 PKCE。
- 注册设备和启动 Connector 可能耗时，本地回调可显示短暂进度，再跳转；不能先返回“已完成”静态页面并关闭回调，丢失后续跳转。
- 回到 Web 的 URL 只携带设备 ID、来源和流程标识。user token、Connector token 均不得进入 URL。
- Web 沿用此次 OAuth 所在浏览器的登录状态；若登录已失效则先恢复登录，并保留 onboarding 上下文。
- `connectorId` 只是目标标识，不是权限。Web 必须通过现有鉴权接口确认设备属于当前用户；账号切换时停止原流程并要求处理，不直接操作另一账号设备。
- 只重定向到配置中的可信 AA Web 地址，不接受任意 `returnUrl`。API 地址与 Web 地址分开配置，避免默认认为两者在同一域名。
- Web 确认设备在线后再请求该设备的可添加 Agent；离线时显示等待、重试和返回插件排查的状态。

拟定 Web 引导入口形态如下，最终路由名称在实现时与 Web 路由体系统一：

```text
<AA Web 地址>/#onboarding?source=dsh-plugin&connectorId=<设备ID>&flowId=<流程标识>
```

### 6.3 Web 页面步骤与完成页

1. 根据 `connectorId` 定位本机设备，校验归属并等待上线。
2. 显示该设备的快速配置 Agent 页面，列出所有可添加 Agent。插件来源需要核对目标 DSH 的配置结果。
3. 询问是否连接手机；同意后显示下载引导，再显示扫码登录，均为页面内容。
4. 扫码授权成功或用户主动跳过手机步骤后，进入完成页。

完成页中文文案：

- 标题：**设置完成**。
- 说明：**设备已连接，现在可以开始使用 Agents Anywhere 了。**
- 主按钮：**立即体验**，打开 AA Web App。
- 次按钮：**下载桌面端**，打开统一配置的 Desktop 下载地址。
- 底部小字：**想了解更多？访问官网**，链接到 landing page。

Web 统一配置中增加/明确 `desktopDownloadUrl`、`landingPageUrl` 与应用入口地址。下载地址属于固定产品配置，页面读取该配置，不让用户填写或由 URL 参数覆盖。最终发布地址需在接入时核实，不写虚构链接。

当前用户确认两个地址都还没有，因此 `web-next/src/lib/product-links.ts` 中留空。完成页保留禁用的“下载桌面端 · 暂未开放”按钮，底部显示“官网即将上线”；“立即体验”正常进入 Web App。后续有正式地址后只更新这份产品配置。

用户每次从插件重新发起这一流程，都按传入设备继续引导；已有授权和绑定允许复用。普通访问 Web App 不因带过一次引导状态而反复强制跳回引导。

## 7. 已接入的内容与后续边界

这条工作线参考旧插件、Web、Server 和 Connector 的公开管理接口，没有读取或修改 `desktop-workbench/`。

- `web-next/src/components/agent-setup-content.tsx` 已提取页面内容，现有 `agent-setup-provider.tsx` 弹窗继续复用同一组件。
- `web-next/src/components/pages/mobile-signin-panel.tsx` 已导出独立的 `MobileConnectionContent`，下载、扫码与确认在 onboarding 页面内展示，现有 Dialog 保留。
- `dsh-bridge/src/manager/oauth-client.ts` 可参考本地回调、授权码换 token 和注册 Connector 的流程，但旧实现返回静态成功页，没有完成本方案要求的第二次 Web onboarding 跳转。
- `web-next/src/components/auth/mobile-oauth-page.tsx` 已支持独立的 `agents-anywhere-dsh-plugin` client，并校验精确回环地址、S256 和 state；登录/注册后保留引导上下文。
- 服务端已增加插件回环回调规则与按用户隔离的设备注册幂等键；OAuth 授权码只允许消费一次。Web 和插件仍各自持有自己的登录会话。
- Desktop 的现有组件与自动配对能力按本次产品说明列为复用目标，具体接入由 Desktop 负责方确认，不能把未检查的实现视为已经兼容。

## 8. 阶段进度与后续工作

| 阶段 | 主要工作 | 验收结果 |
|---|---|---|
| A. 本机入口与接口核对 | 实现共享路径解析和只读 Desktop 检测；建立插件引导入口；核对 OAuth、设备注册和 runtime 协议 | 未找到 Desktop 时进入 Web 分支，检测失败可区分；已安装时不启动插件自己的管理进程 |
| B. 本机授权与设备上线 | 插件 OAuth、localhost 回调、用户凭据、复用/注册设备、内部源码 Connector 启停和状态 | 登录后产生一个可复用的在线设备；重试不重复创建设备；失败可恢复 |
| C. Web 交接与 Agent 配置 | 本地二次跳转，Web 独立 onboarding 路由，校验 connectorId，提取 Agent 配置内容 | 已实现：显示该设备全部可添加 Agent，允许稍后添加；目标 DSH 接入归入 E 阶段 |
| D. 手机和完成页 | 页面内手机下载、扫码授权、可选跳过及双按钮完成页，集中配置下载/官网地址 | 完整走完流程，立即体验进入 Web App，下载和官网链接正确 |
| E. DSH 业务与真实验收 | DSH 业务集中迁入插件，按稳定协议收薄 Python 适配器；验证首条消息、实时输出、历史及恢复 | 从引导完成到实际 DSH 对话可用，并验证重启与重复进入 |

本轮已实现 A 的只读记录检测、B、C 和 D。有效 Desktop 记录会阻止插件启动自己的管理进程；安装器写入和未首启补查仍待 Desktop 接入。D 的桌面端和官网地址按用户确认留空。自动化验证覆盖本机回调、真实 Typert Gateway、进程清理、页面步骤及服务端授权；真实账号与 GUI 联调由用户启动。

下一阶段先手动验收现有 Web 引导链路，再按 E 阶段接入 DSH 端点、运行时业务和 Connector 薄转发。引导完成不要求本轮尚未实现的 DSH runtime 就绪。

Desktop 的启动记录写入、专门 onboarding 页面、协议唤起和首次完成标记作为后续一条工作线；共享文件格式和流程上下文先在本方案锁定，便于 Desktop 负责方接入。

首次开发不自动迁移已有 Desktop 或旧插件的凭据和进程。实现使用独立测试数据，启动服务和真实账号联调由用户明确发起。

## 9. 重点验收场景

- macOS / Windows：主目录不在默认位置、路径带空格或中文、目录首次不存在、权限不足。
- Desktop：记录正确不重写但确实重新检查；移动安装位置；卸载留痕；安装未首启；普通启动跳过已完成引导；插件唤起每次进入。
- 模式归属：已安装模式只由 Desktop 管理 Connector；无 Desktop 模式只由插件管理；打开失败不创建第二个进程。
- OAuth：取消、超时、错误 state、重复回调、用户中途切换账号；token 不进入跳转 URL 或日志。
- 设备：已有设备复用、凭据失效恢复、网络失败重试、传入无权限 connectorId 被拒绝、设备离线不显示虚假就绪。
- Agent：列出全部可添加项；目标 DSH 已添加时不重复；不可用时可诊断；Python 侧没有新加 DSH 业务分支。
- 手机：下载链接有效、二维码过期可刷新、授权成功后继续、主动跳过可完成；页面流程没有弹窗外壳。
- 完成：Desktop 点击“打开应用”才进主页面；Web 两个按钮和官网链接正确；关闭引导页不终止后台 Connector。
