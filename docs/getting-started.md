# 安装与首次使用

连接运行 Agent 的工作设备后，你可以在桌面、手机、平板或 Web 查看会话并继续操作。以下步骤介绍如何登录服务、连接设备并开始第一个会话。

## 开始之前

准备一台用于运行 Agent 的工作设备，并配置所用 Agent 的运行环境和账号。当前支持 Codex、Claude Code 和 DeepSeek Harness（DSH）。远程操作时，工作设备需要保持开机、联网。

桌面客户端（Desktop）包含 Connector，用于将本机连接到服务。Linux 和无图形界面的服务器可单独运行 Connector，通过其他客户端操作。Runtime 是运行或连接具体 Agent 的组件，其状态和支持的能力决定哪些操作可用。

本文适用于当前 2.0 产品线。`main` 中的新修复可能尚未包含在 2.0.0 安装包中，发布范围见 [2.0.0 发布说明](releases/2.0.0.md)。

## 1. 选择客户端

从 [README 下载表](../README.md#下载与入口)获取客户端：

- **macOS：** 安装 Universal DMG，适用于 Apple Silicon 和 Intel。
- **Windows：** 安装 x64 桌面客户端。
- **Android：** 安装 APK。
- **iOS / iPadOS：** 通过 [TestFlight](https://testflight.apple.com/join/GKGaut99) 安装测试版，以邀请页的可用状态为准。
- **Web：** 打开 [web.agents-anywhere.com](https://web.agents-anywhere.com)。

在工作设备上使用桌面客户端，或按 [Connector CLI 说明](../connector/README.md#run)接入无图形界面的机器。手机、平板和 Web 用于访问已连接的工作设备。

## 2. 登录服务

### 使用 Cloud

打开 Web，注册或登录，开始使用。Cloud 服务器位于中国大陆，在中国大陆使用可获得最佳体验。

在桌面客户端中，选择“登录 Agents Anywhere Cloud”，按系统浏览器中的引导登录，然后返回应用。

### 连接自托管服务

展开连接自己的服务实例的选项，填入服务地址并登录。首次部署的管理员需要从 Server 日志取得 setup token，在 Web 完成首位管理员设置。后续账号由该实例的注册策略和管理员管理。

使用 Connector CLI 时，`--server-url` 填写服务根地址，例如 `https://aa.example.com`，省略 `/api/v2`。部署步骤见 [Docker 文档](../docker/README.md)。

## 3. 连接工作设备并创建会话

1. 在工作设备上打开桌面客户端，按本机设备引导完成绑定。使用 CLI 时，按配对流程取得凭据并启动 Connector。
2. 等待设备显示在线，选择或配置要使用的 Runtime。
3. 确认 Runtime 可用后，选择项目工作目录，创建或打开会话。
4. 发送任务，在会话时间线中查看 Agent 的回复和运行进度。

看到设备在线、Runtime 可用，并收到会话回复后，即可在其他设备登录同一服务和账号，访问该设备的会话、工作区和终端。不同 Runtime 支持的模型、审批和终端等能力可能不同，以客户端显示为准。

## 保持工作设备在线

远程操作依赖工作设备上的 Connector 和对应 Runtime 持续运行。为同一个系统用户选择一种 Connector 启动方式，避免 Desktop、CLI 和 DSH 启动的实例互相争用。

在 Windows 上，关闭桌面窗口会将应用隐藏到托盘，Connector 继续运行。从托盘退出应用会停止本机 Connector。

通过 SSH 启动 CLI 时，可使用 `screen` 或自行管理的系统服务，在 SSH 断开后保持运行。先完成配对并确认可用，再设置自动启动。

## 常见问题

### “该地址未返回正常的 Agents Anywhere 服务”

客户端未能确认该地址提供可用的服务。先检查填写的服务根地址，再检查服务的健康状态：

```bash
curl -i https://web.agents-anywhere.com/api/v2/health
```

自托管时，将域名替换为自己的服务地址。正常响应应为 HTTP 200，内容类型为 JSON，并包含 `"status": "ok"`。

- 如果返回 HTML，检查地址和反向代理配置，确认 `/api/v2/health` 指向当前 Server。静态首页或错误页也可能返回 HTTP 200。
- 如果无法连接，检查服务是否运行，以及当前网络能否访问该地址。
- 如果健康检查正常但桌面客户端仍无法登录，记录客户端版本、错误提示和复现步骤，再反馈问题。

桌面客户端默认要求 Web 与 API 同源。分离部署的开发配置见 [Desktop 文档](../desktop-workbench/README.md#login-and-server-configuration)。健康检查由 Electron 主进程发起，网页开发者工具的 Network 面板可能看不到该请求。2.0.0 桌面客户端已禁用登录健康检查的 HTTP 缓存。

排查连接问题时保留用户数据目录，其中包含账号绑定和 Connector 数据。

### 设备在线，但某个操作不可用

设备在线表示 Connector 已连接。继续检查所选 Runtime 的状态和错误信息，确认它已配置并可用，再查看当前会话是否支持该操作。需要进一步定位时，查看 Connector 日志。旧版 ACP provider 不在当前默认支持范围内。

### 更新提示无法下载

当前发布客户端的应用内更新地址仍是占位配置。请从 [README 下载表](../README.md#下载与入口)手动获取安装包。上传新安装包不会更新已安装客户端中的下载地址。

### Agent 和数据在哪里？

Agent 在 Connector 所在的工作设备上执行，使用该设备的工作区和终端权限。Server 负责登录验证、指令转发、会话保存和附件处理；消息、代码片段和附件可能经过或存储在服务端。使用自托管服务时，这些服务端数据由你部署的实例处理。

如果问题仍未解决，可通过 [Issues](https://github.com/anywhere-labs/Agents-Anywhere/issues) 反馈。请提供客户端版本、操作系统、Runtime 类型、错误提示和复现步骤，并在提交日志前移除密码、令牌等凭据。
