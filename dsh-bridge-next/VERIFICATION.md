# DSH Bridge Next 验证记录

日期：2026-09-08。基线：`feat/benson-0905` 的 `5c99b42d`，官方 DSH `0.1.2-rc.1`，macOS、Node 22.23.2、uv 0.12.3、Python 3.12。

## 已执行的自动化检查

| 范围 | 结果 | 附加检查 |
| --- | --- | --- |
| 插件 | 105 项通过 | Host/Client/脚本类型、构建、官方 UI headless 导入与生命周期、Connector 源码打包 |
| Connector | 68 项通过 | DSH、Runtime 归属、控制进程与测试传输取消 |
| Server | 76 项通过 | 图片 MIME、会话锁、设备/Runtime 删除、配置、插件 OAuth、设备存储 |
| Web | 219 项通过 | TypeScript、协议生成一致性 |
| Desktop renderer | 205 项通过 | TypeScript、协议生成一致性 |
| Desktop 主进程 | 90 项通过 | TypeScript 编译后运行 Node 测试，未启动 Electron |

合计 763 项测试。Server 测试有一条 Starlette/httpx TestClient 弃用提示，不影响本次结果。此记录是上述提交的验证快照；后续职责调整需要重新检查，不能沿用本表宣称新代码已经通过。

插件事件与问答探针通过 ASGI 调用原有 Server，在各自的临时目录创建 SQLite 数据库；正常启动 Server 仍要求 PostgreSQL。测试请求一旦进入后端，不随客户端取消而被直接取消，测试关闭时等待后端请求完成。生产数据库和连接池没有因本轮测试修复而修改。

## 复现命令

先在仓库根目录准备 `uv sync --project connector` 和 `uv sync --project server`，并在三个 JavaScript 项目各执行一次 `corepack yarn install`。仓库忽略依赖锁文件，干净环境安装时生成自己的本地锁；CI 明确关闭 immutable install。

在 `dsh-bridge-next/`：

```bash
corepack yarn check
```

在 `connector/`：

```bash
uv run --frozen pytest tests/test_dsh*.py tests/test_runtime_owner.py tests/test_connector_control.py -q
```

在 `server/`：

```bash
uv run --frozen pytest \
  tests/test_attachment_mime_policy.py tests/test_session_refresh_lock.py \
  tests/test_connector_deletion.py tests/test_runtime_deletion.py \
  tests/test_runtime_config.py tests/test_plugin_onboarding.py \
  tests/test_device_data_storage.py tests/test_device_runtime_repository.py -q
```

在 `web-next/`：

```bash
corepack yarn test
corepack yarn typecheck
corepack yarn protocol:check
```

在 `desktop-workbench/`：

```bash
corepack yarn workspace agents-anywhere-desktop-renderer test
corepack yarn renderer:typecheck
corepack yarn workspace agents-anywhere-desktop-renderer protocol:check
corepack yarn test:main
```

[DSH Bridge Next CI](../.github/workflows/dsh-bridge-next.yml) 在 Linux 上运行这些检查，不启动真实 DSH、开发服务器、Docker 或 Electron。GitHub 中的对应 run 才是远程检查结果，不能用本地通过代替。

## 手动验收

启动方法见 [README](./README.md#本地构建与安装)。由开发者手动启动当前源码版本的 Server/Web 和链接安装的 DSH 插件；扫码前确认手机能访问连接中使用的服务器地址。只监听回环地址或二维码仍含 `127.0.0.1` 时，先跳过手机步骤。

- [ ] 插件登录、自建服务授权、设备上线、添加 DSH Agent、Web 完成页可达。
- [ ] AA 选择模型 A / effort，与 DSH 默认模型 B 不同时，首条真实请求使用 AA 的选择。
- [ ] 会话内改模型/effort/权限后回显正确；下一次新建仍恢复 AA 已保存的新会话偏好。
- [ ] 修改 Runtime 默认模式只影响后续新建；原会话和正在执行的 turn 保持原生行为。
- [ ] 文本和纯图片新建/续聊、运行中中断、`ask_user_question` 回答/取消、多端收起可用。
- [ ] 断线与重启恢复后，历史、图片引用、当前选择及待回答问题一致，无重复首条消息。
- [ ] 手机扫码与真实手机会话交互通过；Windows 进程退出/恢复和长期运行另行记录。

普通文件、DSH 原生图片反向上传到 AA、工具权限审批应答，以及检测到 AA Desktop 后的专门交接流程仍未开放。权限预设切换不等于回答工具审批。完整配置验收矩阵见 [配置方案第 11 节](./RUNTIME_CONFIGURATION_PLAN.md#11-验收条件与容易遗漏的逻辑)。
