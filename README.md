<div align="center">

# Agents Anywhere

**Control any coding agent on any device — from your phone.**

Agents Anywhere is a mobile and web remote for Claude Code, Codex, Cursor, OpenCode, and Gemini CLI — wherever they run. Your laptop, a cloud sandbox, a remote server. One control plane.

[![Status](https://img.shields.io/badge/status-private%20beta-f5a524)](https://www.agents-anywhere.com)
[![License](https://img.shields.io/badge/license-MIT-blue)](#license)
[![Platforms](https://img.shields.io/badge/platforms-iOS%20%C2%B7%20Android%20%C2%B7%20macOS%20%C2%B7%20Windows%20%C2%B7%20Web-lightgrey)](#supported-devices)

[Request access](https://www.agents-anywhere.com) · [Docs (coming soon)](#)

**English** · [简体中文](README.zh-CN.md)

</div>

---

> **Status: private beta.** This repo currently hosts the README and roadmap while we finish hardening the client and CLI. Source will land here as we open it up. Drop your email on [our waitlist](https://www.agents-anywhere.com) to get an invite.

## What is Agents Anywhere?

You opened Claude Code in a terminal. You started something. Then you closed your laptop, walked to lunch, and lost the thread.

Agents Anywhere is the remote. Your agents keep running on whatever machine they live on — your MacBook, a cloud sandbox, a devbox on us-west-1 — and we give you a real client for them on every screen you own. Approve a diff from your phone. Read the live tool-call feed on the train. Pop a terminal from the browser tab on the kitchen iPad.

**Agents Anywhere is the remote, not the host.** Your code never runs on our servers. You still pay your own model provider (Anthropic, OpenAI, Google). We just route the keystrokes.

## Demo

**Desktop · Multi-panel session view**

![Multi-panel session view](docs/screenshots/hero.png)

> Chat, file tree, in-conversation diff, and a live terminal panel — all in one window.

**Desktop · Unified sessions sidebar**

![Unified sessions sidebar](docs/screenshots/control-plane.png)

> Every session across every machine in the same sidebar. Pinned at top, recents below.

**Mobile · Sessions & Devices**

![Mobile — Sessions and Devices](docs/screenshots/mobile.png)

> Same control plane on iPhone. Sessions on one tab, paired devices on the other.

## Why

The agent boom turned every developer into someone tailing a long-running process. Coding agents take real time — minutes, sometimes hours. They also block on permission prompts that you, the human, have to clear before they can continue.

Today that flow is:
- Be at your laptop, or
- Lose the session.

That's a bad bargain. Agents Anywhere fixes it.

## Architecture

Three pieces:

```
┌──────────────┐         ┌──────────────┐         ┌────────────────────┐
│   Client     │ ──────▶ │    Relay     │ ──────▶ │     Daemon         │
│  iOS · Web   │         │              │         │  + your coding     │
│  macOS · …   │ ◀────── │              │ ◀────── │   agent on YOUR    │
└──────────────┘         └──────────────┘         │     machine        │
                                                  └────────────────────┘
```

- **Client** — the app you read sessions and approve from. iOS, Android, macOS, Windows, web.
- **Relay** — the small hosted service that routes messages between client and daemon. Self-hostable.
- **Daemon** — runs next to your agents on whatever machine they live on. Reads what they're doing, sends prompts back in.

## Supported agents

Agents Anywhere runs alongside your existing agent, whichever one you reach for:

| Agent          | Vendor      |
| -------------- | ----------- |
| Claude Code    | Anthropic   |
| Codex          | OpenAI      |
| Cursor         | Anysphere   |
| OpenCode       | SST         |
| Gemini CLI     | Google      |

The agent runtime is open source — adding your own adapter is straightforward.

## Features

- **One control plane.** Every session, every agent, every device — pinned, searchable, branch-aware — in the same sidebar.
- **Push you actually want.** Notifications fire only when the agent is blocked on a permission, error, or completion. Not chatter.
- **Approve from anywhere.** Read the diff on your phone. Hit approve. Or write back to course-correct. We hold the line until you're ready.
- **Live tool-call feed.** Every `READ`, `EDIT`, `BASH`, `GREP` appears in the conversation as it happens.
- **Terminal in the side panel.** Pop a real shell on the agent's machine. Run commands without leaving the chat.
- **File tree, one tap away.** Browse the working directory. Open a file. Scroll through diffs.
- **Branch-aware sessions.** Sessions remember the branch they were started on. Pick the same branch up later.
- **Search across everything.** ⌘K to find any session by title, file, branch, or device.
- **Pin and archive.** Keep what matters at the top. Archive the rest with one keystroke.
- **Remote, no SSH.** Run the CLI once on any box and it's reachable. No keys, no port-forwarding gymnastics.

## Supported devices

| Platform | Status            |
| -------- | ----------------- |
| iOS      | Native, TestFlight |
| Android  | Native, internal track |
| macOS    | Native            |
| Windows  | Native            |
| Web      | Any modern browser |

One account. All of them.

## Getting started

```bash
# 1. Install
npm install agents-anywhere

# 2. Pair this machine with your account
aw pair

# 3. Add an agent
aw agent add claude
```

That's it. Open the Agents Anywhere app on your phone — the agent is already in your sidebar.

### Two ways to pair

- **From the web.** Open the Agents Anywhere web app and sign in. Click *Add device* — it generates a command for you. Copy it and run it on the machine you want to bind: `aw pair tenh-ak35-44qj` (example code).
- **From the daemon.** Run `aw pair` with no arguments. A QR code prints in the terminal — scan it with the mobile app to bind the device.

## FAQ

**When can I get in?**
We're in private beta and letting in about 200 developers a week as we tune the experience. Drop your email on [our waitlist](https://www.agents-anywhere.com) and we'll send an invite as your slot opens.

**Where does my code actually run?**
On whatever machine you point Agents Anywhere at — your laptop, a cloud sandbox, a remote server. We're the remote, not the host. We never execute your code on our servers.

**Do I need to install anything on my dev box?**
Yes — one small CLI runs alongside your agents on whichever machine they live on. One command to install, one command to pair each new device.

**Is it free?**
The client and CLI are MIT-licensed and free during the beta. You still pay your own model provider — we're the remote, not the brain.

**Which agents does it work with?**
At launch: Claude Code, Codex, Cursor, OpenCode, and Gemini CLI. New agents land as official adapters; the agent runtime is open source so you can also write your own.

**Will there be a self-hosted relay?**
Yes. The relay is part of what we're opening up. If you'd rather not route traffic through our hosted relay, you'll be able to run your own.

## Roadmap

- [x] iOS client (TestFlight)
- [x] Web client
- [x] Adapters for Claude Code, Codex, Cursor, OpenCode, Gemini CLI
- [x] Live tool-call feed + push notifications
- [ ] Public beta
- [ ] Native macOS + Windows desktop clients
- [ ] Android stable channel
- [ ] Self-hosted relay
- [ ] Adapter SDK + docs for third-party agents
- [ ] Plugin marketplace

## Contributing

The source for the client, CLI, and adapter runtime will land in this repo as we open the beta. Until then, the most useful thing you can do is:

1. Join the [waitlist](https://www.agents-anywhere.com) and try the beta.
2. File issues here — even pre-source, we read every one and use them to prioritize.

A `CONTRIBUTING.md` will arrive with the source drop.

## License

MIT. See [LICENSE](LICENSE) once published.

---

<div align="center">

**[Join the waitlist →](https://www.agents-anywhere.com)** · A remote for AI coding agents. Open source. Native on every screen.

</div>
