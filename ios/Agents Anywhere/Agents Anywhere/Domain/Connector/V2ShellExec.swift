import Foundation

/// `POST /connectors/{id}/shell/exec?root=` 的请求体。
/// `command` 是完整 shell 命令字符串（服务端走 `create_subprocess_shell`），
/// 因此路径参数必须由调用方自行加引号。
nonisolated struct V2ShellExecRequest: Encodable, Hashable {
    let command: String
    var cwd: String?
    var timeoutMs: Int

    init(command: String, cwd: String? = nil, timeoutMs: Int = 15_000) {
        self.command = command
        self.cwd = cwd
        self.timeoutMs = timeoutMs
    }
}

nonisolated struct V2ShellExecResponse: Decodable, Hashable {
    let ok: Bool
    let result: V2ShellExecResult?
    let error: V2RuntimeError?
}

nonisolated struct V2ShellExecResult: Decodable, Hashable {
    let cwd: String
    let command: String
    let exitCode: Int?
    let timedOut: Bool
    let durationMs: Int
    let stdout: String
    let stderr: String
    let stdoutTruncated: Bool
    let stderrTruncated: Bool
}
