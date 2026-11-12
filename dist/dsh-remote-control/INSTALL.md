# DSH 远程控制插件 2.2.0 独立安装说明

本目录下的 `dsh-bridge-next-2.2.0.tgz` 是 DSH 插件 **Agents Anywhere for DSH** 的独立安装包（npm 包名 `@agents-anywhere/dsh-bridge-next`，版本 **2.2.0**）。它可以在不保留本仓库其他目录的情况下安装使用。

## 这个包是什么

安装后在 DSH 左侧边栏「设置」上方出现「远程控制」入口，用来：

- 用 Agents Anywhere Cloud 或自己的服务实例登录，授权插件；
- 手机扫码连接本机设备，之后从手机、平板或 Web 查看 DSH 会话、继续对话、回复提问和审批；
- 在插件里查看连接状态、管理插件自己启动的本机 Connector（启动 / 停止 / 重启、uv 路径、PyPI 镜像、同步间隔）、查看桥接日志；
- 维护数据：打开数据目录、打开日志目录、重装依赖环境、恢复出厂设置。

Agent 始终运行在安装 DSH 的工作设备上。Agents Anywhere Desktop 与承载插件的 DSH Desktop 是两个不同的应用；Desktop 正在运行时，插件会引导你到该应用继续设置。

## 包文件与校验

| 项 | 值 |
| --- | --- |
| 文件名 | `dsh-bridge-next-2.2.0.tgz` |
| 大小 | 1,132,074 字节（1.1 MB），解包后约 4.1 MB |
| 文件数 | 330 |
| sha1 | `db0ab5a2321ad96cf1c2274176e753a6902a3ee7` |
| sha512（base64） | `tgzkDNRRXFHgrWwLGWGDikdJoLUb1R6DRJK4OwIBN4cVAVPm/b+laCm1YJiTQmPLEsdFSdUxaed6eFMCcSygvQ==` |
| 构建来源 | 本仓库分支 `feat/ios/duo-cover-original-shell`，提交 `5806d96b` |
| 构建方式 | `corepack yarn check` 通过后 `npm pack --ignore-scripts`（不重复触发 `prepack`） |

安装前可以自行核对：

```bash
shasum -a 1 dsh-bridge-next-2.2.0.tgz
openssl dgst -sha512 -binary dsh-bridge-next-2.2.0.tgz | openssl base64 -A; echo
tar -tzf dsh-bridge-next-2.2.0.tgz | grep -E '^package/(package.json|lib/index.js|lib/client.js|locale/zh.json|cordis.patch.yml|NOTICE)$'
```

## 安装前确认

- **Node.js**：`^22.19.0 || >=24`（包内 `engines`）。
- **DSH 版本**：插件的 peer 声明是 `>=0.2.0-rc.1 <0.3.0-0`；开发与自动化测试的基线是 `0.2.2-rc.1`。范围外的版本 DSH 会拒绝安装或跳过加载。
- **Python**：插件启动自己的 Connector 时需要 Python 3.12+。uv 由插件的 npm 依赖 `@dataiku/uv` 提供，Python 环境在首次连接时准备，不需要提前装好。

## 方式一：在 DSH Desktop 的「插件」页面安装

适合使用 DeepSeek 官方 DeepSeek Harness Desktop 的用户（该应用没有内置本插件）。

1. 打开左侧边栏「插件」，点击「添加插件」。
2. 在包名输入框里填入 tarball 的**绝对路径**，例如：

   ```text
   /Users/you/dsh-remote-control/dsh-bridge-next-2.2.0.tgz
   ```

   不同版本的输入框如果只接受 npm 包名，改用下面的命令行方式。
3. 点击「安装」。如果安装停下并提示「允许这些脚本并重试」，列表中应当只有 `@dataiku/uv`；出现其他包名时先不要允许。
4. 安装完成后点击「立即启用」，然后重启 DeepSeek Harness Desktop。
5. 从左侧边栏「设置」上方打开「远程控制」，按提示登录并连接。

安装方会从 npm 源解析插件的 5 个运行时依赖（`@dataiku/uv`、`meshcall`、`qrcode`、`clsx`、`lucide-react`）。内网或离线环境要预先配好镜像源或缓存；「安装源」可以切换到「中国大陆镜像源」。

## 方式二：命令行安装（profile）

适合用命令行安装的 DSH，或需要脚本化部署的场景。

```bash
dsh plugin --profile desktop add /absolute/path/to/dsh-bridge-next-2.2.0.tgz
```

- `dsh plugin` 内部用 pnpm 管理 profile（profile 目录里有 `pnpm-workspace.yaml`），`add` 接受 npm 包名、版本号或本地 tarball 路径。
- `desktop` 是 profile 名，实际使用哪个就换成哪个。
- 安装完成后重启对应的 DSH 实例，再从左侧边栏打开「远程控制」。
- 升级时先卸载再安装：

  ```bash
  dsh plugin --profile desktop remove @agents-anywhere/dsh-bridge-next
  dsh plugin --profile desktop add /absolute/path/to/dsh-bridge-next-2.2.0.tgz
  ```

## 版本兼容

| 项 | 值 |
| --- | --- |
| 插件版本 | 2.2.0 |
| 支持的 DSH 版本 | `>=0.2.0-rc.1 <0.3.0-0`（`@deepseek-ai/dsh-typert-protocol`） |
| 开发 / 测试基线 | `0.2.2-rc.1` |
| cordis | `~4.0.4 \|\| ~4.1.0`（宿主提供） |
| schemastery | `~3.18.4 \|\| ~3.19.0`（宿主提供） |
| react | `^18.3.1`（宿主提供） |

- 2.2.0 相对 2.1.0 的变化只在依赖范围：放宽到 DSH 0.2.2 系列使用的 cordis 4.1 / schemastery 3.19，因此在 DSH 0.2.2 上安装不再提示 Cordis、Schemastery 版本不满足。peer 范围没有变。
- DSH 在安装和启动插件时都会检查版本范围，不满足时拒绝安装或跳过加载。不要为本插件添加版本豁免。
- 插件与 Connector 配套发布：MINOR 版本（例如 2.1.x → 2.2.0）要一起升级，否则本机连接可能一直停在等待状态。插件自带 Connector 源码副本（`lib/bundled-connector/`），不需要另外安装 Connector 包。
- 范围内其他 DSH 版本只做声明，不在自动化检查中验证。

## 数据、日志与凭据位置

- **插件数据**：`~/.agents-anywhere/dsh-bridge-next/`，包含账号与设备绑定、同步缓存、设置，以及插件自己创建的 `connector-venv/`（Python 环境）和 `connector-source/`（Connector 项目副本）。
- **日志**：`~/.agents-anywhere/logs/`，由 Connector 写分段 JSONL 文件，插件「桥接日志」页读取最近 200 条。
- 账号与设备 token 只保存在数据目录里，不进入页面状态或跳转 URL。
- **卸载不会删除这些数据**，重新安装后可以继续使用。想连数据一起清掉，先在插件「设置 → 维护」里执行「恢复出厂设置」，再卸载。

## 卸载与回滚

卸载：

```bash
dsh plugin --profile desktop remove @agents-anywhere/dsh-bridge-next
```

或在 DSH Desktop 的「插件」页面卸载本插件。卸载后插件启动的 Connector 进程会停止；DSH 会话、运行时端点、共享的 `connector-runtime.json` 和已下载的 Python 环境保留。

回滚到旧版本：

1. 卸载当前版本（命令同上）；
2. 用同一 profile 安装旧版 tarball（例如 2.1.x 的包），或直接 `dsh plugin --profile desktop add @agents-anywhere/dsh-bridge-next@2.1.0`；
3. 重启 DSH 实例。

注意回滚要连 Connector 一起回滚：旧插件与新的 Connector / Server 之间可能存在接口差异（2.2.0 的 Server、Web、Connector 与插件配套）。数据目录可以保留，降级后首次连接会重新校准同步检查点。

## 包里有什么、没有什么

**包含**（`tar -tzf` 可见）：

- `package.json`：包元数据、`dsh.bundle.patch`、`dsh.client.inject`、依赖与 peer 声明；
- `cordis.patch.yml`：插件层，DSH 启动时加载；
- `lib/index.js` + `lib/index.d.ts`：Host 端（登录、Connector 管理、桥接、RPC）；
- `lib/client.js` + `lib/client.d.ts`：侧栏「远程控制」面板的前端 bundle；
- `lib/index.js.map`、`lib/client.js.map`：source map；
- `lib/bundled-connector/`：312 个文件，Connector 的 Python 源码副本，安装后不再需要仓库里的 `connector/` 目录；
- `locale/en.json`、`locale/zh.json`：界面文案，跟随 DSH 语言设置；
- `NOTICE`、`LICENSE`、`README.md`、`TECHNICAL.md`、`RUNTIME_READS.md`、`USER_QUESTIONS.md`、`docs/images/*`。

**不包含**：

- `src/`（TypeScript 源码）、`tests/`、`scripts/`（构建脚本）；
- `node_modules/`：5 个运行时依赖由安装方从 registry 解析；
- DSH 宿主自身的 `@deepseek-ai/*` 包：其中 `@deepseek-ai/dsh-commands`、`dsh-llm`、`dsh-session`、`dsh-session-title` 由 DSH 宿主提供，不在包内也不是本包的依赖，所以**不要在没有 DSH 的裸 Node 项目里直接 `import` `lib/index.js`**，会报 `ERR_MODULE_NOT_FOUND`；
- Python 运行时与虚拟环境：`connector-venv/` 在首次连接时创建在数据目录里。

## 常见问题

- **提示版本不兼容（incompatible-version）**：先看当前 DSH 版本，再换匹配的插件版本；不要加版本豁免。
- **安装停在「允许这些脚本并重试」**：列表里应当只有 `@dataiku/uv`；出现别的包名时先不要允许，到 Issues 反馈。
- **「连接服务器超时」**：指请求 Agents Anywhere 服务端超过 20 秒未完成，不代表 Connector 崩溃；检查后端地址和网络后重新启动 Connector。
- **Connector 启动后立即停止**：在插件「运行日志 → 启动前诊断」看错误码与调用栈位置。
- **自建服务报 `oauth client not found`**：正在运行的后端没有加载插件用的内置 OAuth client，升级或重启后端。
- **技能或 `/model` 不在命令菜单里**：命令目录由 DSH 桥接决定，需要 DSH 与插件版本互相匹配；刷新会话后再试。
