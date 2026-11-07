# 提案：连接 Claude Desktop 中的本地 Code 会话

> 状态：设计提案，未实现；需要维护者确认接入方向与可支持的会话控制接口。本 PR 不增加 Runtime 能力，不改变现有 Claude SDK 会话的行为。

## 用户目标

用户已经在 Claude Desktop 的 **Code** 页面打开本地项目并开始工作，希望通过 Agents Anywhere 的手机、Web 或桌面客户端继续操作**同一个活动会话**，回到 Claude Desktop 时仍能看到同一段对话和执行进度。

这不是新增一个同模型的 Agent，也不是把项目路径传给新 CLI 进程。共享代码目录、读取历史或恢复一份对话，不等于接管当前 Desktop 会话。Claude Desktop 的普通 Chat、Cowork 和云端执行会话不在本提案范围内。

## 当前实现与证据

### Agents Anywhere

- [Claude Provider](../connector/connector/runtimes/claude/provider.py) 使用 Claude Agent SDK；[能力声明](../connector/connector/runtimes/claude/provider_config.py) 中 `ipc` 为 `false`。
- [当前生命周期](claude-session-lifecycle.md) 描述 Connector 持有的 SDK/CLI 连接。不能据此声称已经跟随 Desktop 持有的活动会话。
- [Codex IPC 接入](codex-ipc-takeover.md) 可以作为所有权、事件同步和多端控制的设计参考，但它的传输协议与深链不能直接移植为 Claude Desktop 支持。

### Claude 官方公开能力

本提案核对了以下公开说明；实现前须再次核对当时文档与支持的版本：

1. [Remote Control](https://code.claude.com/docs/en/remote-control.md)：在 Desktop 的本地 Code 会话输入 `/remote-control` 或 `/rc`，可从同一账号的 `claude.ai/code` 或 Claude 手机 App 继续。该功能保持本地执行，经 Anthropic 服务同步。
2. [Desktop 的跨设备可见性](https://code.claude.com/docs/en/desktop.md#control-which-sessions-appear-on-your-other-devices)：Desktop 可以设置新会话自动连接 Remote Control。
3. [CLI 参考](https://code.claude.com/docs/en/cli-reference.md)：本次核对的 CLI 帮助另有 `--desktop`，可结合 `--continue` 或 `--resume` 打开桌面端；启动或导航能力不等于双向会话传输 API。

**证据边界：**这些说明证明官方提供 Desktop → 官方 Web/mobile 的路径；本次未找到并验证允许 Agents Anywhere 作为第三方控制面的稳定公开接管接口。不能把“尚未找到”写成“这种接口绝不存在”。

官方 Remote Control 有账号、套餐、API endpoint 和组织策略限制；公开文档当前不支持 API key 或自定义 API host。它只能作为符合条件用户的现有替代路径，不能代表所有 Agents Anywhere Claude Runtime 用户都可使用。

## 非目标与安全边界

- 不解包或修改 Claude Desktop，不从浏览器、钥匙串、用户配置或进程内存提取账户令牌。
- 不将 Claude 登录凭据上传到 AA Server；不要求用户在 issue、PR 或聊天里粘贴令牌。
- 不用模拟键盘点击、私有未版本化端点或关闭 Desktop 来冒充可靠的原生接入。
- 不把 `--resume`、历史文件导入、项目目录共享或外部网页跳转标为“已连接同一个 Desktop 会话”。
- 不自动降低权限、绕过组织策略、改变登录方式或开启 Remote Control。
- 不自动将已发现的全部本地对话上传到 Server；仅同步用户明确选择并授权暴露的会话。

## 建议分阶段讨论

### 阶段 0：确认可支持的接管协议

向上游或 Anthropic 确认有无可供第三方使用、可版本化的会话接口，至少需要：

- 发现用户允许暴露的本地 Code 会话，取得稳定身份与真实工作目录。
- 连接当前所有者，不另启同一会话的执行进程。
- 订阅快照、增量事件、工具活动与待处理交互。
- 发送消息、中断、回答审批；明确操作确认、超时和结果不确定的语义。
- 本机用户授权、最小作用域、撤销、版本兼容与会话所有权协商。

在这些条件未满足前，原生 Desktop attach 保持**未实现**，不将 Claude `ipc` 能力改成 `true`。若维护者接受先提供官方 Remote Control 指南或外部入口，应作为独立、准确标注的交付；不是本提案的原生接入验收结果。

### 阶段 1：可用接口下的最小纵向实现

接口确认后，先在一个支持的平台实现单会话完整链路。复用现有 Runtime protocol；确需新增字段或操作时先修改契约，再同步 Server 与所有受影响客户端。字段、传输方式与配置入口在协议确认前不定为既成 API。

逻辑上须区分以下会话来源，但此处不指定新的 wire enum：

| 来源 | 执行所有者 | AA 可宣称的能力 |
| --- | --- | --- |
| 现有 SDK/CLI 会话 | Connector | 沿用当前 Claude Runtime 能力 |
| 已验证的 Desktop attach | Claude Desktop | 仅声明接管协议实际支持的操作 |
| 官方 Remote Control 外部入口（若另行实现） | Claude 原生进程与官方服务 | 跳转官方控制面，不提供 AA 内消息、审批或 Timeline 承诺 |

所有权约束：Desktop 继续持有执行进程；AA 是被授权的控制端。Desktop 退出、撤销授权、网络断开或协议不兼容时，准确显示不可用，禁止静默退回 SDK resume。已发送但确认丢失的消息不得盲目重发。重新连接应使用稳定消息身份去重，并恢复真实待处理审批，而不是从旧日志重造审批。

### 阶段 2：跨端覆盖与发布

Web、Desktop Workbench、Android、iOS 按有效能力展示发现、连接、断开与不可用原因。涉及 Runtime 契约变化时遵循仓库的版本与跨端迁移规则。首个平台的自动化测试不代表其他操作系统已经支持；发布说明列出真实验证的 Desktop/CLI 版本、操作系统和未覆盖端。

## 验收标准

只有以下检查通过，才可将后续功能称为原生 Desktop 会话接入：

1. **同一会话**：在 Desktop 本地 Code 中创建合成测试任务；从 AA 连接后，对话身份、工作目录、当前轮次一致，没有第二个执行所有者或对话副本。
2. **双向同步**：从 Desktop 和 AA 分别发送不同消息；两端各出现一次，并反映对方真实工具活动。不能仅靠读取历史文件通过此项。
3. **审批与权限**：Desktop 与 AA 同时显示一个真实待审批操作；一端回答后另一端撤销，拒绝不会被改成允许。只读身份不能发送或审批。
4. **中断与故障**：从 AA 中断实际运行；断网、Desktop 退出、过期授权、未知协议版本分别得到明确状态，不偷偷恢复为 Connector 自有进程。
5. **重连与幂等**：断线重连不丢失已确认消息、不重复执行；发送确认超时表现为不确定结果并可校准，而非自动重发。
6. **隐私**：未选择的会话不出现在 Server 数据中；日志、诊断、URL 和测试 fixture 不包含真实凭据或私人对话。
7. **向后兼容**：现有 SDK 会话的创建、继续、权限、附件、后台任务和回收测试不回归。未支持 Desktop 的环境仍可按原方式使用 Claude。
8. **真实设备**：在发布声明支持的 Windows/macOS 平台分别做真实 Desktop + 手机或浏览器测试，注明版本与步骤。模拟协议测试不能替代此项。

自动化测试使用假 transport、合成事件与临时目录，不使用付费模型或真实账户。真实设备验收须由有权使用该账号与素材的人显式执行。

## 需要维护者决定的问题

- 是否愿意支持“跟随 Desktop 所有者”作为区别于现有 SDK 会话的接入路径？
- 是否已有可引用、可支持版本的公开或获授权会话协议？若没有，是否先向 Anthropic 请求扩展点？
- 首期支持哪些平台和最低版本？如何表达只读连接、授权失效与来源差异？
- 是否另做官方 Remote Control 的说明或外部入口？若做，须与原生 attach 分开命名和验收。

## 本提案的验证范围

本 PR 仅修改设计文档和文档导航；未实现 attach transport，未更改能力声明或 API，也未修改本机运行中的 Claude Desktop、Connector 和 DSH。已核对当前源码、官方文档和本地命令帮助；未启动模型请求，未读取真实会话正文或账户凭据，未进行真实跨设备接管测试。
