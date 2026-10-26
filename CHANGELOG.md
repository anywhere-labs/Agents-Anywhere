# 更新日志

按版本记录用户能感知到的变化，最新版本在最前，每项一句话。接口变化、各端最低配套版本、数据库迁移和安装包记录见各版本的[发布说明](docs/releases/)。

## 2.1.0（未发布）

[发布说明](docs/releases/2.1.0.md) · [与 2.0.3 的差异](https://github.com/anywhere-labs/Agents-Anywhere/compare/v2.0.3...main)

### 升级须知

- **本机三端一起升级**：Desktop、Connector 和 DSH 插件之间的本机通道改用 MeshCall，2.0.x 与 2.1.0 互不兼容。只升级一端时，2.0.x Connector 会一直停在「等待 DSH」。（[#353](https://github.com/anywhere-labs/Agents-Anywhere/pull/353)）
- **数据库迁移**：Server 需要执行迁移 `v2_42`–`v2_44`。`/api/v2/admin/dashboard/*` 已删除，2.0.x 的 Web / Desktop 打开看板会得到 404。（[#296](https://github.com/anywhere-labs/Agents-Anywhere/pull/296)、[#299](https://github.com/anywhere-labs/Agents-Anywhere/pull/299)、[#290](https://github.com/anywhere-labs/Agents-Anywhere/pull/290)）
- **移除 SQLite 和 v1 导入工具**：Server 不再支持 SQLite 后端，也去掉了 v1 导入工具。仍在 v1 的部署要先用 2.0.x 完成导入；部署配置里的 `AGENT_SERVER_DB_BACKEND` 可以删除。（[#299](https://github.com/anywhere-labs/Agents-Anywhere/pull/299)）
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
- 写入发往当前持有会话的一方；会话被 Codex App 占着、却没有窗口显示它时，先让正在运行的 App 打开这个会话再发送（由设置「把被锁定的线程交给 Codex App」控制），仍联系不上持有方才报错，不会和 App 抢写锁。（[#437](https://github.com/anywhere-labs/Agents-Anywhere/pull/437)、[#455](https://github.com/anywhere-labs/Agents-Anywhere/pull/455)）
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

- 管理看板重做：
  - 新增概览、用户、使用量、设备与 Runtime、运行质量视图；
  - 支持选择时间范围，并显示实时指标；
  - 统计改为按事件记录，打开看板时不再重算历史数据；
  - 新增会话读取次数和只读会话统计。

  [#296](https://github.com/anywhere-labs/Agents-Anywhere/pull/296)、[#319](https://github.com/anywhere-labs/Agents-Anywhere/pull/319)
- 管理页和设置页改为侧栏导航，公告、身份认证、邮件和服务配置各自成页；这两类页面不再加载工作区和推送数据。（[#317](https://github.com/anywhere-labs/Agents-Anywhere/pull/317)）
- 在主页和管理 / 设置之间切换时，侧栏左右并排滑动。（[#317](https://github.com/anywhere-labs/Agents-Anywhere/pull/317)）
- 身份认证页按手机和桌面客户端分组，并修正 OAuth 回调地址。（[#317](https://github.com/anywhere-labs/Agents-Anywhere/pull/317)）
- 有多个供应商时，模型列表按供应商分组，同名模型也能分清来源。（[#411](https://github.com/anywhere-labs/Agents-Anywhere/pull/411)）
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
