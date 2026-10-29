import Foundation

nonisolated struct V2RuntimeWorkflow: Decodable, Hashable, Identifiable {
    let protocolVersion: String
    let id: String
    let kind: String
    let connectorId: String
    let runtimeId: String
    let projectId: String
    let sessionId: String?
    let state: V2RuntimeWorkflowState
}

nonisolated struct V2RuntimeWorkflowState: Decodable, Hashable {
    let phase: String
    let revision: Int
    let catalogRevision: Int?
    let catalog: V2ModelCatalog?
    let configuration: JSONValue?
    let messageAccepted: Bool?
    let created: Bool?
    let interactions: [V2WorkflowInteraction]
    let canCancel: Bool?
    let canCancelInitialization: Bool?
    let failure: V2RuntimeError?
}

nonisolated struct V2RuntimeWorkflowFailure: Error, LocalizedError {
    let workflow: V2RuntimeWorkflow
    var definitelyNotAccepted: Bool {
        workflow.kind == "creation" && workflow.state.messageAccepted == false
            && ["failed", "rejected", "cancelled", "expired"].contains(workflow.state.phase)
    }
    var errorDescription: String? { workflow.state.failure?.message ?? workflow.state.phase }
}

nonisolated struct V2WorkflowInteraction: Decodable, Hashable, Identifiable {
    let interactionId: String
    let ownerGeneration: String
    let requestRevision: Int
    let kind: String
    let title: String
    let message: String?
    let status: String
    let metadata: JSONValue
    let actions: [V2RuntimeNoticeAction]
    var id: String { interactionId }
}
