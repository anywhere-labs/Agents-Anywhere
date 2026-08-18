# Agents Anywhere ↔ DeepSeek Harness Bridge

`@agents-anywhere/dsh-bridge` 是一个独立的 DSH Web bundle，同时提供 host SDK 服务和 Web 状态入口。Agents Anywhere Connector 连接已经运行的 `dsh web`，两端使用同一个 DSH 进程和同一个实时 Agent。

```text
Agents Anywhere Connector → DshBridgeClient → DSH Web 插件 → DSH Services
DSH Browser                                      ↗
```

插件不启动第二个 DSH 进程，不需要 `aa` profile，也不依赖 `@deepseek-ai/dsh-session-control`。

## 功能

- 通过有版本的 JSON-RPC API 暴露 Session、Turn、Timeline、模型、权限、命令、取消和交互能力。
- Connector 与浏览器共享 DSH Web 进程中的 Session 日志、Agent registry 和操作队列。
- Session 名册携带 DSH Desktop 可见性：本地归档、尚未开始 turn 的空白会话和 subagent 会话在 AA 中进入 Archived，普通会话进入 Active。
- 写操作按 Session 串行执行，并使用稳定的 client message ID 处理重试。
- Connector 断开后 DSH Web 与实时 Session 继续运行，Connector 可以重新连接。
- Bridge 通知失败只记录为同步告警，不会撤销已经接受的 DSH 操作或终止 DSH Web。
- SDK 端点只绑定 `127.0.0.1`；随机认证令牌保存在权限为 `0600` 的端点文件中。

DSH Session 日志仍是对话历史的唯一持久真源。插件不支持跨主机连接，也不允许多个 Connector 同时连接同一个 DSH Web 进程。

## 本地构建

```bash
cd /absolute/path/to/aa-plugin
corepack enable
pnpm install
pnpm verify
```

构建后的 `lib/` 是 Git 分发产物，需要和源码一起提交。安装 Git 依赖时不会在用户机器上执行构建脚本。

## 本地安装

只安装到 `web` profile：

```bash
dsh plugin --profile web add /absolute/path/to/aa-plugin
dsh web
```

插件启动后会在以下位置写入 Connector 发现文件：

```text
$DSH_HOME/agents-anywhere/bridge/endpoint.json
```

未设置 `DSH_HOME` 时使用 `~/.dsh`。端点端口和认证令牌由插件生成，不需要手工填写。

## GitHub 安装

发布版本后，用户执行：

```bash
dsh plugin --profile web add github:xipian1216/dsh-aa-bridge#v0.1.0
dsh web
```

固定 tag 或 commit 可以避免上游更新导致未审查代码在下次安装时变化。

## Agents Anywhere 配置

先启动 `dsh web`，再在 Agents Anywhere 中配置 DeepSeek Harness：

| 配置项 | 建议值 |
| --- | --- |
| DSH home | 留空；只有 Web 使用自定义 `DSH_HOME` 时才填写相同的绝对路径 |
| `startupTimeoutMs` | `30000` |
| `requestTimeoutMs` | `60000` |
| `maxRestartAttempts` | `3` |
| `restartBackoffMs` | `1000` |

不再填写 DSH executable、profile、环境变量、shutdown timeout 或 kill grace。Connector 不拥有 `dsh web` 进程，因此停止 Connector 不会关闭 Web。

## 验证

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm pack --dry-run
```

真实会话验证由维护者启动 DSH Web 和 Agents Anywhere Connector 后执行。

## 限制

- 仅支持同一机器、同一操作系统用户。
- 一次只接受一个 Connector 连接。
- 不支持跨主机共识、网络分区接管或多个 DSH 进程合并同一 Session 日志。
- 当前协议不支持图片和普通文件附件。
- DSH Web 的当前选中 Session 是浏览器本地状态，Host bridge 不会暴露空白占位会话；空白会话开始第一个 turn 后才进入 AA Active。
- AA 当前不会根据后续的 `hidden=false` 自动取消已有归档；已在 AA 中归档的普通会话需要手动取消归档一次。
- 多客户端 user-question 镜像只在目标 DSH 提供 observer 扩展时启用；普通 Web 仍可处理原生问题。
