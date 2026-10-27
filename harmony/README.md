# Agents Anywhere · HarmonyOS 客户端

跨设备 Agent 工作台 Agents Anywhere 的鸿蒙（HarmonyOS / ArkTS）客户端。

- bundle：`com.agentsanywhere.app`
- 兼容 API 12（HarmonyOS 5.0.0）及以上，targetSdkVersion 26.0.0
- 多模块 hvigor 工程，运行时零三方 npm 依赖

## 模块结构

| 模块 | 类型 | 职责 |
| --- | --- | --- |
| `common` | HAR | 设计令牌（颜色/字体/外观）、i18n、通用工具、跨模块共享资源 |
| `network` | HAR | API 客户端、领域 API、DTO、实时 WebSocket 通道 |
| `session` | HSP | 登录/会话态、会话列表与时间线、被多域复用的共享组件 |
| `terminal` | HSP | 终端模拟与终端页 |
| `files` | HSP | 文件浏览与 Agent 文件页 |
| `entry` | HAP | 应用壳：Ability、tab 导航、设备域页面、路由聚合 |

依赖方向严格单向：`common ← network ← session ← terminal/files ← entry`（terminal/files 复用 session 的会话态与共享组件）。禁止反向依赖与循环依赖，详见 [docs/architecture.md](docs/architecture.md)。

## 构建

前置：DevEco Studio（或 HarmonyOS command line tools），已设置 `DEVECO_SDK_HOME`。

```bash
ohpm install
hvigorw assembleHap --mode module -p product=default --no-daemon
```

本地开发也可以用 `devecocli build`（见 [AGENTS.md](AGENTS.md)）。签名材料不提交，本地由 DevEco Studio / `devecocli signature generate` 自动生成。

## 文档

- [docs/HANDOFF.md](docs/HANDOFF.md)：工程交接说明与 ArkTS 硬性约束
- [docs/architecture.md](docs/architecture.md)：模块边界与依赖规则
- [docs/hmo-vs-android-gap-list.md](docs/hmo-vs-android-gap-list.md)：与安卓端的功能差距清单
