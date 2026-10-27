# Agents Anywhere — Agent 工作指南

本文件写给在本仓库中工作的编码 Agent（Codex、Claude Code 等）。面向人的说明见 [docs/README.md](docs/README.md)；本文件只保留 Agent 做出正确修改所需的内容。

## 项目是什么

Agents Anywhere 是一个跨设备的 Agent 工作台。工作设备上的 **Connector** 连接并运行 Codex、Claude Code、DSH 等 Runtime；**Server** 负责账号、会话、Timeline 和转发；**Desktop / Web / Android / iOS** 客户端通过 Server 查看会话、回复审批、管理文件与终端。当前产品版本为 2.x，API namespace 为 `/api/v2`。

## 目录地图

| 目录 | 内容 | 技术栈 |
| --- | --- | --- |
| `server/` | API、实时通道、存储；分层规则见 [Server 架构](docs/server-architecture.md) | Python 3.12、FastAPI、PostgreSQL、Redis、Alembic、uv |
| `connector/` | 工作设备侧进程，连接 Server 并驱动 Runtime | Python、uv |
| `web-next/` | Web 客户端（另有自己的 [AGENTS.md](web-next/AGENTS.md)） | Next.js、TypeScript、Yarn |
| `desktop-workbench/` | **当前**桌面客户端，内含受管理的本机 Connector | Electron、TypeScript、Yarn |
| `android/` | Android 客户端，见 `android/ARCHITECTURE.md` | Kotlin、Gradle、JDK 17 |
| `ios/` | iOS / iPadOS 客户端，见 `ios/ARCHITECTURE.md` | Swift、Xcode |
| `dsh-bridge-next/` | **当前** DSH 插件（npm 包，也随 DSH Desktop 分发） | TypeScript、Yarn |
| `contracts/` | 跨端契约与 fixtures，按 `<name>/<version>/` 组织 | JSON Schema / 文档 |
| `docker/` | 自托管部署与本地数据库 compose | Docker Compose |
| `docs/` | 使用、开发、API、Runtime 协议、发布说明 | — |

不在当前主线上开发的目录：

- `desktop-next/`、`dsh-bridge/`：已分别被 `desktop-workbench/`、`dsh-bridge-next/` 取代，除非任务明确要求，否则不要修改。
- `_deprecated/`、`_reference/`，以及各子项目内同名目录：历史代码或参考实现，不参与构建，不要从中导入。
- `docs/` 中名字带 proposal、plan、target、gap 的文档，以及 `docs/migrations/`：描述设计或某个时间点的状态，使用前要和源码、契约核对。

## 开发与验证

完整说明见[开发指南](docs/development.md)，要点如下：

- 仓库根目录**没有**统一的构建命令，每个子项目单独安装依赖、单独检查。
- **不提交 lockfile**（`yarn.lock`、`uv.lock`、`package-lock.json` 等已被 `.gitignore` 忽略），不要把它们加回来。
- 只运行和修改有关的 headless 检查：
  - Server：`cd server && uv run ruff check . --exclude .venv && uv run pytest -q`（需要 `AGENT_SERVER_TEST_DB_URL`；`tests/test_connector_pipeline.py` 会导入 Connector 包，先执行一次 `uv pip install --python .venv/bin/python ../connector`）
  - Connector：`cd connector && uv run ruff check connector tests && uv run pytest -q`
  - Web：`cd web-next && yarn test && yarn typecheck && yarn protocol:check`
  - Desktop：`cd desktop-workbench && yarn test:main && yarn renderer:typecheck`
  - DSH 插件：`cd dsh-bridge-next && corepack yarn check`（集成测试会在进程内拉起 Connector 探针和 Server，同样需要 `AGENT_SERVER_TEST_DB_URL`）
- 本地联调用 `./local-up.sh`（Server + Web，可加 `--with-connector`）或 `./desktop-local-up.sh`。**不要**使用 `--reset-data`，除非用户明确要求，因为它会删除本地数据库。
- Server 测试需要 PostgreSQL：通过 `AGENT_SERVER_TEST_DB_URL` 指向一个名字含 `test` 的一次性数据库（本地用 `docker/docker-compose.local.yml` 的 postgres，建库和环境变量见[开发指南](docs/development.md)）；测试会清空该库的所有表，绝不能指向开发库或生产库，也不要把生产 URL 带进测试进程。
- Headless 检查通过，不等于真实安装、OAuth 回调或远程 Runtime 会话已经验证。汇报时要说明哪些验证没有做。
- CI（`.github/workflows/ci.yml`）按改动路径运行 Connector、Server、Web、Desktop 的 headless 检查和 DSH 插件检查：`connector/` 的改动会连带触发 Server 与插件，`server/` 的改动会连带触发插件，`contracts/` 与工作流文件触发全部。CI 不跑 ruff（仓库里还有历史 lint 问题），也不覆盖 Android / iOS，这些要靠本地检查。

## 跨端修改的规则

- **契约优先**：修改 API 字段、实时事件或 Runtime 协议时，先更新 `contracts/` 或 `docs/api/`，再同步修改 Server、Connector 和所有受影响的客户端。Web / Desktop 的 `protocol:check` 用来发现契约偏差。
- **能力驱动**：各 Runtime 支持的功能不同，客户端应当根据有效能力（见 [capabilities](docs/api/capabilities.md)）显示或隐藏功能，不要按 provider 名称写死判断。
- **Server 分层**：`core` 不能导入外层；`services` 不能导入 FastAPI、API 模块或具体的 `Store`。这些规则由 `server/tests/test_architecture_boundaries.py` 强制检查。
- **数据库**：schema 变化需要新增 Alembic 迁移 `server/migrations/versions/v2_N.py`，编号接着现有最大值递增，不要修改已发布的迁移。
- 多端功能（例如排队消息、计划审阅）通常要同时修改 Web、Desktop、Android、iOS。如果只修改了其中一部分，要在 PR 中写明哪些端还没有跟进。

## 版本号

遵循[版本号规则](docs/versioning.md)：`2.0.x` 是各端独立的小版本更新，`2.x.0` 是接口更新，`x.0.0` 是架构变更。只有 PATCH 允许各端不同；修改跨端接口时不能只升 PATCH，并且升 MINOR 或 MAJOR 时要更新**所有端**的版本号（文件位置见该文档）。

## 更新日志

根目录的 [CHANGELOG.md](CHANGELOG.md) 写给用户和部署者，记录每个版本里他们能感知到的变化。`docs/releases/<版本>.md` 是发布说明，记录接口变化、各端最低配套版本、数据库迁移、已知限制和安装包记录。两份文档分工不同：一个改动可以同时出现在两边，但写法不同，不要互相照抄。

**什么时候更新**

- 改动本身的 PR 里就更新 CHANGELOG.md，不要留到发版时再补。只有用户感知不到的改动可以不写：测试、CI、重构、版本号、只面向开发者的文档，以及被同一版本后续提交撤销的方案。
- 同一个未发布版本里，后面的 PR 修正、扩展或推翻了已有条目时，直接改那一条并补上新的 PR 号，让它描述最终行为，不要另起一条「修复上一条」。被撤销的方案要从 CHANGELOG 里删掉。
- PR 合并前，如果 main 上又合入了别的条目，按 main 的版本解决冲突，保留双方的条目。
- 发版时，把「未发布」标题改成 `## x.y.z（YYYY-MM-DD）`，用 `git log v<上一版本>..main --no-merges` 核对有没有漏掉的用户可见改动，再在最上面新建下一个版本的「未发布」节。

**写在哪里**

- 写进最上面的「未发布」版本节，放到对应分类下：升级须知、会话创建与消息交付、Codex 与 Claude、DSH 同步、Desktop、本机连接、所有权与日志、Web 与 Desktop 界面、Android、iOS、文档。现有分类都不合适时再新增；不要新建只有一条的分类。
- 需要用户或部署者动手的变化写进「升级须知」，并在发布说明里写清楚细节。例如：必须一起升级的端、数据库迁移、删除的接口或配置、提高的最低版本。
- 一个 PR 涉及多个分类时，每个分类各写一句与该分类有关的内容；只影响某一端的改动放进那一端的分类。

**怎么写**

- 每项一句话，用中文写用户看到的结果或修好的现象，不写实现方式。修 bug 写「修复……」或「……不再……」，新功能写用户现在能做什么。
- 主语是功能或用户。不出现函数名、文件路径、内部类型或协议字段；用户能直接用到的命令、设置项、界面文字和环境变量可以写，用反引号括起来，界面文字用「」。
- 同一功能的多个 PR 合成一条。要点实在多时用子列表，PR 链接单独放在子列表后面一行。
- 每项末尾用全角括号附 PR 链接，例如 `（[#452](https://github.com/anywhere-labs/Agents-Anywhere/pull/452)）`，多个 PR 用「、」分隔；没有 PR 的直接提交，用 8 位提交哈希链接代替。
- 示例：
  - 好：「依赖下载失败时，可以在启动弹窗里切换 PyPI 镜像或清空缓存重试。」
  - 不好：「`acquireOwnership` 失败时附加 `OwnershipRecovery`，renderer 渲染 MirrorChoices。」（写的是实现）
  - 不好：「优化 Desktop 启动。」（看不出变化了什么）

## 提交与 PR

- 从最新的 `main` 创建分支，分支名为 `<type>/<domain>/<topic>`：type 与提交信息的类型一致（`feat`、`fix`、`docs`、`chore`、`refactor` 等）；domain 用缩写：`fe`（Web）、`be`（Server）、`con`（Connector）、`dsk`（Desktop）、`apk`（Android）、`ios`、`dsh`、`docs`，同时涉及多个 domain 时用 `+` 连接。例如 `feat/con/codex-ipc-takeover`、`fix/ios/testflight-entry`、`feat/con+be/runtime-phase`。
- 提交信息使用 Conventional Commits，并带上作用域，例如 `fix(dsh): ...`、`feat(android): ...`、`docs(ios): ...`。正文可以用中文或英文。
- 用户能感知到的改动，要在同一个 PR 里更新 [CHANGELOG.md](CHANGELOG.md)，规则见上一节。
- 一个 PR 只做一件事。不要顺手提交与任务无关的本地改动、部署检查点或调试产物（`.local-dev/`、截图、日志）。
- 不要提交凭据、签名证书、`.env` 文件或生产地址中的密钥。签名、公证和发布流程见各子项目的 README。

## 文档

- 面向用户的文档以中文为主；README 有中英两个版本（`README.md` / `README.en.md` / `README.zh-CN.md`），修改其中一个时要同步其他版本。
- 功能或接口变化后，更新对应的 README、`docs/` 页面、发布说明或 CHANGELOG.md，不要让文档描述已经不存在的行为。
