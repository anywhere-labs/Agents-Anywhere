# Anywhere CLI

> v2 Connector。请使用与你的 Server 同一发布线的源码。Python 包版本独立于 2.0.0
> 产品版本。

Agents Anywhere 的本地运行时连接器。它运行在拥有工作区与 Agent 运行时的机器上，
通过 HTTP/WebSocket 连接服务器，在本地执行 Connector RPC，并把归一化后的运行时/
会话状态上传回后端。

## 目录结构

```text
connector/
  runtime_protocol/  AgentRuntime、RuntimeProvider、RuntimeHostClient 契约
  runtimes/          Codex、Claude 与 DSH 的 RuntimeProvider/AgentRuntime 包
  server/            后端认证、ingest、RPC 通道、请求分发、host 映射
  core/              Connector 配置、JSON-RPC、运行时属主、运行时配置存储
  local/             本地文件系统、shell 与终端后端
  _reference/        保留作迁移参考的旧适配器实现
  cli.py             anywhere-cli CLI
  control.py         本地桌面/control JSON-RPC 入口
tests/          Connector 测试
pyproject.toml  Connector 依赖与 console script
run.sh          基于已保存配置启动的本地辅助脚本
```

## 运行

从本仓库的 `connector/` 目录运行。这样在连接 v2 Server 时不会依赖未经验证的公开
包版本。安装依赖：

```bash
uv sync
```

使用 Web 配对流程给出的显式凭据启动：

```bash
uv run anywhere-cli start \
  --server-url http://127.0.0.1:8000 \
  --connector-id conn_xxx \
  --connector-token cxt_xxx
```

或把配置保存到本地后无参数启动：

```bash
uv run anywhere-cli configure \
  --server-url http://127.0.0.1:8000 \
  --connector-id conn_xxx \
  --connector-token cxt_xxx

uv run anywhere-cli start
```

默认配置路径为 `~/.agents-anywhere/connector.json`。可以用 `--config` 或
`AGENT_CONNECTOR_CONFIG` 覆盖。

Connector 配置、运行时属主、同步状态与附件默认都存放在 `~/.agents-anywhere` 下。
运行时同步游标以原子 JSON 的形式存放在 `<connectorId>/<runtimeId>/sync-state.json`；
运行时消息绑定使用旁边的 `kv.json`。Connector 在构造运行时之前准备好这些存储，
并为周期/关机刷写保留所有已打开的存储，包括已停止的实例。既有同步与 KV key 以及
读写接口保持不变，包括运行时 source key 隔离。Connector 不使用 SQLite。首次使用
时，v2 连接器会执行一次性本地数据迁移，把旧的 `~/.agent-server` 目录迁入
`~/.agents-anywhere`，并丢弃过时的 SQLite 同步状态。

当实例目录不存在时，启动会把整个旧版 `connector-state.json` 与
`connector-kv.json` 复制到临时目录，并在两个文件都校验通过后再发布。除复制前刷写
待提交的同步状态外，旧文件不会被改动。已存在的实例目录永远不会被重新复制或合并；
读取与删除不会回退到旧数据。复制出的文件保留旧的命名空间，因此外部实例记录不会被
该运行时的常规 key 选中。迁移失败会阻塞该运行时的启动，可以重试。Agent 原生历史
与机器属主记录不会被搬移。

Codex 恢复使用一个可选的只读原生历史索引来避免加载未变化的消息正文。对于独立的
分页历史，它先验证 `thread_history_1.sqlite` 已经消费当前的发布，再把每个 turn 的
元数据与 item 更新序号和已提交的 checkpoint 比较。未变化且已完结的历史在重启后
无需任何历史 RPC。新 turn 通常只需一页 20 条；上一页尾部会被复查。更早 turn 的
变更会向最早变更的 turn 回读。前缀 item 计数用于保持 timeline 顺序。

这个索引只是一个优化，不是另一个数据属主：它以只读方式打开，AA 绝不修复或迁移
它。未知 schema、滞后的投影、继承来的历史、压缩、缺失来源或无效 checkpoint 都会
回退到完整历史 RPC。删除、重排与来源替换需要完整校准。分页读取期间发生的变更会
中止 checkpoint 提交，并在下一次扫描时重试。原生文件的 identity、size 与纳秒级
mtime 补充 API 的秒级变更标记。索引校验与 checkpoint 元数据的开销仍随历史规模
增长，但未变化的消息正文既不会被拉取也不会被投影。

每个投影后的条目会与 `sync-state.json` 中它上次成功 ingest 的指纹比较。未变化的
条目被省略，包括重连/重启之后；新增与修改的条目以增量发送。首次同步发送全部条目。
条目删除或不兼容的 checkpoint 版本使用会话替换快照。会话活跃期间替换被推迟，且
不提交其 checkpoint。ingest 失败永远不会推进已准备的指纹状态。实时通知不推进该
扫描 checkpoint，因此最新的实时条目可以被下一次成功的扫描安全地重发一次。指纹的
规模随 timeline 条目数增长。恢复进度按会话跟踪，一个失败会话不会迫使所有成功的
会话在每次轮询时重读历史。Codex 的 active-writer 冲突在发送消息之前就作为接管
失败上报；AA 不会悄悄挤掉持有写入锁的另一个原生客户端。

## 本地启动属主

所有 CLI、Desktop 与 DSH 插件的启动都使用 Python 的按用户启动检查
（`<OS user home>/.agents-anywhere/connector-runtime.json`），与私有配置或数据
路径无关。Python 记录实际的 Connector PID、启动来源与进程启动时间。只有当记录中
的 PID 仍指向那个 Connector 进程时才阻止启动；存活的其他进程或被复用的 PID 不会
阻止启动；检查权限失败会上报而不是绕过。

每次被接受的已配置启动都会把它的 Connector ID 追加到有序历史中一次，包括 CLI
启动与既有绑定。Python 在正常关机时只移除自己的运行时记录。崩溃留下的记录由下一
次启动对照实际进程检查。通过 `connector.stop` 停止后端连接时，只要 RPC 进程仍
存活就保留属主记录。

RPC 调用方在冲突时收到 `-32009`，`data.reason = connector_already_running`。
`connector.acquireOwnership` 支持在凭据产生之前做预检；被拒绝的请求会保持 RPC
通道存活，供 `connector.getState` 与重试使用。CLI 直接启动会报告冲突并以退出码
`2` 退出。

Desktop 仍是唯一的安装元数据写入方；插件只读取。两个宿主都不追加共享 ID，也不
检查启动 PID。字段、原子文件事务与旧数据迁移见
[本机 v2 契约](../contracts/local-machine/2.0/README.md)。

## 运行时发现

默认的 provider 是 Codex、Claude 与 DSH。连接器把已接入运行时的能力上报给
服务器。Codex 通过官方 `openai-codex` SDK 包发现；连接器不把 Codex CLI/app-server
路径或 IPC 开关作为活跃运行时入口。如果 Claude Code 不在 `PATH` 上，请设置：

```bash
CLAUDE_BIN=/path/to/claude
```

DSH 需要 [DSH Bridge Next](../dsh-bridge-next/README.md) 描述的桥接集成。旧版
ACP 适配器不在默认 provider 注册表中。

已连接的会话通过实时运行时目录暴露原生 slash 命令。Codex 命令、DSH 注册表行为、
结果状态与 headless 验证见[runtime slash 命令](docs/runtime-commands.md)。

连接器使用本地运行时凭据与本地文件系统权限。Agents Anywhere 不代理 Claude 或
Codex 账号凭据。

## API Namespace

Connector 配置保存的是服务器 origin，例如 `http://127.0.0.1:8000`；
`--server-url` 中不要带 `/api/v2`。

连接器在内部追加 v2 namespace，并与 `/api/v2/connector/*`、`/api/v2/health`
通信。namespace 规则见 `../docs/api/namespace.md`。

## 本地操作

服务器可以让在线的连接器执行本地工作：

- 在工作区安全根内读取/列出/写入文件
- 通过服务器上传/下载文件内容
- 运行一次性 shell 命令
- 启动并等待 shell 任务
- 创建、写入、调整大小、流式读取、列出与关闭交互式终端
- 启动、中断、同步与审批运行时回合

## 环境变量

| 变量 | 用途 |
| --- | --- |
| `AGENT_CONNECTOR_CONFIG` | Connector 配置路径。 |
| `AGENT_CONNECTOR_DATA_DIR` | Connector 数据目录。默认 `~/.agents-anywhere`。 |
| `AGENT_SERVER_URL` | 省略 `--server-url` 时使用的服务器 URL。 |
| `AGENT_CONNECTOR_ID` | 省略 `--connector-id` 时使用的 Connector id。 |
| `AGENT_CONNECTOR_TOKEN` | 省略 `--connector-token` 时使用的 Connector token。 |
| `AGENT_CONNECTOR_STATE_FILE` | 旧版同步状态来源；其父目录是新 `<connectorId>/<runtimeId>/` 目录的根。默认 `~/.agents-anywhere/connector-state.json`。配置里的 `statePath` 优先。 |
| `AGENT_CONNECTOR_KV_FILE` | 旧版 KV 复制来源。默认 `~/.agents-anywhere/connector-kv.json`；新的运行时写入使用实例自己的 `kv.json`。 |
| `AGENT_CONNECTOR_ATTACHMENTS_ROOT` | 运行时附件下载目录。默认 `~/.agents-anywhere/attachments`。 |
| `CLAUDE_BIN` | 显式指定 Claude Code CLI 路径。 |

## 验证

```bash
uv run ruff check connector tests
uv run pytest -q
```

DSH 插件默认将私有数据存放在 `~/.agents-anywhere/dsh-bridge-next/`，其托管 Connector 通过 `AGENT_CONNECTOR_DATA_DIR` 使用其中的 `connector/` 子目录。插件首次启动负责迁移旧 `.agentsanywhere/dsh-bridge-next/` 数据；通用 Connector 的默认路径和自定义环境变量行为不变。
