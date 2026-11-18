import Foundation

nonisolated struct V2RuntimeMessageSendRequest: Encodable, Hashable {
    let content: String
    let attachments: [V2AttachmentSendReference]
    let clientMessageId: String?
    /// `auto` or `interrupt`. Sent only while the session is busy and offers
    /// `session.queue`; without it a busy session still answers 409.
    var queue: String? = nil
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
        guard ok, result?["ok"] != .bool(false) else {
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

    /// A command answered `confirmation_required` with an `owner_release`
    /// confirmation; nil for every other response or an undecodable one.
    var ownerReleaseConfirmation: V2OwnerReleaseConfirmation? {
        guard code == "confirmation_required", let value = result?["confirmation"],
              let data = try? JSONEncoder().encode(value),
              let confirmation = try? JSONDecoder().decode(V2OwnerReleaseConfirmation.self, from: data),
              confirmation.kind == "owner_release" else { return nil }
        return confirmation
    }
}

/// Facts the device reports before quitting the app that holds a session.
/// The follow-up command repeats the same command id with one of the args lists.
nonisolated struct V2OwnerReleaseConfirmation: Decodable, Hashable {
    let kind: String
    let planId: String
    let expiresAt: String?
    let appName: String
    let processCount: Int
    let releasesOtherSessions: Bool?
    let gracePeriodMs: Int
    let confirmArgs: [String]
    let forceArgs: [String]
    let cancelArgs: [String]

    var offersForce: Bool { !forceArgs.isEmpty }
    /// Whole seconds of the normal-quit wait, rounded up.
    var gracePeriodSeconds: Int { max(0, (gracePeriodMs + 999) / 1000) }

    func args(force: Bool) -> [String] { force && offersForce ? forceArgs : confirmArgs }
}

nonisolated struct V2RuntimeSteerRequest: Encodable, Hashable {
    let content: String
    let attachments: [V2AttachmentSendReference]
    let clientMessageId: String?
}
