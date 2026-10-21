# Connector WebSocket 数据同步压测

这套压测模拟真实 Connector 与 Server 的长连接，而不是只对 WebSocket
握手施压。每个虚拟用户独占一个 Connector，响应 Server 发出的
`runtime.discover` RPC，并持续发送以下实时通知：

- `timeline.itemUpsert`：默认占 80%，模拟助手正文流式更新。
- `session.state.updated`：默认占 10%，模拟运行／空闲状态变化。
- `session.source.updated`：默认占 10%，覆盖曾出现 CPU 热点的来源状态路径。

真实 Connector 会把大体积 `timeline.sync` 历史快照通过
`POST /api/v2/connector/ingest` 发送，不会通过 WebSocket 发送。本测试不改变该
协议边界。

## 1. 启动本地服务

从仓库根目录启动。不要同时使用 `--with-connector`，否则真实 Connector 流量会
污染基线：

```bash
./local-up.sh
```

默认 Server 地址为 `http://127.0.0.1:8000`。

## 2. 安装 k6

```bash
brew install k6
k6 version
```

## 3. 生成测试数据

```bash
server/loadtests/connector_ws/run-local.sh prepare
```

默认生成：

- 8 个 Connector；
- 每个 Connector 25 个 Session；
- 每个 Connector 一个自动创建的工作区 Project；
- 一个权限为 `0600` 的凭证清单：
  `.local-dev/loadtest/connector-ws/data.json`。

如果本地数据库是空的，脚本会读取 `.local-dev/logs/server.log` 中最新的初始化
Token，创建压测管理员。数据库已有用户时，需要提供一个现有账号：

```bash
export LOADTEST_EMAIL='admin@example.com'
export LOADTEST_PASSWORD='本地测试密码'
server/loadtests/connector_ws/run-local.sh prepare
```

可以调整数据规模：

```bash
server/loadtests/connector_ws/run-local.sh prepare \
  --connectors 16 \
  --sessions-per-connector 100 \
  --batch-size 50
```

再次生成前应先执行 `cleanup`，脚本不会覆盖旧清单，以免遗失清理凭证。

## 4. 冒烟验证

```bash
server/loadtests/connector_ws/run-local.sh smoke
```

冒烟测试使用一个连接、每秒两条通知，运行 30 秒。必须满足：

- WebSocket 返回 101；
- `runtime.discover` 得到合法响应；
- 没有发送和 RPC 响应错误；
- Timeline 回读能够看到检查点。

## 5. 三种压力模型

### 稳态流式更新

```bash
VUS=8 \
MESSAGES_PER_SECOND=20 \
TEST_DURATION=5m \
CONNECTION_SECONDS=300 \
server/loadtests/connector_ws/run-local.sh steady
```

总输入速率约为：

```text
VUS × MESSAGES_PER_SECOND
```

上例约为每秒 160 条 WebSocket 通知。稳态模式反复更新少量固定 Item，重点测量
服务端校验、合并、写缓冲、数据库和广播能力，不会无限增长 Timeline。

### 追加写入

```bash
VUS=8 \
MESSAGES_PER_SECOND=5 \
PAYLOAD_BYTES=4096 \
TEST_DURATION=5m \
CONNECTION_SECONDS=300 \
server/loadtests/connector_ws/run-local.sh append
```

追加模式每次创建新的 Timeline Item，会真实增加数据库体积。建议降低速率并在
测试后清理数据。

### 高频重连

```bash
VUS=8 \
CONNECTION_SECONDS=5 \
RECONNECT_PAUSE_SECONDS=1 \
TEST_DURATION=5m \
server/loadtests/connector_ws/run-local.sh reconnect
```

该模式覆盖鉴权、WebSocket 注册、运行时发现、上线能力发布、通知排空和断线清理。
它和稳定长连接应分别报告，不能混成一个容量数字。

## 6. 推荐阶梯

先固定 8 个连接，逐级提高每连接消息速率：

```bash
VUS=8 MESSAGES_PER_SECOND=5  TEST_DURATION=5m CONNECTION_SECONDS=300 server/loadtests/connector_ws/run-local.sh steady
VUS=8 MESSAGES_PER_SECOND=10 TEST_DURATION=5m CONNECTION_SECONDS=300 server/loadtests/connector_ws/run-local.sh steady
VUS=8 MESSAGES_PER_SECOND=20 TEST_DURATION=5m CONNECTION_SECONDS=300 server/loadtests/connector_ws/run-local.sh steady
VUS=8 MESSAGES_PER_SECOND=40 TEST_DURATION=5m CONNECTION_SECONDS=300 server/loadtests/connector_ws/run-local.sh steady
```

每档之间等待两分钟。首次超过阈值时停止加压，回退上一档运行 30 分钟：

```bash
VUS=8 \
MESSAGES_PER_SECOND=20 \
TEST_DURATION=30m \
CONNECTION_SECONDS=1800 \
server/loadtests/connector_ws/run-local.sh steady
```

如果需要测试更多长连接，必须先生成至少相同数量的 Connector；Server 禁止一个
Connector 同时建立两个连接。

## 7. 参数

| 环境变量 | 默认值 | 含义 |
| --- | ---: | --- |
| `VUS` | 8 | WebSocket 连接数，不得超过测试 Connector 数 |
| `MESSAGES_PER_SECOND` | 20 | 每条连接每秒发送通知数 |
| `TEST_DURATION` | `5m` | k6 场景持续时间 |
| `CONNECTION_SECONDS` | 300 | 单条连接保持时间；较短值用于重连测试 |
| `PAYLOAD_BYTES` | 1024 | Timeline 正文字节的近似值 |
| `ITEMS_PER_SESSION` | 4 | 稳态模式每个 Session 轮换的普通 Item 数 |
| `CHECKPOINT_EVERY` | 20 | 每多少条 Timeline 消息产生一个回读检查点 |
| `READBACK_INTERVAL_MS` | 1000 | 每条连接回读最老待确认检查点的间隔 |
| `TIMELINE_PERCENT` | 80 | Timeline 通知比例 |
| `STATE_PERCENT` | 10 | 状态通知比例；剩余比例为来源状态通知 |
| `RECONNECT_PAUSE_SECONDS` | 1 | 两次连接之间的等待时间 |
| `BASE_URL` | `http://127.0.0.1:8000` | Server 地址 |

若要专项复现 `session.source.updated` 热点：

```bash
TIMELINE_PERCENT=0 \
STATE_PERCENT=0 \
VUS=8 \
MESSAGES_PER_SECOND=20 \
server/loadtests/connector_ws/run-local.sh steady
```

## 8. 结果

每次运行生成独立目录：

```text
.local-dev/loadtest/connector-ws/results/<时间>-<模式>/
├── k6.log
├── report.html
└── summary.json
```

重点指标：

| 指标 | 含义 |
| --- | --- |
| `ws_messages_sent` | k6 已提交到 WebSocket 的消息数，不代表已经写库 |
| `sync_lag_ms` | 从检查点发送到 Timeline API 可读取的端到端延迟 |
| `checkpoints_sent/observed` | 已发送／已经回读确认的检查点 |
| `checkpoint_delivery` | 检查点在被下一版本覆盖或断线前得到回读确认的比例 |
| `ws_connection_success` | WebSocket 101 成功率 |
| `ws_connection_errors` | 连接或协议错误数 |
| `rpc_requests` | Server 发给模拟 Connector 的 RPC 数量 |
| `readback_success` | 回读成功率 |

默认通过条件：

- WebSocket 成功率大于 99%；
- 发送错误和 RPC 响应错误为 0；
- 回读成功率大于 99%；
- `sync_lag_ms` P95 小于 2 秒、P99 小于 5 秒。

回读器每次优先检查最老的待确认检查点，因此 `sync_lag_ms` 不会随每个 Connector
拥有的 Session 数量人为增加。若提高 `CHECKPOINT_EVERY` 或降低
`READBACK_INTERVAL_MS`，会增加回读采样密度，也会同时增加 Timeline API 压力。

同步通知没有逐条 ACK，因此不能只用 `ws_messages_sent` 判定 Server 容量。如果发送
速度正常但 `sync_lag_ms` 持续升高，说明服务端队列或数据库已经积压。

压测期间另一个终端持续观察：

```bash
top -pid "$(cat .local-dev/run/server.pid 2>/dev/null || pgrep -f 'uvicorn agent_server')"
docker stats
tail -f .local-dev/logs/server.log
```

本机压测会让 k6、Server、PostgreSQL、Redis 和 Web 竞争同一台机器。用于生产容量
规划时，应在另一台机器运行 k6，并让测试数据量接近生产。

## 9. 清理

```bash
server/loadtests/connector_ws/run-local.sh cleanup
```

清理只删除清单中记录的 Connector，并由 Server 的现有级联清理逻辑处理其 Project、
Session 和 Timeline。如果用户令牌已经过期，脚本会使用 `LOADTEST_PASSWORD` 重新登录。
