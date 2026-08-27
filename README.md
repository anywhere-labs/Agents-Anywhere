# Agents Anywhere ↔ DeepSeek Harness Gateway (`dsh-aa-gateway`)

`@agents-anywhere/dsh-aa-gateway` 把原来的 `dsh-aa-bridge`（DSH 进程内
JSON-RPC 桥接插件）整体迁入新插件，并预留 Connector CLI 子进程管理、设置
页面 UI 容器、以及 desktop-next 控制台迁移的扩展点。

## 当前里程碑（Step 1：仅 Bridge + 空白设置页）

- ✅ 完整继承 `dsh-aa-bridge` 的 host 能力（Loopback JSON-RPC、Session、
  Timeline、Interactions、Approvals、User Questions、Workspace 回填等）。
- ✅ 在 DSH 设置中心注册 **Agents Anywhere** 入口，点击后打开空白页
  （后续逐步接入状态、配对、日志、环境四张卡片）。
- ⏳ Connector CLI 子进程管理、`uv`/Python 自动解析、Pypi 镜像源与
  desktop-next UI 移植尚未实现。

## 插件包结构

```text
dsh-aa-gateway/
├── package.json              # @agents-anywhere/dsh-aa-gateway
├── tsconfig*.json
├── tsdown.config.ts          # 浏览器 bundle
├── cordis.patch.yml          # 注册 AgentsAnywhereConnectorService
└── src/
    ├── index.ts              # Host 入口（导出 Service）
    ├── bridge-service.ts     # 服务聚合（dispatch / loopback / 通知）
    ├── bridge/               # 原 dsh-aa-bridge 子模块
    │   ├── wire/             # JSON-RPC 协议、错误、传输、Loopback 服务端
    │   ├── runtime/          # Session / Catalog / Interaction 管理
    │   ├── projection/       # Timeline / 身份 / 水位线
    │   ├── persistence/      # 原子 JSON 元数据持久化
    │   └── control/          # Host/Client 关联帧
    ├── client/               # DSH Web 前端
    │   ├── index.tsx         # 注册 settings.section
    │   ├── components/       # 设置页组件（Step 1 暂为占位）
    │   └── locales.ts        # zh / en 词条
    └── common/
        └── types.ts          # 跨端共享类型（端点描述等）
```

## 后续步骤

- **Step 2**：将 `desktop-next` 的 Overview / Pairing / Logs / Environment 四
  张卡片迁入 `ConnectorSettingsSection`，并实现 Host-Client RPC（state、
  pairing、logs 推送）。
- **Step 3**：实现 Connector 子进程管理（`@agents-anywhere/uv` 多平台解析、
  `uv run connector rpc` Stdio JSON-RPC、崩溃退避重启）。
- **Step 4**：接入 AA Server 配对流、二维码认领、Token 持久化与 PyPI 镜像
  源切换。

## 本地构建

```bash
corepack enable
pnpm install
pnpm verify
```

## 本地安装

```bash
dsh plugin --profile web add /absolute/path/to/dsh-aa-gateway
dsh web
```

DSH Desktop 与 Web 复用同一个 profile；不要同时在两个共享 `DSH_HOME` 的
DSH Web/Desktop 进程中启动 Bridge。
