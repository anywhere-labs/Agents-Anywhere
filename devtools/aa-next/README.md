# AA NEXT 本机 Codex 联调

这个开发入口在本机复用 Effi 的 TypeScript 会话内核和组织版 `codex-acp`。
同一条会话可通过 `watch` 查看，再通过 `follow` 继续，随后用 `send` 插话或用
`stop` 中断。命令从标准输入接收，每行一条 JSON，响应和订阅更新按行输出。

先在本机分别构建适配器和 Effi 的 `cloud/agentd`。使用绝对路径指向构建产物，
并填写适配器的 SHA-256。默认使用当前用户的 Codex IPC 地址。
状态目录只允许当前用户访问，同一目录只启动一个本机宿主。

```sh
AA_NEXT_CONVERSATION_HOST=/path/to/agentd/dist/src/conv/local-host.js \
AA_NEXT_CODEX_ACP_BUILD=/path/to/codex-acp/dist/index.js \
AA_NEXT_CODEX_ACP_SHA256=<build-sha256> \
AA_NEXT_STATE_DIR=/path/to/isolated-state \
node devtools/aa-next/codex-host.mjs
```

输入 `{"command":"list"}` 获取会话 ID。先用 `{"command":"watch","id":"<id>"}`
查看会话，准备继续时输入 `{"command":"follow","id":"<id>"}`。发送时使用
`{"command":"send","id":"<id>","clientMessageId":"<unique-id>","text":"继续"}`。
显式中断用 `{"command":"stop","id":"<id>"}`。关闭订阅用
`{"command":"unwatch","id":"<id>"}`。

审批出现在订阅的 `control.pending` 中。使用其中的请求 ID 和选项 ID，发送
`{"command":"answer","id":"<id>","requestId":"<request-id>","optionId":"<option-id>"}`。
原窗口提供的配置出现在会话的 `config` 中。修改时发送
`{"command":"set-config","id":"<id>","configId":"<config-id>","value":"<value>"}`。
设置由原窗口确认。
