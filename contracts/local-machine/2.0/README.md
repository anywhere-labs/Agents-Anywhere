# 本机 Connector 记录 v2

Python Connector 统一维护启动互斥、运行记录和本机 Connector ID 历史，覆盖 CLI、Desktop 和 DSH 插件启动的实例。Desktop 负责发布自身安装信息；插件只读取共享记录。各入口的账号、绑定和凭据仍保存在私有数据目录。

## 路径与字段

固定位置为 `<操作系统用户主目录>/.agents-anywhere/connector-runtime.json`。Node 入口使用 `os.userInfo().homedir`；Python 在 POSIX 使用当前 UID 的系统用户目录，Windows 使用用户主目录。工作目录、`--config`、`AGENT_CONNECTOR_DATA_DIR`、DSH profile 和 `DSH_HOME` 不改变互斥范围。

```json
{
  "version": 2,
  "legacyMachineMigrated": true,
  "desktop": {
    "platform": "darwin",
    "appPath": "/Applications/Agents Anywhere.app",
    "executablePath": "/Applications/Agents Anywhere.app/Contents/MacOS/Agents Anywhere",
    "launchArgs": [],
    "packaged": true
  },
  "onboarding": {
    "completedAt": "2026-09-09T06:40:00.000Z",
    "source": "desktop"
  },
  "connectorIds": ["conn_first", "conn_second"],
  "runtime": {
    "instanceId": "c4944154-836c-45c8-b918-c59328753158",
    "kind": "cli",
    "pid": 12345,
    "processStartedAt": "unix:1788840000.000000",
    "startedAt": "2026-09-08T06:40:00+00:00",
    "connectorId": "conn_second",
    "serverUrl": "https://api.example.test"
  }
}
```

`desktop`、`onboarding` 和 `runtime` 均可缺省。`connectorIds` 按首次记录顺序去重。`kind` 记录启动来源：`cli`、`desktop-workbench` 或 `dsh-plugin`；它只是标签，不授予绕过互斥的权限。记录中不包含用户 token 或 Connector token。未知字段原样保留；损坏记录或未知版本报错，不覆盖。

`onboarding` 由 Desktop 独占写入，插件和 Python 都不修改。`completedAt` 只在 Desktop 引导的完成页确认后写入，`source` 记录这次完成来自 `desktop`（用户主动启动）还是 `dsh-plugin`（插件深链唤起）。用户主动启动 Desktop 时读取该字段决定是否显示引导；插件深链唤起时每次都显示引导，与字段无关。

## Python 的启动判断

1. 在同一文件事务中读取运行记录、检查占用、发布本次运行记录。`pid` 必须是实际 Python Connector 进程的 PID，不使用 Electron、DSH Host 或 uv 父进程的 PID。
2. 检查记录中的 PID 是否存在，进程启动时间是否匹配，以及可执行文件和启动参数是否对应 Connector 入口。支持 `anywhere-cli`、`agent-connector` 和 `python -m connector.cli`。PID 已被其他进程复用、进程已经退出或是僵尸进程时不构成占用；无法检查权限时报告错误。
3. 存在另一个有效 Connector 时拒绝启动。没有有效占用才写入当前 PID、启动来源与启动时间。没有基于应用存活、文件年龄或定时心跳的第二套占用判断。
4. 接受带配置的启动时，在同一事务中追加 Connector ID；已有 ID 不重复追加、不改顺序。CLI 启动和旧绑定重连也会补登记缺失 ID。共享文件发布失败时不启动后端连接。
5. 互斥跟随 Connector 进程。`connector.stop` 停止后端连接，但 RPC 进程还在时仍占用；正常进程关闭时 Python 只清除自己的 `runtime`。异常退出留下的记录在下次启动时根据实际进程状态判断，ID 历史与安装信息保留。

`instanceId` 用于防止过期实例清除另一个实例的记录。旧的 `AA_CONNECTOR_OWNER_INSTANCE` / `AA_CONNECTOR_OWNER_PID` 不再用于授权或委托占用。

## 控制通道

`anywhere-cli rpc` 启动时拉起本进程专属的 MeshCall `LocalRouter`（Unix socket / Windows 命名管道），注册 `aa.local.v2.Control` 与 `aa.local.v2.Logs`，并在 stdout 写一行就绪信息后不再写任何内容：

```json
{"kind":"connector.ready","version":1,"instanceId":"4f1a…","pid":12345,
 "endpoint":{"unixPath":"…/router/4f1a….sock"},"key":"mk_host_…"}
```

宿主（Desktop 或插件管理器）用该 endpoint 与 key 建立 `Mesh`，调用控制方法；stdin 关闭即退出（Router 随之退出）。运行日志由 `aa.local.v2.Logs.write/read/tail/clear` 持久化与读取（host 可 `clear`，dsh-bridge 仅 `write`/`read`/`tail`，详见[日志契约](../../dsh-bridge/2.0/logs.md)），状态与配对通过 `aa.local.v2.Control.events(since)` 订阅；客户端保存 `lastSeq` 并在断线后带退避重新订阅。方法名、参数与旧 JSON-RPC 一一对应（`getState`、`getPaths`、`acquireOwnership`、`getConfig`、`saveConfig`、`start`、`stop`、`restart`、`startPairing`、`cancelPairing`）。

查询与订阅可以并发；`start`、`stop`、`restart` 与 `saveConfig` 在 Controller 内共用生命周期锁，`restart` 的停止与启动不可交错。配对的地址解析和网络轮询不占用该锁；`cancelPairing` 覆盖地址解析阶段，并使旧配对结果失效。配对成功后的凭据保存和自动启动也受生命周期锁保护，取消后尚未提交的配对不得再保存凭据或启动后端。进程退出时拒绝新的启动和配置保存，等待已有任务清理后再释放机器所有权。

控制变更方法均不声明幂等，不由 SDK 自动重试。尤其 `restart` 是一次重启动作，`startPairing` 会替换配对，两者都不能因回复丢失而重放。变更调用失败后，宿主先查询当前状态，再由用户明确决定是否重新发起。

生命周期变更进行中（包括已取消调用留下的后端清理）时，新的 `start`、`stop`、`restart` 和 `saveConfig` 立即返回 `connector_busy`，`retryable:false`，不排队、不合并，也不自动补执行。查询与 `cancelPairing` 仍可用；内部的配对提交和进程关闭可以等待生命周期锁。先后完成的两次显式 `restart` 表示两次用户操作，仍分别执行。

## 启动互斥冲突

`acquireOwnership` 用于无配置时的启动预检；`saveConfig`、配对和启动也由 Python 检查占用。Host 不自行检查 PID 或写入运行记录。冲突是应用错误码 `connector_already_running`：

```json
{
  "code": "connector_already_running",
  "message": "Another Connector is running (cli, PID 12345). Stop that Connector process, then retry.",
  "details": {"reason": "connector_already_running", "owner": {"kind": "cli", "pid": 12345}}
}
```

冲突是调用错误，控制通道仍可响应 `getState`，并在占用方退出后接受重试。其他意外失败映射为应用错误码 `connector_error`（等价于旧 `-32000`），参数错误为 `invalid_argument`。直接 CLI 启动则打印错误并以退出码 `2` 退出。

- Desktop 根据错误码展示冲突状态和重试入口，停止自动重启循环；重试再次调用 Python。Desktop 自身不持有或释放启动互斥。
- 插件把错误转为引导流程中的可重试提示，关闭自己启动但被拒绝的子进程。私有绑定和凭据保留，下次重试不因此新建设备。
- 提示要求结束占用方的 Connector 进程。仅断开服务器连接不代表进程退出。

## Desktop 安装信息与只读发现

Desktop 每次主进程启动校验自身真实应用位置和可执行文件权限，只更新 `desktop`。开发模式记录 Electron、项目路径与启动参数；正式模式记录实际安装位置。安装信息相同则不重写。写入时保留 Python 的 `runtime`、`connectorIds` 和未知字段；不修改、补登记或修复 ID 历史。`onboarding` 与 `desktop` 属于同一写入方，使用同一个短期文件事务，只在完成引导时更新。

插件读取安装信息用于判断管理入口，读取 ID 历史用于设备复用。读取不会创建文件、迁移旧文件、清除失效 PID 或修复内容。安装目标不存在时保留历史并允许原 Web 流程；损坏记录和权限错误明确报告。插件不读取也不写入 `onboarding`：它每次深链唤起 Desktop 都进入引导，是否跳过由 Desktop 自己判断。

两端配对都将有序本机 ID 与当前服务器、当前登录账号的设备列表匹配，取第一个交集。匹配到已有设备时轮换其 token，没有匹配才注册；读取、列设备或换 token 失败时停止并允许重试。私有凭据先持久化，Python 接受启动时再写共享历史。

## 短期文件事务与兼容

Python 和 Desktop 各自写入的字段位于同一文件，因此读取、合并和原子替换仍使用共同的短期文件事务。这只防止并发写入丢失，不承担 Connector 生命周期互斥；插件没有共享文件写锁。

事务锁不从路径算端口。写入者监听一个由操作系统分配的 `127.0.0.1` 端口（`listen(0)`），把 `{"version": 1, "port", "pid", "token", "startedAt"}` 以独占创建（`O_EXCL`）的方式写进 `<filePath>.lock.json`；持有期间该端口对任何连接只回一行 token，不提供业务服务。独占创建失败时读取记录，连接记录里的端口并要求对方答出 token：答得出说明另一写入者正持有事务，每 20ms 重试，5 秒超时报 busy；连不上、不答或答错说明持有者已不在（进程被强杀时操作系统释放端口），用临时文件 + 原子替换接管，接管后重读核对 token，不是自己的且对方活着则继续等待。正在写入中的半截记录先给短暂宽限再判定。事务结束时关闭监听，只删除仍属于自己的记录。数据文件的临时文件在同一目录，以 `0600` 写入并 `fsync`，原子替换后释放。

端口由系统分配，Windows 的保留端口段不会再拒绝事务，因此不再有"不加锁直接写入"的例外。两个写入者在同一瞬间接管同一条过期记录时可能短暂互相覆盖，由接管后的重读核对把窗口限制在一次往返内。旧版（按路径哈希固定端口）与新版写入者并存时互斥不生效，所有入口应一起升级。

Python 首次成功写入时迁移旧 `.agentsanywhere/machine.json`、`.agentsanywhere/desktop/install.json` 及旧版扁平 PID 记录，保留有序历史、Desktop 发布的安装信息和未知字段，完成后标记 `legacyMachineMigrated`。两个旧文件都不存在时直接标记完成，不锁定也不创建 `.agentsanywhere` 目录。Host 在迁移前仅提供兼容的内存读取视图。自定义配置目录中的旧运行记录也会检查；旧记录中的活跃 Connector 子进程仍阻止并发启动。所有入口应一起升级，避免旧入口继续按 v1 协议写入。

自动化测试在临时用户目录运行真实 Python CLI/RPC，覆盖三种启动来源竞争、RPC 重试、进程异常退出、无关 PID、ID 去重、Desktop 并发写安装信息和跨端设备复用。测试不启动真实后端、Electron 或 DSH GUI。
