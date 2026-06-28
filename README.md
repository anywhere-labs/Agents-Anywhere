<div align="center">

<img src="logo/ios-dark%20Exports/ios-dark-iOS-Dark-1024@1x.png" alt="Agents Anywhere logo" width="104" height="104">

# Agents Anywhere

<h3>Remote control plane for Claude Code, Codex, and more coding agents.</h3>

Run agents on your own laptop, remote devbox, or cloud sandbox. Control sessions, approvals, files, terminals, and runtime state from one self-hostable web workspace.

![Python](https://img.shields.io/badge/Python-3.12+-3776AB)
![FastAPI](https://img.shields.io/badge/FastAPI-0.136+-009688)
![Connector](https://img.shields.io/badge/anywhere--cli-0.1.3-111111)
![Next.js](https://img.shields.io/badge/Next.js-16.2-000000)
![Node](https://img.shields.io/badge/Node.js-22-5FA04E)
![Yarn](https://img.shields.io/badge/Yarn-4.6-2C8EBB)
![Docker](https://img.shields.io/badge/Docker-ready-2496ED)

[Docker Quickstart](#quickstart-run-the-full-app-with-docker) · [Onboarding](#onboarding) · [Android APK](https://github.com/anywhere-labs/Agents-Anywhere/releases/tag/v0.1.0) · [Connector App](https://github.com/anywhere-labs/Agents-Anywhere/releases) · [Docker Docs](docker/README.md) · [简体中文](README.zh-CN.md)

![Agents Anywhere session workspace](docs/screenshots/hero.png)

> Screenshots are taken from a fast-moving product surface. UI details may change quickly; use the running app as the source of truth.

Watch long-running sessions, approve actions, inspect files, and open a terminal without moving the agent out of its original machine. To run the current open-source stack, start with [Docker Quickstart](#quickstart-run-the-full-app-with-docker).

</div>

---

> [!IMPORTANT]
> 中国区 Beta 已上线，目前免费试用，仅对中国用户开放。想申请试用，请跳转到 [Beta Access And Contact](#beta-access-and-contact)，扫码进群并联系管理员。

> **Status: open-source development.**
> This repository contains the full Web frontend, FastAPI backend, Python Connector CLI, Windows/macOS Connector app, and Android native client. It can run locally or be self-hosted with Docker. The primary clients today are the Web console and the Android app; iOS is still in development.

## What Is Agents Anywhere?

You start a Claude Code or Codex task in a terminal. It runs for a while: reading files, editing code, running tests, waiting for you to approve an operation. When the agent blocks on an approval, an error, or a quick correction from you, you have to get back to that machine.

Agents Anywhere adds a remote control plane:

- The agent still runs on your machine, with your local account, local files, and local permissions.
- The Connector runs next to the agent and syncs runtime state, safe filesystem operations, shell/terminal capabilities, and approval requests to the backend.
- The Web console and Android app connect to the backend so you can chat with sessions, take over work, approve actions, browse files, and open terminals.

**It is the remote, not a new agent host.** Your code is not moved into the relay service for execution, and your model accounts and model bills remain with your own Claude Code / Codex toolchain.

## Why It Exists

Coding agents are no longer just one-off chat windows. They can run for minutes or longer, change files across a workspace, call tools, and pause at the exact moment a human decision is needed.

Without a remote control plane:

- You have to stay at the machine running the agent.
- If you walk away, the task can block on an approval or error.
- Multiple machines, sessions, and runtimes become hard to manage together.

Agents Anywhere turns those long-running tasks into a workspace you can reopen at any time: check state, inspect files, watch output, approve, interrupt, continue, and switch devices from the Web console or Android app.

## Product Preview

**Desktop: unified control plane**

![Unified control plane](docs/screenshots/control-plane.png)

> This screenshot reflects the product direction at the time it was captured. Agents Anywhere is iterating quickly, so the actual UI may differ.

Devices and sessions are collected in one workspace, so you can switch across machines, runtimes, and tasks.

**Mobile: sessions and devices**

![Mobile sessions and devices](docs/screenshots/mobile.png)

> This screenshot reflects the product direction at the time it was captured. Agents Anywhere is iterating quickly, so the actual UI may differ.

The Android native client is a full first-class client for mobile access to sessions, devices, approvals, files, terminals, and runtime state. iOS is still in development. You can also use the Web console from a mobile browser when you prefer a browser-based mobile workflow.

## Current Capabilities

- **Unified session workspace.** Create, inspect, pin, archive, mark read, take over, and manage sessions.
- **Codex-first runtime integration.** The Connector discovers local Codex and Claude runtimes and reports capabilities. Codex is the best-supported adapter today; Claude has basic support and is still being expanded.
- **Approvals and sync.** Supports interrupt, sync, approval resolution, and timeline polling/SSE.
- **Local file access.** Browse workspaces, read/write files, upload content, and download content through an online Connector.
- **Remote shell and terminal.** Run one-shot shell commands, shell tasks, and interactive terminals.
- **Device pairing.** Pair the machine that owns your workspace through the Windows/macOS Connector app or the Linux Connector CLI.
- **Self-hosted backend.** The FastAPI backend supports SQLite for local development and PostgreSQL for production-style deployments.
- **Web and Android clients.** Use the Web console or Android app to manage sessions, devices, approvals, files, terminals, and remote control workflows.

## Supported Agents And Runtimes

Agents Anywhere does not replace your agent. It runs next to an existing runtime through the Connector:

![Codex](https://img.shields.io/badge/Codex-best%20supported-111111)
![Claude](https://img.shields.io/badge/Claude-basic%20support-666666)
![More agents](https://img.shields.io/badge/more%20agents-coming%20soon-lightgrey)

| Runtime | Vendor | Current status | Notes |
| --- | --- | --- | --- |
| Codex | OpenAI | Best supported today | Most core capabilities are supported, including runtime discovery, session sync, timeline updates, approvals, interrupt/takeover, filesystem access, shell tasks, interactive terminals, and runtime settings. Some vendor-specific or advanced auxiliary features are still being polished. |
| Claude Code | Anthropic | Basic support | The current code supports discovery and the basic session/control flow. Deeper parity with Codex, richer history/timeline handling, and advanced runtime behavior are still being improved. |
| Cursor | Anysphere | Coming soon | Not yet available as a usable adapter. |
| OpenCode | SST | Coming soon | Not yet available as a usable adapter. |
| Gemini CLI | Google | Coming soon | Not yet available as a usable adapter. |

Connector adapters are extensible. New runtimes should reuse the existing session, timeline, approval, filesystem, and terminal capabilities where possible.

## Supported Client And Connector Platforms

![Web](https://img.shields.io/badge/Web-primary%20client-111111)
![iOS](https://img.shields.io/badge/iOS-in%20development-lightgrey)
![Android](https://img.shields.io/badge/Android-available-3DDC84)
![Desktop Connector](https://img.shields.io/badge/Desktop%20Connector-available-111111)

| Platform / surface | Current status | Notes |
| --- | --- | --- |
| Web console | Primary supported client | Full browser-based control plane for sessions, devices, approvals, files, terminals, runtime settings, team/admin management, and session detail. |
| Android | Primary supported client | Download the APK from [GitHub Release v0.1.0](https://github.com/anywhere-labs/Agents-Anywhere/releases/tag/v0.1.0). The Android app is a full native client for sessions, devices, approvals, files, terminals, and mobile control workflows. |
| iOS | Native client in development | The native client is being built for mobile session/device workflows. |
| Windows / macOS Connector app | Available | Download the Connector app from [GitHub Releases](https://github.com/anywhere-labs/Agents-Anywhere/releases). It runs the local Connector as a background desktop process, with pairing, logs, tray behavior, and startup controls. |
| Linux Connector CLI | Available | Use the Python CLI from `connector/` or `uvx anywhere-cli`. This is the recommended Connector path on Linux servers, devboxes, and headless machines. |

This repository currently includes the Web frontends, FastAPI backend, Connector CLI, Windows/macOS Connector app, the Android native client, and iOS work in progress. Web and Android are the main supported client surfaces today; the Connector app/CLI is what links your own machines into the control plane.

Want to run it now? Jump to [Docker Quickstart](#quickstart-run-the-full-app-with-docker). After the server is running, continue to [Onboarding](#onboarding).

## FAQ

**Where does my code actually run?**
On the machine running the Connector. The backend handles auth, state, file metadata, and RPC routing; it does not execute your code on the server.

**What do I install on my dev machine?**
Install the Connector on the machine that owns your workspace and local agent runtime. On Windows and macOS, use the Agents Anywhere Connector desktop app. On Linux, use the Python CLI in `connector/` or `uvx anywhere-cli`.

**Do my model accounts go through Agents Anywhere?**
No. The Connector uses the Codex / Claude runtime and login state already present on your machine. Agents Anywhere does not proxy model account credentials.

**Codex and Claude already provide official remote control. Why use Agents Anywhere?**
Official remote control is usually tied to each vendor's subscription account and product surface. Agents Anywhere does not need to bind to your model subscription account; it only needs the Connector to reach a runtime that is already logged in locally. The goal is one unified entry point for multiple agents: Codex, Claude, and more agents over time. More adapters are in development, and Connector adapter contributions are welcome.

**Can I self-host it?**
Yes. The Docker quickstart runs the Web console, FastAPI backend, and PostgreSQL together. For deployment variants and environment variables, see [docker/README.md](docker/README.md).

**Which agents are supported today?**
The current code focuses on Codex and Claude. Codex is the most complete adapter today. Claude supports the basic flow and is still being expanded. Other runtimes are coming soon and can be added by implementing Connector adapters.

## Technical Guide

The sections above describe the product: Agents Anywhere solves the problem of agents running elsewhere while humans still need to take over. The sections below cover the architecture, Docker quickstart, onboarding, and Connector platform choices. For detailed Docker deployment options, local development images, environment variables, and verification commands, see [docker/README.md](docker/README.md).

## Architecture

```mermaid
flowchart LR
    Web["Web Console<br/>browser client"]
    Server["FastAPI Server<br/>auth / sessions / RPC broker / files"]
    Connector["Connector<br/>desktop app or CLI"]
    Runtime["Local Agent Runtime<br/>Codex / Claude today<br/>more coming soon"]
    Workspace["Local Workspace<br/>files / shell / terminal"]

    Web <-->|HTTP / WebSocket| Server
    Server <-->|Connector WebSocket| Connector
    Connector <-->|runtime adapter| Runtime
    Connector <-->|local permissions| Workspace

    classDef primary fill:#111,stroke:#555,color:#fff;
    classDef local fill:#f5f5f5,stroke:#aaa,color:#111;
    class Web,Server primary;
    class Connector,Runtime,Workspace local;
```

Repository layout:

```text
server/      FastAPI backend, SQLite/PostgreSQL storage, Connector RPC broker
connector/   Local daemon and CLI for Codex / Claude runtime integration
desktop/     Windows/macOS Electron app for running the local Connector
web-next/    Next.js + shadcn Web console
web/         Legacy React + Vite frontend kept as a fallback/reference
docker/      Development, production, and PostgreSQL compose deployment files
docs/        Shared reference notes
```

Package-specific docs:

- [Server](server/README.md)
- [Connector](connector/README.md)
- [Desktop Connector](desktop/README.md)
- [Web Next](web-next/)
- [Docker](docker/README.md)

## Quickstart: Run The Full App With Docker

Run the PostgreSQL-backed stack from the repository root:

```bash
POSTGRES_PASSWORD=change-me \
AGENT_SERVER_SECRET=change-me-too \
docker compose -f docker/docker-compose.postgres.yml up --build
```

Open:

```text
http://127.0.0.1:5174
```

This starts three services:

- `postgres`: PostgreSQL 17 with a persistent Docker volume.
- `server`: FastAPI backend on the internal compose network at `http://server:8000`.
- `web`: Next.js `web-next` console published on host port `5174`; it rewrites API and WebSocket traffic to the backend.

The first startup on an empty database logs a bootstrap token. Use it in the Web UI to create the first admin user.

For custom ports, production secrets, SQLite/manual Docker runs, mirrors, connector images, and local development containers, see [docker/README.md](docker/README.md).

## Onboarding

After the Docker stack or server is running, start from the Web console. The initial setup token flow is Web-only.

1. Open the Web console, paste the bootstrap token from the server logs, and create the first account. That account becomes the administrator.
2. Add the first Device from the Web console. This is the machine that owns your workspace and local Codex / Claude runtime.
3. Choose the Connector for that machine:

| Target machine | Recommended Connector | Notes |
| --- | --- | --- |
| Windows | Agents Anywhere Connector app | Download the desktop Connector app from [GitHub Releases](https://github.com/anywhere-labs/Agents-Anywhere/releases). The app keeps the Connector running in the background and guides pairing. |
| macOS | Agents Anywhere Connector app | Download the desktop Connector app from [GitHub Releases](https://github.com/anywhere-labs/Agents-Anywhere/releases). The app keeps the Connector running in the background and guides pairing. |
| Linux | Connector CLI | Use `uvx anywhere-cli` or the CLI in `connector/`. The Web UI and CLI pairing flow show the exact command or pairing code. |

The Web and Android clients already provide the pairing UI, so this README only calls out the platform choice. After the first Device is online, use either the Web console or Android app for daily work: chat with sessions, manage Devices, handle approvals, browse remote files, open terminals, and pair additional Devices.

For advanced Connector commands, Dockerized Connector images, SSH-enabled development containers, and agent installer images, see [connector/README.md](connector/README.md) and [docker/README.md](docker/README.md).

## Beta Access And Contact

Agents Anywhere now provides a hosted beta service. The service is currently free, in beta, and open by application for users in China only.

If you want to try it, scan the WeChat or Feishu QR code below, join the group, and contact an admin.

| WeChat | Feishu | Discord |
| --- | --- | --- |
| <img src="docs/contact/wechat-beta.jpeg" alt="WeChat beta access group QR code" width="180"> | <img src="docs/contact/feishu-beta.jpeg" alt="Feishu beta access group QR code" width="180"> | <img src="docs/contact/discord-beta.jpeg" alt="Discord community QR code" width="180"> |
| China beta access group | China beta access group | International community |

For overseas users, the hosted beta is not open yet. Join Discord for community updates.

## License

[MIT](LICENSE)
