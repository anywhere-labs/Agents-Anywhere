# 安装与首次使用

## 选择入口

从[根 README 下载表](../README.md#下载与入口)下载 2.0.0。macOS 使用同一个 Universal DMG；Windows 使用 x64 安装程序；Android 安装 APK。iOS 的源码在仓库中，本指南不提供尚未确认的商店链接。

Desktop 是完整工作台，包含受管理的本机 Connector。Linux 和其他 headless 主机可只运行 Connector，通过 Web 或手机操作。

## 登录

- **Cloud：** 选择“登录 Agents Anywhere Cloud”，按系统浏览器引导登录，然后返回应用。Cloud 账号开通方式见 README 社区说明。
- **自托管：** 展开连接自己的服务实例，填入服务地址。Connector 的 `--server-url` 使用 origin，例如 `https://aa.example.com`，不要加 `/api/v2`；客户端会按自己的地址配置规则处理 namespace。
- **首次部署：** 从 Server 日志复制 setup token，在 Web 完成首位管理员设置。后续账号按实例的注册和管理员策略开通。

Desktop 默认要求 Web 与 API 同源，健康检查为 `GET /api/v2/health`，响应必须是包含 `status: "ok"` 的 JSON。分离 API/Web 的开发配置见 [Desktop 文档](../desktop-workbench/README.md#login-and-server-configuration)。

## 连接工作设备

1. 在 Agent 所在机器配置其运行环境和账号。当前默认 providers 是 Codex、Claude 和 DSH，功能以实际发现的能力为准。
2. Desktop 中按本机设备引导完成绑定；headless 主机从 v2 源码运行 [Connector CLI](../connector/README.md#run)，使用配对流程提供的凭据。
3. 等待设备在线，选择或配置 Runtime，再选择项目工作目录、创建会话。
4. 在其他设备登录同一服务和账号，即可访问该设备的会话、工作区和终端。

同一个 OS 用户的 Connector 有启动所有权约束。不要同时从 Desktop、CLI 和 DSH 启动多个互相争用的实例。Windows 关闭 Desktop 窗口会隐藏到托盘；要停止本机 Connector，应从托盘选择退出。

Connector 必须保持运行。SSH 断开时需要持续在线的 CLI 可以放进 `screen` 或自己管理的服务中；首次配置成功后，再设置自动启动。

## 常见问题

### “该地址未返回正常的 Agents Anywhere 服务”

先确认地址对应 v2 Server，而不是静态首页、反向代理错误页或旧版服务。HTTP 200 也可能返回 HTML；它不等于健康检查通过。Desktop 的健康检查由 Electron Main 执行，renderer DevTools 的 Network 不一定能看到该请求，界面显示错误也不一定产生 Console 日志。

可以在终端做一次轻量检查：

```bash
curl -i https://web.agents-anywhere.com/api/v2/health
```

自托管时替换 origin，检查状态码、Content-Type 和 JSON 内容。2.0.0 Desktop 已为登录健康检查禁用 HTTP 缓存，避免旧 HTML 响应污染校验。不要通过删除整个用户数据目录来排查网络问题，因为其中还包含账号绑定和 Connector 数据。

### 设备在线，但某个操作不可用

确认选中的 Runtime 已配置并可用，以及该会话的有效能力允许该操作。旧版 ACP provider 不在当前默认集合中。检查 Connector 的 Runtime 错误与日志，而不只看设备在线状态。

### 更新提示无法下载

已发布客户端中的固定更新地址仍是占位配置。当前分发方式是 README 中的 ModelScope 手动下载链接。上传新安装包本身不会改变已安装客户端的配置。

### Agent 和数据在哪里？

Agent 在 Connector 所在机器执行，本地工作区和终端权限也来自该机器。Server 负责身份验证、指令转发、会话持久化及附件等数据处理；本地执行不等于消息、代码片段和附件都不会经过服务端。
