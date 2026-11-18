# Runtime 错误码文案

`messages.json` 是 Runtime、工作流和原生历史错误码面向用户文案的唯一来源，提供中文（`zh-CN`）和英文（`en`）。

## 规则

- Server 和 Connector 返回的失败一律带稳定的 `code`；`message` 只用于日志，以及客户端还不认识该错误码时的兜底显示。
- 客户端按 `code` 取当前界面语言的文案，不直接显示 `message`。新增错误码时，先在 `messages.json` 添加中英文两条，再发布产生该错误码的代码。
- 已发布的错误码不改名、不复用；文案可以调整。
- 客户端自己产生的兜底错误（如「恢复结果尚未确认」）也使用本表中的错误码，例如 `native_history_recovery_unconfirmed`。

## 生成

修改 `messages.json` 后运行：

```bash
python3 scripts/sync-runtime-error-messages.py
```

它会更新：

- Web 与 Desktop：`messages/{zh-CN,en}.json` 的 `runtimeErrors` 段；
- Android：`res/values{,-zh-rCN}/runtime_error_strings.xml` 与 `ui/designsystem/RuntimeErrorText.kt`；
- iOS：`Localizable.xcstrings` 中的对应词条与 `Models/RuntimeErrorText.swift`。

`--check` 只检查生成结果是否最新，可加入 CI 防止漏跑。

## 1.1 相对 1.0

只做加法，新增 v3 的错误码：设备读取超时、分享需要设备在线、分享内容过大、Codex App 持有会话、命令结果不确定、端到端加密（需要配对、未授权、配对码失效、设备身份变化）、端口预览（未配置域名、端口不允许、数量上限）、旧版设备需要升级才能打开会话。
