# Agents Anywhere

**用手机，遥控任何设备上的编码 Agent。**

Agents Anywhere 是一款面向 Claude Code、Codex 等 AI 编码助手的移动端和 Web 端遥控器——无论你的 Agent 跑在笔记本、云端沙箱，还是远程服务器上。一个控制台，管全部。

[English](README.md) · **简体中文**

---

> **当前状态：开源开发中。** 
> 这是一个完全开源的架构，项目已包含 **Client** (React 网页端控制台)、**Relay Server** (FastAPI 中继后端) 和 **Connector** (连接器守护 CLI) 的完整源码。支持本地极速启动与 Docker 容器化部署。

## Agents Anywhere 是什么？

你在终端打开了 Claude Code，开了个新任务，然后合上笔记本去吃饭了——回来发现刚才那条线索断了。

Agents Anywhere 就是来解决这个问题的遥控器。你的 Agent 该跑在哪台机器还跑在哪台——你的 MacBook、云端沙箱、远程开发机——我们在你的每一块屏幕上给它一个真正能用的客户端。在手机上看 diff 然后批准。在地铁上看实时的工具调用流。在厨房的 iPad 上从浏览器里弹出一个终端。

**Agents Anywhere 是遥控器，不是运行环境。** 你的代码永远不会跑在我们的服务器上。你照常付钱给你自己的模型厂商（Anthropic、OpenAI 等）。我们只负责把你的指令送过去。

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

- **Client（客户端）** — 你看 Session、批准操作的地方。iOS、Android（原生端测试中）、Web、macOS、Windows（网页版支持跨平台）。
- **Relay（中继后端）** — 在客户端和 Daemon 之间转发消息的轻量服务，基于 FastAPI + SQLAlchemy 驱动。支持自托管。
- **Daemon（连接器守护进程）** — 跟你的 Agent 一起跑在同一台机器上的 Python 进程。它能够通过 PTY 模拟终端并利用虚拟屏幕抓取解析工具调用和授权，把你的指令送回 Agent。

## 支持的 Agent

Agents Anywhere 不取代你的 Agent，而是跟着你已经在用的那个一起跑：

| Agent       | 厂商        | 状态 |
| ----------- | --------- | ---- |
| Claude Code | Anthropic | 已深度支持 |
| Codex       | OpenAI    | 已深度支持 |
| Cursor      | Anysphere | 规划中 |
| OpenCode    | SST       | 规划中 |
| Gemini CLI  | Google    | 规划中 |

Agent Runtime 框架是开源的，想要自己写一个适配器接入其它 AI 运行时也十分简单。

## 功能特性

- **统一控制台。** 所有 Session、所有 Agent、所有设备——置顶、搜索、识别分支——同一个侧边栏看完。
- **只在该响的时候响。** 推送只在 Agent 卡在权限、报错、或者跑完了的时候才发。不打扰。
- **随时随地批准。** 在手机/网页上实时拦截并查看 diff，点确认，或者回一句话纠正方向。
- **实时工具调用流。** 屏幕虚拟化抓取技术，让每一次 `READ`、`EDIT`、`BASH` 动作实时同步呈现在 UI 上。
- **侧栏里的终端。** 在 Agent 所在的机器上弹一个真终端。不用切窗口就能跑命令。
- **文件树触手可及。** 浏览 Agent 的工作目录，打开文件，翻 diff。
- **不用 SSH 的远程。** 在任何一台机器上跑一次 CLI 就能连上。不需要密钥，不需要折腾端口转发。

## 快速开始

### 1. 运行本地开发服务器 (Relay Server + Web Client)

**使用 Docker 极速启动（推荐）**
```bash
docker build -f docker/Dockerfile.dev -t agents-anywhere:dev . \
  && docker run --rm -it \
    --name agents-anywhere-dev \
    -p 5173:5173 \
    -v agents-anywhere-dev-data:/data \
    agents-anywhere:dev
```
启动后在浏览器打开 `http://127.0.0.1:5173`。

**或者使用本地原生环境启动**
在 `server` 目录下启动 FastAPI 后端（需要安装 [uv](https://github.com/astral-sh/uv)）：
```bash
cd server
uv sync
AGENT_SERVER_DB=agent-server.sqlite3 uv run uvicorn agent_server.app:create_app --factory --host 127.0.0.1 --port 8000
```
在另一个终端启动 `web` 前端：
```bash
cd web
yarn install
yarn dev
```

### 2. 在你要遥控的机器上配对并启动 Connector 

**方式 A：从 Daemon 端发起配对（推荐）**
在需要遥控的机器上直接进入 `connector` 目录，通过 CLI 快速配对：
```bash
cd connector
uv sync
uv run agent-connector login --server-url http://127.0.0.1:8000
```
终端会输出一个 **Pairing code** 配对码。打开你的网页端控制台，进入「添加设备/Pair Device」，输入配对码。配对成功后 Connector 将自动运行。

**方式 B：从 Web 控制台发起配对**
1. 在网页控制台点击 *Add Device*，它会基于当前地址为你生成一句完整的绑定指令。
2. 复制该指令并在你的开发机上执行（例如）：
   ```bash
   uv run agent-connector configure --server-url http://127.0.0.1:8000 --connector-id conn_xxx --connector-token cxt_xxx
   ```
3. 执行如下命令开启守护进程：
   ```bash
   uv run agent-connector start
   ```

就这么简单。你只要打开 Web 页面或者手机客户端，你本地的开发机和 Agent 已经在侧边栏中整装待发了。

## 常见问题

**我的代码到底跑在哪？**
跑在你指定的那台机器上——你的笔记本、云端沙箱、远程服务器都行。Agents Anywhere 是遥控器，不是运行环境。我们绝不会在我们的中继服务器上跑你的代码。

**需要在我的开发机上装东西吗？**
需要——一个由 Python 编写、非常轻量的 Connector CLI 守护进程，跟着你的 Agent 装在同一台机器上。

**收费吗？**
后端服务、网页端和 CLI 均为 MIT 开源协议，完全免费。模型厂商那边的 API 费用依旧由你自己付——我们只提供触达和遥控，不提供大脑。

**能自己部署中继服务器吗？**
能。`server` 后端和 Docker 配置均已开源，且支持使用 PostgreSQL 驱动的生产环境部署（参见 [docker-compose.postgres.yml](docker/docker-compose.postgres.yml)）。

## 开源许可

[MIT](LICENSE)
