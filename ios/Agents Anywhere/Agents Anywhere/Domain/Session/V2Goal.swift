import Foundation

nonisolated struct V2Goal: Decodable, Identifiable {
  let id: String
  let objective: String
  let status: String
  let createdAt: String
  let updatedAt: String
  let lastReason: String?
  let timeUsedSeconds: Int?
  let tokensUsed: Int?
  let tokenBudget: Int?
  let sourceTurnId: String?
}
nonisolated struct V2GoalCapabilities: Decodable {
  let supported: Bool?
  let actions: [String]?
  let reason: String?
}
nonisolated struct V2GoalState: Decodable {
  let sessionId: String
  let revision: Int?
  let pendingOperationId: String?
  let freshness: String?
  let goal: V2Goal?
  let lastOutcome: V2Goal?
  let capabilities: V2GoalCapabilities?
}
nonisolated struct V2GoalRequest: Encodable {
  var operationId = UUID().uuidString
  let expectedRevision: Int
  let action: String
  var objective: String? = nil
  var attachments: [V2AttachmentSendReference] = []
}
nonisolated struct V2GoalResponse: Decodable {
  let operationId: String
  let ok: Bool
  let outcome: String
  let message: String?
  let state: V2GoalState?
}

nonisolated struct V2GoalCreationIntent: Encodable, Hashable {
  var mode = "goal"
  let operationId: String
}
