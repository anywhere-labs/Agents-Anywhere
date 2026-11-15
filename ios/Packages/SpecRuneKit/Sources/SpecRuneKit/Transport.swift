import Foundation

/// 一次 shell 执行的原始结果。
public nonisolated struct SpecRuneShellResult: Hashable, Sendable {
    public let stdout: String
    public let stderr: String
    public let exitCode: Int?
    public let timedOut: Bool
    public let stdoutTruncated: Bool

    public init(
        stdout: String,
        stderr: String,
        exitCode: Int?,
        timedOut: Bool,
        stdoutTruncated: Bool
    ) {
        self.stdout = stdout
        self.stderr = stderr
        self.exitCode = exitCode
        self.timedOut = timedOut
        self.stdoutTruncated = stdoutTruncated
    }
}

/// 宿主（主 app）提供的传输能力。
///
/// 只有两个动作：跑一条 shell、读一个文本文件。主 app 用官方 Server 既有的
/// `shell/exec` 与 `fs/readText` 端点实现它——本包因此不必依赖 ClientCore，
/// 也就不必为跨包可见性给一堆既有类型加 `public`。
/// 读到的文本文件。`truncated` 表示原文超过读取上限（1 MiB）。
public nonisolated struct SpecRuneTextFile: Hashable, Sendable {
    public let content: String
    public let truncated: Bool

    public init(content: String, truncated: Bool) {
        self.content = content
        self.truncated = truncated
    }
}

public nonisolated protocol SpecRuneTransport: Sendable {
    /// 在 `repo` 根执行 shell 命令。
    func shell(repo: String, command: String) async throws -> SpecRuneShellResult
    /// 读 `repo` 内文本文件；不存在返回 nil，其它错误抛出。
    func readText(repo: String, path: String) async throws -> SpecRuneTextFile?
}
