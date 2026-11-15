import Foundation
import SpecRuneKit

/// 把主 app 的 Connector API 桥成 `SpecRuneKit` 需要的传输能力。
///
/// 只用官方 Server 既有的两条端点：`shell/exec` 与 `fs/readText`。
/// 放在 `Views/SpecRune/` 而不是 `Business/`，是因为 `Business/` 属于
/// ClientCore target，而 ClientCore 并不依赖 SpecRuneKit（避免为跨包可见性
/// 给一批既有类型加 `public`）。
/// `@unchecked Sendable`：`V2ConnectorAPIProtocol` 的既有实现（`V2ConnectorAPI`）
/// 是不可变的 HTTP 传输封装，跨 actor 传递安全；这里只是替它做担保，
/// 免得为了一个协议约束去改 ClientCore 里的既有类型。
nonisolated struct SpecRuneConnectorTransport: SpecRuneTransport, @unchecked Sendable {
    let api: any V2ConnectorAPIProtocol
    let connectorId: V2ConnectorID

    func shell(repo: String, command: String) async throws -> SpecRuneShellResult {
        let response = try await api.shellExec(
            connectorId: connectorId,
            root: repo,
            request: V2ShellExecRequest(command: command, cwd: ".", timeoutMs: 20_000)
        )
        guard let result = response.result else {
            throw SpecRuneError.cliFailed(response.error?.message ?? "")
        }
        return SpecRuneShellResult(
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: result.exitCode,
            timedOut: result.timedOut,
            stdoutTruncated: result.stdoutTruncated
        )
    }

    /// 判断错误是否表示「文件不存在」。
    ///
    /// Connector 缺文件时抛 `FileNotFoundError`，RPC 层把它变成
    /// `ok=false, code="FileNotFoundError"`，Server 再包成
    /// `ConnectorUpstreamError` → **HTTP 502**（不是 404）。所以只认 404
    /// 会把「文档可选」误当成致命错误。
    private static func isMissingFile(_ error: HTTPError) -> Bool {
        if error.statusCode == 404 { return true }
        guard error.statusCode == 502 else { return false }
        let message: String
        if case let .server(_, text, _) = error { message = text } else { message = "" }
        let lower = message.lowercased()
        return lower.contains("no such file")
            || lower.contains("filenotfound")
            || lower.contains("not found")
    }

    func readText(repo: String, path: String) async throws -> SpecRuneTextFile? {
        do {
            let response = try await api.readWorkspaceText(
                connectorId: connectorId,
                root: repo,
                request: V2WorkspaceTextRequest(path: path)
            )
            guard !response.binary else { return nil }
            return SpecRuneTextFile(content: response.content, truncated: response.truncated)
        } catch let error as HTTPError {
            if Self.isMissingFile(error) { return nil }
            throw error
        }
    }
}
