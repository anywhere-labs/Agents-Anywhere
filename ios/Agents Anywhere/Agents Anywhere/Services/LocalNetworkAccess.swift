import Foundation
import Network

enum LocalNetworkAccessError: LocalizedError {
    case denied
    var errorDescription: String? { "Local Network access is disabled. Enable it for Agents Anywhere in Settings, then try again." }
}

/// Trigger local-network privacy with a real connection to the server the user
/// chose, before launching a browser (WebKit traffic cannot grant native access).
/// There is no discovery broadcast or fabricated Bonjour service.
@MainActor final class LocalNetworkAccess {
    private var connection: NWConnection?
    private var timeout: Task<Void, Never>?
    private let result = AsyncResultGate<Bool>()
    private var denied = false

    static func prepare(for url: URL) async throws {
        guard ServerNetworkPolicy.needsLocalAccess(url) else { return }
        let probe = LocalNetworkAccess()
        try await probe.connect(to: url)
    }
    private func connect(to url: URL) async throws {
        guard let host = url.host, let port = NWEndpoint.Port(rawValue: UInt16(exactly: url.port ?? (url.scheme == "https" ? 443 : 80)) ?? 0), port.rawValue > 0 else { throw APIClientError.invalidServerURL }
        let connection = NWConnection(host: NWEndpoint.Host(host.trimmingCharacters(in: CharacterSet(charactersIn: "[]"))), port: port, using: .tcp)
        self.connection = connection
        connection.stateUpdateHandler = { [weak self] state in
            Task { @MainActor [weak self] in
                guard let self else { return }
                self.denied = self.denied || connection.currentPath?.unsatisfiedReason == .localNetworkDenied
                switch state {
                case .ready: self.finish(.success(true))
                case .failed(let error): self.finish(.failure(self.denied ? LocalNetworkAccessError.denied : error))
                case .cancelled: self.result.resolve(.failure(CancellationError()))
                default: break // Wait through the permission prompt, including .waiting.
                }
            }
        }
        timeout = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(30)) } catch { return }
            guard let self else { return }
            self.finish(.failure(self.denied ? LocalNetworkAccessError.denied : URLError(.timedOut)))
        }
        defer { timeout?.cancel(); connection.stateUpdateHandler = nil; connection.cancel(); self.connection = nil }
        _ = try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                result.install(continuation)
                if Task.isCancelled { result.resolve(.failure(CancellationError())) }
                else { connection.start(queue: .main) }
            }
        } onCancel: { [result] in result.resolve(.failure(CancellationError())) }
    }
    private func finish(_ result: Result<Bool, Error>) { self.result.resolve(result); timeout?.cancel() }
}
