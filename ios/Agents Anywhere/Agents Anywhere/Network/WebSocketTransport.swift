import Foundation

protocol WebSocketConnection: AnyObject {
    func messages() -> AsyncThrowingStream<Data, Error>
    nonisolated func close()
}

protocol WebSocketTransport {
    func connect(url: URL) -> any WebSocketConnection
}

struct URLSessionWebSocketTransport: WebSocketTransport {
    let urlSession: URLSession

    init(urlSession: URLSession = .shared) {
        self.urlSession = urlSession
    }

    func connect(url: URL) -> any WebSocketConnection {
        URLSessionWebSocketConnection(task: urlSession.webSocketTask(with: url))
    }
}

final class URLSessionWebSocketConnection: WebSocketConnection, @unchecked Sendable {
    private let task: URLSessionWebSocketTask

    init(task: URLSessionWebSocketTask) {
        self.task = task
        task.resume()
    }

    /// Receives socket frames until the server closes or the consumer cancels.
    func messages() -> AsyncThrowingStream<Data, Error> {
        AsyncThrowingStream { continuation in
            let receiveTask = Task {
                do {
                    while !Task.isCancelled {
                        let message = try await task.receive()
                        switch message {
                        case let .data(data):
                            continuation.yield(data)
                        case let .string(text):
                            continuation.yield(Data(text.utf8))
                        @unknown default:
                            continue
                        }
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { [task] _ in
                receiveTask.cancel()
                task.cancel(with: .goingAway, reason: nil)
            }
        }
    }

    nonisolated func close() {
        task.cancel(with: .normalClosure, reason: nil)
    }
}
