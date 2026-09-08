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

`desktop` 和 `runtime` 均可缺省。`connectorIds` 按首次记录顺序去重。`kind` 记录启动来源：`cli`、`desktop-workbench` 或 `dsh-plugin`；它只是标签，不授予绕过互斥的权限。记录中不包含用户 token 或 Connector token。未知字段原样保留；损坏记录或未知版本报错，不覆盖。

## Python 的启动判断

1. 在同一文件事务中读取运行记录、检查占用、发布本次运行记录。`pid` 必须是实际 Python Connector 进程的 PID，不使用 Electron、DSH Host 或 uv 父进程的 PID。
2. 检查记录中的 PID 是否存在，进程启动时间是否匹配，以及可执行文件和启动参数是否对应 Connector 入口。支持 `anywhere-cli`、`agent-connector` 和 `python -m connector.cli`。PID 已被其他进程复用、进程已经退出或是僵尸进程时不构成占用；无法检查权限时报告错误。
3. 存在另一个有效 Connector 时拒绝启动。没有有效占用才写入当前 PID、启动来源与启动时间。没有基于应用存活、文件年龄或定时心跳的第二套占用判断。
4. 接受带配置的启动时，在同一事务中追加 Connector ID；已有 ID 不重复追加、不改顺序。CLI 启动和旧绑定重连也会补登记缺失 ID。共享文件发布失败时不启动后端连接。
5. 互斥跟随 Connector 进程。`connector.stop` 停止后端连接，但 RPC 进程还在时仍占用；正常进程关闭时 Python 只清除自己的 `runtime`。异常退出留下的记录在下次启动时根据实际进程状态判断，ID 历史与安装信息保留。

`instanceId` 用于防止过期实例清除另一个实例的记录。旧的 `AA_CONNECTOR_OWNER_INSTANCE` / `AA_CONNECTOR_OWNER_PID` 不再用于授权或委托占用。

## RPC 冲突与入口处理

`anywhere-cli rpc` 先建立控制通道。`connector.acquireOwnership` 用于无配置时的启动预检；`connector.saveConfig`、配对和启动也由 Python 检查占用。Host 不自行检查 PID 或写入运行记录。

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": {
    "code": -32009,
    "message": "Another Connector is running (cli, PID 12345). Stop that Connector process, then retry.",
    "data": {
      "reason": "connector_already_running",
      "owner": {"kind": "cli", "pid": 12345}
    }
  }
}
```

冲突是请求错误，RPC 通道仍可响应 `connector.getState`，并在占用方退出后接受重试。直接 CLI 启动则打印错误并以退出码 `2` 退出。

- Desktop 根据 RPC 错误展示冲突状态和重试入口，停止自动重启循环；重试再次调用 Python。Desktop 自身不持有或释放启动互斥。
- 插件把错误转为引导流程中的可重试提示，关闭自己启动但被拒绝的子进程。私有绑定和凭据保留，下次重试不因此新建设备。
- 提示要求结束占用方的 Connector 进程。仅断开服务器连接不代表进程退出。

## Desktop 安装信息与只读发现

Desktop 每次主进程启动校验自身真实应用位置和可执行文件权限，只更新 `desktop`。开发模式记录 Electron、项目路径与启动参数；正式模式记录实际安装位置。安装信息相同则不重写。写入时保留 Python 的 `runtime`、`connectorIds` 和未知字段；不修改、补登记或修复 ID 历史。

插件读取安装信息用于判断管理入口，读取 ID 历史用于设备复用。读取不会创建文件、迁移旧文件、清除失效 PID 或修复内容。安装目标不存在时保留历史并允许原 Web 流程；损坏记录和权限错误明确报告。有效 Desktop 安装仍进入现有占位页面，协议唤起和专门 onboarding 需后续接入。

两端配对都将有序本机 ID 与当前服务器、当前登录账号的设备列表匹配，取第一个交集。匹配到已有设备时轮换其 token，没有匹配才注册；读取、列设备或换 token 失败时停止并允许重试。私有凭据先持久化，Python 接受启动时再写共享历史。

## 短期文件事务与兼容

Python 和 Desktop 各自写入的字段位于同一文件，因此读取、合并和原子替换仍使用共同的短期文件事务。这只防止并发写入丢失，不承担 Connector 生命周期互斥；插件没有共享文件写锁。

事务端口为 `49152 + sha256("aa-machine-state-v1\n" + canonicalPath).readUInt16BE(0) % 16384`。路径按 `realpath(dirname(filePath)) + basename(filePath)` 规范化，Windows 转小写。写入者独占绑定 `127.0.0.1` 端口，每 20ms 重试，5 秒超时报错；不提供业务服务。临时文件在同一目录，以 `0600` 写入并 `fsync`，原子替换后释放端口。

Python 首次成功写入时迁移旧 `.agentsanywhere/machine.json`、`.agentsanywhere/desktop/install.json` 及旧版扁平 PID 记录，保留有序历史、Desktop 发布的安装信息和未知字段，完成后标记 `legacyMachineMigrated`。Host 在迁移前仅提供兼容的内存读取视图。自定义配置目录中的旧运行记录也会检查；旧记录中的活跃 Connector 子进程仍阻止并发启动。所有入口应一起升级，避免旧入口继续按 v1 协议写入。

自动化测试在临时用户目录运行真实 Python CLI/RPC，覆盖三种启动来源竞争、RPC 重试、进程异常退出、无关 PID、ID 去重、Desktop 并发写安装信息和跨端设备复用。测试不启动真实后端、Electron 或 DSH GUI。
