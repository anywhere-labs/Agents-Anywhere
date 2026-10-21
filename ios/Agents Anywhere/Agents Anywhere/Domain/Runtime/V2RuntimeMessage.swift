import Foundation

nonisolated struct V2RuntimeMessageSendRequest: Encodable, Hashable {
    let content: String
    let attachments: [V2AttachmentSendReference]
    let clientMessageId: String?
}

nonisolated struct V2AttachmentSendReference: Encodable, Hashable {
    let fileId: V2AttachmentID
}

nonisolated struct V2RuntimeActionResponse: Decodable, Hashable {
    let ok: Bool
    let result: JSONValue?
    let error: V2RuntimeError?

    @discardableResult
    func requireSuccess() throws -> Self {
        guard ok else {
            throw error ?? V2RuntimeError(code: nil, message: String(localized: "The runtime did not accept this operation."))
        }
        return self
    }
}

nonisolated struct V2RuntimeCommand: Decodable, Identifiable, Hashable {
    let id: String
    let title: String
    let description: String?
    let aliases: [String]
    let category: String?
    let scope: String
    let enabled: Bool
    let disabledReason: String?
    let acceptsArgs: Bool?
    let argsSchema: JSONValue?
    let metadata: JSONValue?
}

nonisolated struct V2RuntimeCommandListResponse: Decodable, Hashable {
    let commands: [V2RuntimeCommand]
    let serverTime: String?
}

nonisolated struct V2RuntimeCommandExecuteRequest: Encodable, Hashable {
    let command: String
    let args: [String]
    let raw: String?
}

nonisolated struct V2RuntimeCommandExecuteResponse: Decodable, Hashable {
    let command: String?
    let ok: Bool
    let code: String?
    let message: String?
    let result: JSONValue?
    let session: V2SessionMeta?
    let serverTime: String
}

nonisolated struct V2RuntimeSteerRequest: Encodable, Hashable {
    let content: String
    let attachments: [V2AttachmentSendReference]
    let clientMessageId: String?
}
