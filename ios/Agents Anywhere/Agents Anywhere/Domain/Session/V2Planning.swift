import Foundation

nonisolated struct V2PlanDocument: Codable, Hashable, Identifiable {
    let planId: String
    let revision: Int
    let contentHash: String
    let title: String
    let markdown: String
    var id: String { "\(planId):\(revision)" }
}
nonisolated struct V2PlanDraft: Codable, Hashable { let draftId: String; let content: String; let contentState: String; let planId: String; let revision: Int }
nonisolated struct V2PlanExecution: Codable, Hashable { let status: String; let retryable: Bool? }
nonisolated struct V2PlanReview: Codable, Hashable { let reviewId: String; let planId: String; let planRevision: Int; let contentHash: String; let status: String }
nonisolated struct V2PlanningCapabilities: Codable, Hashable { let supported: Bool; let actions: [String] }
nonisolated struct V2PlanningState: Codable, Hashable {
    let sessionId: String
    let effectiveMode: String
    var freshness: String
    let epoch: String
    let revision: Int
    let draft: V2PlanDraft?
    let proposal: V2PlanDocument?
    let review: V2PlanReview?
    let execution: V2PlanExecution?
    var proposals: [V2PlanDocument]?
    var capabilities: V2PlanningCapabilities?
}
nonisolated struct V2PlanningRequest: Encodable {
    let command: String
    var operationId: String = UUID().uuidString
    var content: String? = nil
    var feedback: String? = nil
    var attachments: [V2AttachmentSendReference] = []
    var reviewId: String? = nil
    var planId: String? = nil
    var planRevision: Int? = nil
    var contentHash: String? = nil
    var expectedRevision: Int? = nil
    var epoch: String? = nil
}
nonisolated struct V2PlanningResponse: Decodable {
    let operationId: String
    let outcome: String
    let ok: Bool
    let message: String?
    let state: V2PlanningState?
}
nonisolated struct V2PlanningIntent: Encodable, Hashable { var mode = "plan"; let operationId: String }
nonisolated struct V2PlanningCommand {
    let command: String
    var content: String? = nil
    static func parse(_ text: String) -> Self? {
        let value = String(text.drop(while: { $0.isWhitespace }))
        guard value.hasPrefix("/plan") else { return nil }
        let suffix = value.dropFirst(5)
        guard suffix.isEmpty || suffix.first?.isWhitespace == true else { return nil }
        let token = String(suffix).trimmingCharacters(in: .whitespacesAndNewlines)
        let task = String(suffix.dropFirst())
        return token == "off" ? .init(command: "exit_plan") : token.isEmpty ? .init(command: "enter_plan") : .init(command: "submit_task", content: task)
    }
}

nonisolated struct V2PlanningReviewTarget: Identifiable { let state: V2PlanningState; var id: String { state.review?.reviewId ?? state.sessionId } }
