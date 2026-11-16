# DSH Bridge 3.0（插件在 DSH host 里说 ACP）

装了 DSH Desktop（或开着 `dsh web`）并装了 AA 插件时，插件在 DSH host 进程里实现一个 ACP Agent，拨号到 Connector 的本机 socket；会话就是 host 里的真实会话，与 DSH 界面双向实时一致。2.0（MeshCall）继续保留给旧插件。

## 传输与握手

- Connector 监听 Unix socket / named pipe，发布 rendezvous 文件 `~/.agents-anywhere/dsh-bridge/connector-acp.json`：`{version: 3, protocol: "acp", endpoint, key}`（文件权限 0600；Unix 校验对端 uid，named pipe 设 ACL）。2.0 的 `connector.json` 保持原文件名与原格式，两者并存。
- 插件 `fs.watch` rendezvous 文件后拨号，首帧 `{t:"hello", key, hostInstance, dshVersion, pluginVersion}`，校验通过后同一连接跑 ACP：插件是 Agent 端，Connector 是 Client 端。每个 host 一条连接。

## ACP 映射与扩展

- 会话列表：`session/list` + `_session/list/subscribe`。
- DSH 界面发起的回合：插件推 `_dsh/session/turn`。
- 投递方式：`session/prompt` 的 `_meta.dsh.delivery: queue|steer`。
- 失败卡片「继续」：`_dsh/session/continue`。
- 计划读写与审阅、提问（`elicitation/create`）、附件（`resource_link` + `_meta.dsh.upload`）。
- 流式与提交：`_meta.dsh.transient` / `_meta.dsh.committed`；续传：`_meta.dsh.replayFromSeq`。
- UI 先答审批时插件撤回请求并补 `_dsh/interaction/resolved`。
- 新建会话按 `_meta.dsh.sessionId` 使用 AA 指定的 ID。

## 不变量

- Connector 断线不得影响 host 里的会话：插件只附着，从不 dispose 用户的 Agent。
- 同一 DSH 会话任一时刻只有一个写者；路由（插件 / 直连 `dsh --profile acp`）只在回合之间切换，交接规则见 `docs/v3/04-connector.md` §5.6。
