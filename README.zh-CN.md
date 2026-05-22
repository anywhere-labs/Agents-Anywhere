# Agents Anywhere

**用手机，遥控任何设备上的编码 Agent。**

Agents Anywhere 是一款面向 Claude Code、Codex、Cursor、OpenCode、Gemini CLI 的移动端和 Web 端遥控器——无论你的 Agent 跑在笔记本、云端沙箱，还是远程服务器上。一个控制台，管全部。

[申请内测](https://www.agents-anywhere.com) · [文档（敬请期待）](#)

[English](README.md) · **简体中文**

---

> **当前状态：内测中。** 这个仓库目前只放 README 和路线图，等我们把客户端和 CLI 打磨好之后，源码会陆续推到这里。想试用的话，去[候补名单](https://www.agents-anywhere.com)留个邮箱。

## Agents Anywhere 是什么？

你在终端打开了 Claude Code，开了个新任务，然后合上笔记本去吃饭了——回来发现刚才那条线索断了。

Agents Anywhere 就是来解决这个问题的遥控器。你的 Agent 该跑在哪台机器还跑在哪台——你的 MacBook、云端沙箱、us-west-1 的开发机——我们在你的每一块屏幕上给它一个真正能用的客户端。在手机上看 diff 然后批准。在地铁上看实时的工具调用流。在厨房的 iPad 上从浏览器里弹出一个终端。

**Agents Anywhere 是遥控器，不是运行环境。** 你的代码永远不会跑在我们的服务器上。你照常付钱给你自己的模型厂商（Anthropic、OpenAI、Google）。我们只负责把你的指令送过去。

## 为什么做这个

Agent 大爆发之后，每个开发者都被迫变成了一个盯着长跑进程的人。编码 Agent 是真的会跑很久的——几分钟，有时候几小时。而且它经常会在权限确认这一步卡住，等你这个真人去点个允许它才能往下走。

今天的现实是：

- 要么你一直坐在电脑前，
- 要么这个 Session 就废了。

这买卖太亏。Agents Anywhere 来解决它。

## 架构

由三个部分组成：

```
┌──────────────┐         ┌──────────────┐         ┌────────────────────┐
│   Client     │ ──────▶ │    Relay     │ ──────▶ │     Daemon         │
│  iOS · Web   │         │   （中继）   │         │  + 你的 Agent      │
│  macOS · …   │ ◀────── │              │ ◀────── │    跑在你自己的    │
└──────────────┘         └──────────────┘         │     机器上         │
                                                  └────────────────────┘
```

- **Client（客户端）** — 你看 Session、批准操作的地方。iOS、Android、macOS、Windows、Web。
- **Relay（中继）** — 在客户端和 Daemon 之间转发消息的轻量服务。支持自托管。
- **Daemon（守护进程）** — 跟你的 Agent 一起跑在同一台机器上。读取 Agent 在做什么，也把你的指令送回去。

## 支持的 Agent

Agents Anywhere 不取代你的 Agent，而是跟着你已经在用的那个一起跑：


| Agent       | 厂商        |
| ----------- | --------- |
| Claude Code | Anthropic |
| Codex       | OpenAI    |
| Cursor      | Anysphere |
| OpenCode    | SST       |
| Gemini CLI  | Google    |


Agent Runtime 是开源的，自己写一个适配器接入也很直接。

## 功能特性

- **统一控制台。** 所有 Session、所有 Agent、所有设备——置顶、搜索、识别分支——同一个侧边栏看完。
- **只在该响的时候响。** 推送只在 Agent 卡在权限、报错、或者跑完了的时候才发。不打扰。
- **随时随地批准。** 在手机上看 diff，点确认。或者回一句话纠正方向。我们会一直等你回话再继续。
- **实时工具调用流。** 每一次 `READ`、`EDIT`、`BASH`、`GREP` 都会实时出现在对话里。
- **侧栏里的终端。** 在 Agent 所在的机器上弹一个真终端。不用切窗口就能跑命令。
- **文件树触手可及。** 浏览 Agent 的工作目录，打开文件，翻 diff。
- **认得分支的 Session。** Session 会记住自己是在哪个分支启动的。下次回来还能接着那个分支干。
- **跨设备搜索。** ⌘K 搜任何 Session——按标题、按文件、按分支、按设备都行。
- **置顶与归档。** 重要的钉在顶上，其它的一键归档。
- **不用 SSH 的远程。** 在任何一台机器上跑一次 CLI 就能连上。不需要密钥，不需要折腾端口转发。

## 支持的设备


| 平台      | 状态            |
| ------- | ------------- |
| iOS     | 原生，TestFlight |
| Android | 原生，内部测试       |
| macOS   | 原生            |
| Windows | 原生            |
| Web     | 任意现代浏览器       |


一个账号，全平台通用。

## 快速开始

```bash
# 1. 安装
npm install agents-anywhere

# 2. 把这台机器和你的账号配对
aw pair

# 3. 添加一个 Agent
aw agent add claude
```

就这些。打开手机上的 Agents Anywhere App，这个 Agent 已经在侧边栏里了。

### 两种配对方式

- **从 web 端发起。** 打开 Agents Anywhere web 端并登录，点*添加设备*，复制生成的命令并在要绑定的 device 上执行：`aw pair tenh-ak35-44qj`（示例配对码）。
- **从 Daemon 端发起。** 直接在 Daemon 上执行不带参数的 `aw pair`，终端会显示一个二维码，用手机 App 扫码即可绑定。

## 常见问题

**什么时候能进？**
我们正在私有内测，每周大概放 200 名开发者进来。到[候补名单](https://www.agents-anywhere.com)留个邮箱，名额轮到你的时候我们发邀请。

**我的代码到底跑在哪？**
跑在你指定的那台机器上——你的笔记本、云端沙箱、远程服务器都行。Agents Anywhere 是遥控器，不是运行环境。我们不会在我们的服务器上跑你的代码。

**需要在我的开发机上装东西吗？**
需要——一个很小的 CLI，跟着你的 Agent 装在同一台机器上。一条命令装好，每加一台新机器再用一条命令配对。

**收费吗？**
客户端和 CLI 都是 MIT 协议，完全免费。模型厂商那边的费用你自己付——我们是遥控器，不是大脑。

**支持哪些 Agent？**
上线时支持：Claude Code、Codex、Cursor、OpenCode、Gemini CLI。后面会以官方适配器的形式陆续加入新的 Agent，Agent Runtime 是开源的，你也可以自己写。

**能自己部署中继服务器吗？**
能。中继也是我们要开源的一部分。如果你不想让流量走我们的中继，到时候可以自部署。

## 路线图

- iOS 客户端（TestFlight）
- Web 客户端
- Claude Code、Codex、Cursor、OpenCode、Gemini CLI 适配器
- 实时工具调用流 + 推送通知
- 公开测试
- macOS / Windows 原生桌面客户端
- Android 稳定版
- 自托管中继
- 适配器 SDK + 第三方 Agent 接入文档
- 插件市场

## 参与共建

客户端、CLI、适配器 Runtime 的源码会随着内测开放陆续推到这里。在那之前，最有用的几件事是：

1. 去[候补名单](https://www.agents-anywhere.com)留下邮箱，等邀请试用内测。
2. 在这里提 Issue——即使源码还没开放，我们每条都看，会用来决定优先级。

`CONTRIBUTING.md` 会跟源码一起放出来。

## 开源许可

MIT。源码开放后请见 [LICENSE](LICENSE)。

---

**[加入候补 →](https://www.agents-anywhere.com)** · 一款给 AI 编码 Agent 用的遥控器。开源。每块屏幕都有原生客户端。