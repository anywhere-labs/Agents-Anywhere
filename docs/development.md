# v2 开发指南

## 分支与环境

`main` 是 v2 主线，新功能从最新 `main` 创建分支，分支名为 `<type>/<domain>/<topic>`（type 如 `feat`、`fix`、`docs`；domain 缩写为 `fe`、`be`、`con`、`dsk`、`apk`、`ios`、`dsh`、`docs`，多个 domain 用 `+` 连接），如 `feat/con+be/<topic>`。`v2` 保留用于发布过渡，不再把旧 `main` 的 API 和数据库假定套用到当前主线。历史资料见[升级指南](upgrading.md)。

使用 Python 3.12+、uv、Node.js 22、Corepack/Yarn。Docker 源码启动器需要 Docker Compose；Android 需要 JDK 17 与 Android SDK，iOS 需要 Xcode。各子项目独立安装依赖，不在仓库根目录运行一个假设存在的总构建命令。

## Web 与 Server 本地联调

从根目录手动启动：

```bash
./local-up.sh
```

它启动 Docker PostgreSQL/Redis、迁移数据库，再在前台运行 Server 和 Web。默认 Web 为 `http://127.0.0.1:5174`，Server 为 `http://127.0.0.1:8000`，PostgreSQL/Redis 端口为 `55432` / `56379`。日志在 `.local-dev/logs/`。按 Ctrl-C 停止本次启动的服务。

- `--skip-install`：复用依赖。
- `--with-connector`：一起启动 Connector；默认不启动。
- `--reload`：启用 Server 热重载；默认关闭以减少实时连接中断。
- `--access-log`：打印 uvicorn 逐请求访问日志；默认关闭。Server 日志级别默认为 INFO，可用 `LOGURU_LEVEL=DEBUG` 查看调试日志（`desktop-local-up.sh` 同样适用）。
- `--listen`：监听局域网地址；默认只监听回环。
- `--reset-data`：删除本地数据库数据卷，仅在明确不要这些数据时使用。

## Desktop

仅开发 Desktop，默认连接 Cloud：

```bash
cd desktop-workbench
yarn install
yarn dev
```

联调本地 Server 与 Desktop，在根目录手动运行：

```bash
./desktop-local-up.sh
./desktop-local-up.sh down
```

此启动器使用 Server `8000`、Web `5174`（Desktop 开发模式的登录页）和 Desktop `5184`，会释放这三个应用端口的既有监听者，然后像 `local-up.sh` 一样在前台运行 Server、Web 和 Desktop，并带前缀输出日志（同时写入 `.local-dev/logs/`）。按 Ctrl-C 停止本次启动的服务和数据库容器；`down` 用于停止另一个终端里仍在运行的启动器。更多环境变量与生命周期见 [Desktop README](../desktop-workbench/README.md)。

## Headless 检查

以下检查不要求打开 Electron、浏览器或移动模拟器。先在对应子项目安装依赖；只运行与修改有关的检查，不必为文档改动重新构建所有安装包。

```bash
cd server
uv sync
# tests/test_connector_pipeline.py 会导入 Connector 包，把它装进 Server 环境一次即可；
# 临时跳过可加 --ignore=tests/test_connector_pipeline.py
uv pip install --python .venv/bin/python ../connector
uv run ruff check . --exclude .venv
# 测试跑在真实 PostgreSQL 上：用本地 compose 起一个库，并单独建一个名字含 test 的数据库。
# 测试会在每个用例前清空该库的所有表，所以绝不能指向开发库或生产库。
docker compose -f ../docker/docker-compose.local.yml up -d postgres
docker compose -f ../docker/docker-compose.local.yml exec postgres \
  psql -U agents_anywhere -c 'CREATE DATABASE agents_anywhere_test'
export AGENT_SERVER_TEST_DB_URL=postgresql+asyncpg://agents_anywhere:agents_anywhere_dev_password@127.0.0.1:55432/agents_anywhere_test
uv run pytest -q
```

```bash
cd connector
uv sync
uv run ruff check connector tests
uv run pytest -q
```

```bash
# DSH 插件：集成测试会在进程内拉起 Connector 的 DSH 探针和 Server，需要上面同一个测试库变量
cd dsh-bridge-next
corepack yarn install
AGENT_SERVER_TEST_DB_URL=postgresql+asyncpg://agents_anywhere:agents_anywhere_dev_password@127.0.0.1:55432/agents_anywhere_test \
  corepack yarn check
```

```bash
cd web-next
yarn install
yarn test
yarn typecheck
yarn protocol:check
```

```bash
cd desktop-workbench
yarn install
yarn test:main
yarn renderer:typecheck
yarn workspace agents-anywhere-desktop-renderer test
yarn workspace agents-anywhere-desktop-renderer protocol:check
```

Server 测试应使用隔离测试环境，不要把生产数据库 URL 带入测试进程。Headless 检查通过不代表真实安装、OAuth 回调或远程 Runtime 会话已验证；这些按变更影响单独记录。

### CI 入口与缓存

`.github/workflows/ci.yml` 按路径选择 Connector、Server、DSH 插件、Web 和 Desktop
检查。Connector 通用代码改动同时触发 Server、插件和三平台 ACP；Server 改动同时触发插件。
ACP/Pi 受管验证脚本仅触发三平台 ACP，原生 Pi 验证脚本由独立 Pi compatibility 工作流覆盖。
`setup-yarn` 改动触发 Web、Desktop 和插件；`dsh-bridge.yml` 改动触发插件，
`pi-compat.yml` 由自身的 PR 工作流验证。主 CI、未知工作流、其他公共 action 和契约改动仍触发全部检查。

公共 `setup-yarn` action 仅缓存下载归档，按项目、Node、平台及依赖声明区分，
不缓存 `node_modules` 或 lockfile；缓存命中后仍执行安装，从当前清单解析依赖。
Python 环境在检查前准备一次，Server 中预装当前 Connector，之后以 `--no-sync`
运行检查；DSH 集成探针通过 `UV_NO_SYNC=true` 复用已准备的两个环境。
CI 的一次性 PostgreSQL 使用 tmpfs，减少每个用例清表的磁盘开销；不修改生产数据库
配置。pytest 保留外层硬超时，并输出慢项及分阶段耗时。

三平台 ACP 保留完整传输、进程清理和 Pi 场景验证。Pi 的 8 个受管场景通过
`verify-pi-managed.py --scenario all` 在同一进程内顺序执行，仅共用依赖缓存；
每个场景独立创建工作目录、会话和本地模型服务，失败立即结束并清理运行时与服务。
本地服务直接绑定回环地址，不执行反向 DNS 查询；日志显示模块导入、服务绑定、
运行时准备、每个场景及整个批次的耗时。

DSH 的 PR/push 检查统一在 CI 中执行。独立 `dsh-bridge.yml` 使用当前
`dsh-bridge-next/`，仅负责手动验包和既有 `dsh-bridge-v<包版本>` release 发布：
先完成类型、构建和测试，再用 `npm pack --ignore-scripts` 打包已验证的产物，
发布作业下载同一份归档，不重复安装、构建或触发 `prepack`。手动运行不会发布。

## 构建安装包

在 `desktop-workbench/` 运行：

```bash
yarn dist:mac   # 在 macOS 构建 Universal DMG
yarn dist:win   # 在 Windows 构建 x64 NSIS 安装包
```

签名、公证、架构选择及缓存重试见 [Desktop Packaging](../desktop-workbench/README.md#packaging)。凭据从环境或安全存储注入，不能提交到源码或文档。Android 的命令和签名边界见 [Android README](../android/README.md)。发布步骤见 [2.0.0 发布说明](releases/2.0.0.md)。

### Desktop 的 Pi 适配器准备

Desktop 在启动本机 Connector 前，先通过 `uv sync` 准备 Python 依赖，再安装并检查 Pi ACP 适配器及其 npm 依赖。环境准备弹窗会显示 Pi 准备阶段与安装输出，支持取消和失败后重试；全部完成后才启动 Connector。

Desktop 的所有 Pi 实例共用应用数据目录下的 `pi-npm-runtimes` 缓存；本机 Pi 的模型、认证和配置仍使用原来的本机目录。清空 Connector 环境会同时清空该适配器缓存，下次准备时重新安装。独立 Connector 保留首次创建或恢复 Pi 会话时按需安装的行为。

Connector 重连时，Server 保存并校验能力后即可继续恢复运行时；历史会话的能力广播由应用级后台任务完成，同一设备的新刷新替代旧刷新，断线和重连使用最新在线状态重新广播，服务退出时取消任务后再关闭存储。

### Server 按改动选择测试与并行运行

Server 可用 `scripts.check_tests` 运行测试。需要先安装 Server 开发依赖，
并按上文设置 `AGENT_SERVER_TEST_DB_URL`，指向已存在且名称含 `test` 的一次性数据库。
执行账号需要建库和删库权限。运行器只在此实例中新建随机命名的测试数据库，
为每个 worker 分配独立库；结束或超时后删除自己创建的库，不清空传入的基础库。
清库等待表锁超过 10 秒会失败并列出数据库连接，避免一直等待。

```bash
cd server
# 冷启动或完整回归，同时生成本机代码依赖基线
uv run python -m scripts.check_tests --mode full --workers 2
# 日常反馈：公共检查 + testmon 依据实际执行过的代码块选择的相关用例
uv run python -m scripts.check_tests --mode affected --base origin/main --workers 2
# 影子对照：相关用例跑完后仍执行全量，比较耗时与漏选失败
uv run python -m scripts.check_tests --mode shadow --base origin/main --workers 2
```

`--base` 用于判定本次修改是否包含 Python 执行覆盖之外的输入；testmon 会比较
当前代码与上次记录的执行依赖。普通函数修改可以跨测试文件选择到单条用例，
无需把 `test_backend_mvp.py` 整个交给某个 worker。认证、协议契约、架构边界和
基础设施健康检查固定执行，不受 testmon 选择结果影响。
缺少基线、无法解析 base、新增/删除或未跟踪输入、数据库基础设施、迁移、契约、
Connector、工作流和依赖配置等变化均回退全量。共享测试 helper 变化同样回退全量。
基线失效时不把“没有数据”视为“没有测试需要运行”。

PR/push 的 `Server tests` 默认只执行一次 `verify`：四 worker 全量验证，
不采集 testmon 依赖，不运行额外的公共检查或选测阶段，也不恢复/保存 testmon 缓存。
修改工作流、冷缓存或依赖变化都不会把常规检查切换为双 worker 覆盖采集。
完整测试结果仍决定检查是否通过。

基线采集与选测对照仅通过手动 `CI` 入口执行（建议 `scope=server`），
使用独立检查名 `Server test diagnostics`；它们不替代 PR 的 `Server tests`。
诊断模式仍会恢复成功运行的 `.testmondata`；缓存受 GitHub 分支作用域限制，
PR 的缓存不能作为其他 PR 的共享基线。
每次运行在 `server/.test-results/` 保存 `summary.json` 和分阶段 JSON：包含每条
用例的 setup/call/teardown 耗时、实际结果、快速阶段与全量耗时及漏选失败列表。
CI 将摘要显示在 Actions Summary，并上传 `server-test-report` artifact。
漏选失败列表用于排查选择盲点；空列表不等于证明未来修改不会漏测。
`--output` 可指定报告目录，`--timeout` 设置每阶段硬超时（默认 1200 秒）。
`.testmondata*` 和报告目录均不提交，业务版本号不受此检查影响。

GitHub Actions 手动运行 `CI` 时，可选 `scope=server`，只执行 Server 检查；
用 `server_workers=1/2/4` 比较同一提交的并行效果，`server_mode=verify` 为默认全量验证，
`full/shadow/affected` 用于基线采集、影子对照或快速诊断。手动运行互不取消，PR/push 仍会取消旧检查。
先用 full 生成成功基线，再用 shadow 和 `server_sample_change=true` 测量
真实函数修改的选择效果。该选项仅在一次性 CI checkout 中给公告读取函数加上
不改变返回值的 `.strip()` 调用，不生成提交、不修改远程源码。

`verify` 执行不采集依赖的全量检查，也是本地运行器的默认模式；`full` 执行全量并采集依赖基线。
已有有效基线的 shadow 阶段只为受影响用例采集依赖，随后全量验证不重复开启覆盖跟踪，
避免同一轮重复采集拖慢检查；冷启动和回退全量仍采集完整基线。

云端实测中四 worker 覆盖采集触发了一条异步等待失败；因此采集限制为最多两个 worker，
不带覆盖采集的验证可按 `server_workers` 使用四 worker。阶段报告分别记录实际 worker 数。

手动运行还可选 `server_mode=affected`，只执行公共检查和相关用例，用于快速诊断。
该模式的 job 名称为 `Server affected diagnostics`，不冒充必需的完整 `Server tests` 检查；
PR/push 仍执行带全量兜底的影子对照。JSON 报告目录是隐藏目录，上传步骤明确包含该目录。
