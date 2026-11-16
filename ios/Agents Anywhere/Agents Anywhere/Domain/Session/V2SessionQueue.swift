import Foundation

/// One message waiting in the server-owned session queue.
nonisolated struct V2SessionQueueItem: Decodable, Identifiable, Hashable {
    enum Status: String, Decodable, Hashable {
        case queued, sending, failed
        case unknown

        init(from decoder: Decoder) throws {
            self = Status(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .unknown
        }
    }

    struct Attachment: Decodable, Hashable {
        let fileId: V2AttachmentID
        let name: String?
        let mediaType: String?
        let size: Int?
    }

    let messageId: String
    let sessionId: V2SessionID
    let clientMessageId: String
    let content: String
    var attachments: [Attachment]? = nil
    let status: Status
    let position: Int
    let interruptRequested: Bool
    var error: V2RuntimeError? = nil

    var id: String { messageId }
    /// A message that is being handed to the runtime cannot be changed.
    var isEditable: Bool { status != .sending }
}

/// The whole queue. Every change raises `revision`; clients keep the newest copy.
nonisolated struct V2SessionQueueState: Decodable, Hashable {
    let sessionId: V2SessionID
    let revision: Int
    let items: [V2SessionQueueItem]

    /// Session states in which a new message waits instead of starting a turn.
    static let busyStatuses: Set<V2RuntimeStatus> = [.running, .waiting, .pending, .waitingApproval, .blocked, .stopping]

    /// Keep the newest whole-queue snapshot; an older revision never wins.
    static func merge(_ current: Self?, _ next: Self?) -> Self? {
        guard let next else { return current }
        if let current, current.sessionId == next.sessionId, current.revision > next.revision { return current }
        return next
    }

    /// A message also waits behind earlier ones, so the queue keeps its order
    /// while the session is momentarily idle.
    static func messageMustWait(status: V2RuntimeStatus?, queue: Self?) -> Bool {
        busyStatuses.contains(status ?? .unknown) || queue?.items.isEmpty == false
    }

    enum Pause: Hashable {
        /// The head failed to send; later messages wait behind it.
        case failed
        /// The last turn ended in an error; the queue waits for "continue".
        case error
    }

    func pause(status: V2RuntimeStatus?) -> Pause? {
        guard let head = items.first else { return nil }
        if head.status == .failed { return .failed }
        if status == .error, head.status == .queued { return .error }
        return nil
    }

    /// The queue returned with a send the Server kept for later, if any.
    static func queued(in response: V2RuntimeActionResponse) -> Self? {
        guard response.result?["delivery"]?.stringValue == "queued", let raw = response.result?["queue"] else { return nil }
        return try? JSONDecoder().decode(Self.self, from: JSONEncoder().encode(raw))
    }
}

/// How the composer hands a message to the session.
nonisolated enum V2MessageDelivery: Hashable {
    /// Start a new turn now (the session is idle).
    case send
    /// Wait in the server queue until the current turn ends.
    case queue
    /// Jump to the head of the queue and interrupt the current turn.
    case interrupt
    /// Add the message to the running turn; it does not go through the queue.
    case steer

    /// Value of the request's `queue` field; nil sends directly.
    var queueField: String? {
        switch self {
        case .queue: "auto"
        case .interrupt: "interrupt"
        case .send, .steer: nil
        }
    }
}

nonisolated struct V2SessionQueueEditRequest: Encodable, Hashable {
    let content: String
}
