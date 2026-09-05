import Foundation

/// Presentation can choose recovery actions without interpreting localized messages.
struct V2ClientFailure: Error, Hashable, LocalizedError {
    enum Kind: Hashable { case offline, transient, authentication, unavailable, rejected, cancelled, invalidResponse }
    let kind: Kind
    let message: String
    let code: String?

    init(kind: Kind, message: String, code: String? = nil) {
        self.kind = kind
        self.message = message
        self.code = code
    }

    init(_ error: Error) {
        if let failure = error as? Self { self = failure; return }
        message = error.localizedDescription
        code = (error as? HTTPError)?.serverCode ?? (error as? V2RuntimeError)?.code
        if error is CancellationError || (error as? URLError)?.code == .cancelled {
            kind = .cancelled
        } else if let error = error as? URLError {
            kind = error.code == .notConnectedToInternet ? .offline : .transient
        } else if let error = error as? HTTPError {
            switch error {
            case .unauthorized: kind = .authentication
            case let .server(status, _, _):
                switch status {
                case 401, 403: kind = .authentication
                case 404, 410: kind = .unavailable
                case 408, 425, 429, 500...599: kind = .transient
                default: kind = .rejected
                }
            case .streamOverflow: kind = .transient
            default: kind = .invalidResponse
            }
        } else if error is V2BusinessError { kind = .rejected }
        else { kind = .transient }
    }

    var errorDescription: String? { message }
    var permitsAutomaticReconnect: Bool { kind == .transient || kind == .offline }

    /// Once a write has started, only a definite local/HTTP rejection proves it was not accepted.
    /// RPC timeouts, 5xx, decoding failures and cancellation can all follow server execution.
    static func isDefiniteWriteRejection(_ error: Error) -> Bool {
        if error is V2BusinessError { return true }
        if let failure = error as? Self { return [.offline, .rejected, .authentication, .unavailable].contains(failure.kind) }
        guard let error = error as? HTTPError else { return false }
        if case .unauthorized = error { return true }
        guard let status = error.statusCode else { return false }
        return (400..<500).contains(status) && status != 408
    }
}
