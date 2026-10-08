# Pi Runtime

本分支把 Pi 作为原生 Runtime 注册到标准 Connector，不再需要额外的
`pi-agents-anywhere` Python 包、`pi-aa-connector` 入口或桌面 `.pth` hook。
Codex、Claude、DSH 保持原有顺序和实现，Pi 追加到 registry。

## 安装与配置

1. 工作设备另行安装 [Pi](https://github.com/earendil-works/pi)，确保 Connector
   启动环境能找到 `pi`。已做 Windows Pi 1.1.0、macOS Pi 0.87.1 的离线 smoke；
   本次使用 Node 22.19+，其他版本应核对其自身的运行要求。
2. 使用本分支的 Connector，或重新构建包含它的桌面版。在工作设备下添加
   Pi Runtime。仅复制仓库不会修改已安装的官方桌面版。
3. 使用现有 Pi 模型配置与登录方式。本集成不安装 Pi、不登录模型账户、不
   把模型密钥放入 AA Runtime 配置。

示例配置（占位/默认值，不含真实账户）：

```json
{
  "executablePath": "pi",
  "sessionsDir": "~/.pi/agent/sessions",
  "defaultCwd": "~",
  "requestTimeoutMs": 60000,
  "idleTimeoutSeconds": 600,
  "permissionMode": "ask-writes"
}
```

指定现有 `sessionsDir` 会将该目录中的历史同步到连接的 AA Server。如果只想
同步新会话，应先选择空的专用目录；不要为了测试拷贝全部历史与模型凭据。
Windows 支持 npm `pi.cmd` 解析为 Node + CLI 参数数组；不要把完整 shell 命令
填进 `executablePath`。桌面进程的 PATH 可能与终端不同。

## 保留的能力与安全边界

- Pi 原生 JSONL 会话读取、时间线投影、模型/权限/命令目录。
- JSONL 严格按 LF 分帧，持续消费 stdout；文本与工具输出流式投影。
- `agent_settled` 才表示自动工作结束，不能把 prompt 接受响应当成完成。
- `ask-writes` 默认审批、拒绝不执行、图片和文本/文件附件处理。
- 每会话 Pi RPC 子进程、空闲回收与原生文件续接。
- 重连通过通用 `on_backend_reconnect()` 回调重报真实会话状态，不重启会话。
  首次调用不受系统刚启动时 monotonic 时间较小的影响，之后保留防抖。

工具审批不是 OS 沙箱。Pi 扩展代码仍拥有进程的文件和网络权限；只加载可信
扩展。`full-auto` 不是默认模式，不能为了绕开审批而自动启用。

本分支使用原生注册，不应再叠加旧外部 CLI/hook。旧桌面环境的迁移必须单独
备份并验证，不能直接删除既有 `.pth` 或运行另一份持有同一设备身份的 Connector。

## 有界历史同步

`connector/server/ingest_batching.py` 将增量 `timeline.sync` 按实际 UTF-8 JSON
字节数拆为不超过 8 MiB 的请求。保留 ID、顺序、metadata；所有批次接受后才
提交同步检查点，部分失败可幂等重放。HTTP 200 中的 rejected 也视为失败。

**`complete=true` 是整份替换，不是“最后一页”。** 超限完整替换快照或单个
不可拆分条目会明确失败；轮询会话进入 30 分钟冷却，源变化或重启可重试。
不截断、不删除、不虚假确认历史。大完整快照的分阶段原子提交仍需未来协议
设计，本次没有通过调大服务端上限或改变删除语义规避这个边界。

## 验证

```sh
cd connector
uv sync
uv run pytest -q
uv run python scripts/probe_pi.py
uv build --wheel
```

测试应使用空 HOME/agent/data 目录，避免读到现用配置。Pi 测试里的 fake Pi 是
POSIX 可执行脚本，完整套件在 Linux/WSL 执行。Git 属性确保其 shebang 使用 LF。
审批 TypeScript 测试可使用 Node 22+，相对资源路径兼容 Windows/WSL。

`probe_pi.py` 是空 agent 目录中的离线检查：读取版本/help，加载本包审批扩展，
发送 `get_state` 并回收子进程。不发送 prompt，不连接 AA Server，不读取真实
模型凭据，不产生模型调用费用。`--no-mcp` 仅在该版本 CLI/help 支持时添加；
旧版仍保留空目录、禁用扩展/工具/上下文文件及离线开关，不降低隔离要求。

本次证据：
- Linux Connector 全套：1199 passed、2 个 Darwin 专属路径测试 skipped。
- macOS 26.5.2 / arm64 全套：1201 passed，无失败、无跳过，包含 Darwin 路径用例。
- Windows 原生 registry/重连与实际审批 TypeScript：7 passed；新增探针参数兼容用例 2 passed。
- Windows Pi 1.1.0、macOS Pi 0.87.1 离线 RPC smoke：成功，子进程已回收。
- macOS wheel 构建与资源清单验证通过，独立临时验证目录已清理。
- 过程中的失败与修复见 [Mac 验证记录](../features/pi-and-bounded-ingest/mac-verification.md)。
- 真实 UI、模型调用、流式审批/附件端到端及正式桌面安装包未在本分支验收。
  headless 与离线 probe 成功不等于这些用户流程已经验证。

来源与 MIT 声明见
[`connector/runtimes/pi/UPSTREAM.md`](../../connector/connector/runtimes/pi/UPSTREAM.md)。
