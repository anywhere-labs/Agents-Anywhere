# Agents Anywhere <-> DeepSeek Harness Desktop Bridge

`@agents-anywhere/dsh-bridge` 是运行在 DSH Desktop 进程内的插件。它同时提供 Host SDK Bridge 和 Desktop 状态入口，让 Agents Anywhere Connector 连接用户正在使用的同一个 DSH Runtime，而不是另外启动一套 Runtime。

```text
Agents Anywhere Connector -> DshBridgeClient -> DSH Desktop 插件 -> DSH Services
DSH Desktop UI                                           ^
```

## 功能

- 通过带版本号的 JSON-RPC API 暴露 Session、Turn、Timeline、模型、权限、命令、取消和交互能力。
- Connector 与 DSH Desktop 共享同一进程中的 Session 日志、Agent registry 和操作队列。
- Session 名册携带 DSH Desktop 可见性：本地归档、尚未开始 turn 的空白会话和 subagent 会话在 AA 中进入 Archived，普通会话进入 Active。
- 写操作按 Session 串行执行，并使用稳定的 client message ID 处理重试。
- Connector 断开后 DSH Desktop 与实时 Session 继续运行，Connector 可以重新连接。
- Bridge 通知失败只记录为同步告警，不会撤销已经接受的 DSH 操作或终止 DSH Desktop。
- SDK 端点只绑定 `127.0.0.1`；随机认证令牌保存在权限为 `0600` 的端点文件中。

DSH Session 日志仍是对话历史的唯一持久真源。插件不支持跨主机连接，也不允许多个 Connector 同时连接同一个 DSH Desktop 进程。

## 本地构建

从 Agents Anywhere 仓库根目录执行：

```bash
cd dsh-bridge
corepack enable
pnpm install --frozen-lockfile
pnpm verify
```

构建后的 `lib/` 是插件分发产物，需要和源码一起提交。安装插件时不会在用户机器上执行构建脚本。

## Desktop 开发安装

DSH Desktop 当前使用的内部插件 profile 名称是 `web`。这只是 DSH CLI 的内部标识，不代表用户需要另外启动一套 Web 产品。

```bash
dsh plugin --profile web add /absolute/path/to/Agents-Anywhere/dsh-bridge
```

安装后启动或重启 DSH Desktop。插件会写入 Connector 发现文件：

```text
$DSH_HOME/agents-anywhere/bridge/endpoint.json
```

未设置 `DSH_HOME` 时使用 `~/.dsh`。端点端口和认证令牌由插件生成，不需要手工填写。

## Agents Anywhere 配置

启动 DSH Desktop 后，在 Agents Anywhere 中启用 DeepSeek Harness Runtime：

| 配置项 | 建议值 |
| --- | --- |
| DSH home | 留空；只有 DSH Desktop 使用自定义 `DSH_HOME` 时才填写相同的绝对路径 |
| `startupTimeoutMs` | `30000` |
| `requestTimeoutMs` | `60000` |
| `maxRestartAttempts` | `3` |
| `restartBackoffMs` | `1000` |

Connector 不拥有 DSH Desktop 进程，因此停止 Connector 不会关闭 DSH Desktop。

## 验证

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm pack --dry-run
```

真实会话验证需要同时运行 DSH Desktop 和 Agents Anywhere Connector。

## 限制

- 仅支持同一机器、同一操作系统用户。
- 一次只接受一个 Connector 连接。
- 不支持跨主机共识、网络分区接管或多个 DSH 进程合并同一 Session 日志。
- 当前协议不支持图片和普通文件附件。
- DSH Desktop 的当前选中 Session 是客户端本地状态；Host Bridge 不暴露空白占位会话，空白会话开始第一个 turn 后才进入 AA Active。
- AA 当前不会根据后续的 `hidden=false` 自动取消已有归档；已在 AA 中归档的普通会话需要手动取消归档一次。
- 多客户端 user-question 镜像只在目标 DSH 提供 observer 扩展时启用；DSH Desktop 仍可处理原生问题。

## 维护

插件代码、Issue、版本和发布均由 [`anywhere-labs/Agents-Anywhere`](https://github.com/anywhere-labs/Agents-Anywhere) 仓库的 `dsh-bridge/` 目录统一维护。
