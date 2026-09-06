# DSH Bridge Next

Agents Anywhere 的 DSH 插件重写项目。职责边界和迁移顺序见 [开发计划](./DEVELOPMENT_PLAN.md)。

完整产品流程见 [Onboarding 业务方案](./ONBOARDING_PLAN.md)：检测 AA Desktop 后分两条路径。已安装时由 Desktop 管理用户、设备和 Connector；未安装时由插件管理本机能力，并把已上线设备交给 Web 引导。两种模式的 DSH Agent 业务均位于插件 `host/dsh-runtime/`。下一阶段先实现无 Desktop 场景。

## 当前内容

- 独立的 Yarn 项目、插件清单和配置层。
- Host / Client 空入口，独立类型检查和构建，输出到 `lib/`。
- `host/dsh-runtime/`、Connector 管理、账号、存储、设置页等业务目录占位。
- 无界面的构建产物检查：包入口、类型声明、Host 导出、Client 加载器和运行时导入约束。

当前没有设置页注册、本机监听端口、握手或任何 Agent、账号、Connector 业务。业务测试目录暂为空，不代表已经完成业务或真实 DSH 加载验证。

## 本地开发

需要 Node.js `^22.19.0 || >=24`。项目使用 `package.json` 固定的 Yarn 版本，通过 Corepack 运行：

```bash
cd dsh-bridge-next
corepack yarn install
corepack yarn check
```

常用命令：

| 命令 | 作用 |
|---|---|
| `corepack yarn typecheck` | 分别检查 Host、Client 和构建脚本 |
| `corepack yarn build` | 清理并构建两端 JavaScript、声明和 sourcemap |
| `corepack yarn dev` | 监听源码并自动构建两端 |
| `corepack yarn check:build` | 检查已有构建产物，可在无界面环境执行 |
| `corepack yarn check` | 类型检查、构建和产物检查 |

`dev` 只更新构建产物，不启动 DSH、AA Server 或 Connector。后续接入 DSH 时采用本地链接安装；前端更新后刷新页面，Host 更新后重启目标 DSH 实例。

## 目录职责

```text
src/contracts/          插件内部前后端共享约定
src/host/index.ts       Host 插件入口
src/host/dsh-runtime/   DSH Agent 业务及对 Connector 的协议入口
src/host/connector/     Python Connector 的进程与环境管理
src/host/account/       登录、绑定与授权
src/host/rpc/           设置页管理接口
src/host/storage/       通用本地存储
src/client/            设置页、Host 调用和界面缓存
scripts/               构建辅助与产物检查
tests/                 后续业务测试和回归样本
```

跨进程桥接协议继续以仓库的 `contracts/dsh-bridge/` 为基线。Python DSH 适配器向薄转发迁移的工作尚未开始。

## 版本与产物

入口形式参考本机 DSH Desktop 2.0.5 内置的 Harness `0.1.2-rc.1`。骨架仅依赖基础 Cordis 类型；具体 DSH 服务依赖在实现对应能力时按目标版本添加。

Host 导出 `lib/index.js`，Client 导出 `lib/client.js`，对应声明分别为 `lib/index.d.ts` 和 `lib/client.d.ts`。Client 使用 DSH 模块加载格式，不能作为独立网页打开。

依赖、构建产物和打包文件不纳入提交。锁文件遵循仓库现有忽略规则，在本地安装时生成。
