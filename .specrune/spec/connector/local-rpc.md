# 本机 RPC 契约（fs.readText / shell.exec）

Connector 的本地能力经 RPC 暴露给 Server，再由 Server 转发给客户端。这两个方法
是**通用出口**——客户端可以不经任何专用端点拿到工作设备上的文件与命令输出。
2026-11-16 的 SpecRune 看板完全依赖它们实现（Server 与 Connector 零改动），
过程中踩到两个必须写死的边界。

代码锚点：`connector/connector/local/file_ops.py`（`read_text`）、
`connector/connector/local/shell.py`（`exec`）、
`connector/connector/local/common.py`（`MAX_OUTPUT_CHARS` / `MAX_READ_TEXT_BYTES` /
`shell_result`）、`server/agent_server/api/error_handlers.py`。

## `fs.readText`

```python
# 请求
{"root": "<绝对路径>", "path": "<相对 root 的路径>", "maxBytes": 1_048_576}
# 成功返回
{"path": str, "name": str, "size": int, "sha256": str, "encoding": "utf8",
 "content": str, "truncated": bool, "binary": bool}
```

- `maxBytes` 默认 **1 048 576**；取值被 clamp 到 `[1, MAX_READ_TEXT_BYTES]`，
  上限 **4 MiB**。超限时 `truncated=true`，`size` 仍是**原始**字节数。
- `binary` 为真表示内容含 `\x00`，此时 `content` 是**空串**——调用方必须看
  `binary` 而不是 `content.isEmpty` 判断。
- `truncated` 与 `binary` 是两件独立的事，可以同时为真。

## `shell.exec`

```python
# 请求
{"root": "<绝对路径>", "cwd": "<相对 root>", "command": "<完整 shell 命令>", "timeoutMs": int}
# 成功返回
{"cwd": str, "command": str, "exitCode": int?, "timedOut": bool, "durationMs": int,
 "stdout": str, "stderr": str, "stdoutTruncated": bool, "stderrTruncated": bool}
```

- `command` 是**整条 shell 命令字符串**（走 `create_subprocess_shell`），路径参数
  必须由调用方自己加引号。
- stdout/stderr 上限 `MAX_OUTPUT_CHARS = 64_000`——**按字符计数，不是字节**。
  超限即截断并置 `*Truncated=true`，**内容不再合法**（JSON 会被切一半）。
- `exitCode` 非 0 是正常返回，不是错误；`timedOut=true` 表示超时后强杀。

## 错误矩阵（Server 侧状态码）

| Connector 抛出 | Server 状态码 | 典型触发 |
| --- | --- | --- |
| `ConnectorUnavailableError` | **409** | 设备离线 |
| `ConnectorRequestTimeoutError` | **504** | RPC 超时 |
| `ConnectorUpstreamError` / `ConnectorProtocolError` | **502** | Connector 内部异常，**含文件不存在** |
| 其它 | 500 | 未分类 |

### 缺文件是 502，不是 404

`fs.readText` 缺文件时抛 `FileNotFoundError("file not found: <path>")`，RPC 层把它
变成 `ok=false, code="FileNotFoundError"`，Server 再包成 `ConnectorUpstreamError`
→ **HTTP 502**。读文本端点本身没有 404 映射。

**正确**（调用方把「可选文件缺失」当正常分支）：

```swift
catch let error as HTTPError {
    if error.statusCode == 404 { return nil }                       // 保守
    if error.statusCode == 502,
       error.message.lowercased().contains("file not found") { return nil }
    throw error
}
```

**错误**（只认 404）：

```swift
if error.statusCode == 404 { return nil }
throw error   // ← 可选文档缺失被当成致命错误，整页失败
```

## 大结果必须换通道

`shell.exec` 的 64 000 字符是**硬上限**，而 `fs.readText` 的上限是 4 MiB，两者
差两个数量级。实测：SpecRune 项目 239 条归档的 `task list --json --all` 有
222 KB，远超上限；按状态分批后 `completed` 单批仍有 219 KB，**照样超**。

- 小结果（几百条以内、无大字段）→ 用 `shell.exec`
- 大列表 → 列目录 + 逐个 `fs.readText`（不受 stdout 上限约束，代价是请求数）
- 调用方必须检查 `stdoutTruncated`，**不能**把截断后的文本当完整 JSON 解析

## 必需测试与断言点

- `fs.readText` 缺文件 → 经 Server 得到 **502** 且 message 含 `file not found`
- `fs.readText` 超 `maxBytes` → `truncated=true` 且 `size` 为原始大小
- `fs.readText` 二进制文件 → `binary=true`、`content` 为空串
- `shell.exec` 输出超 64 000 字符 → `stdoutTruncated=true`
- `shell.exec` 非零退出 → `exitCode != 0` 且 `stdout`/`stderr` 仍完整返回
