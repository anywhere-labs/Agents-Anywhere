import Foundation

/// Compile together with ClientCore sources; this exercises the actual model and
/// failure classifier with controlled HTTP responses, without an iOS simulator.
@MainActor private final class WorkflowProbeTransport: HTTPTransport {
    var phase = "outcome_unknown"
    var accepted: Bool?
    func workflow() throws -> Data {
        var state: [String: Any] = ["phase": phase, "revision": 1, "interactions": []]
        if let accepted { state["messageAccepted"] = accepted }
        return try JSONSerialization.data(withJSONObject: [
            "protocolVersion": "1.0", "id": "create", "kind": "creation",
            "connectorId": "connector", "runtimeId": "pi", "projectId": "project", "sessionId": "session", "state": state,
        ])
    }
    func send<Body: Encodable, Response: Decodable>(_ request: HTTPRequest<Body, Response>) async throws -> Response {
        guard request.path.hasPrefix("/runtime-workflows/") else {
            throw HTTPError.server(statusCode: 404, message: "metadata unavailable", detail: nil)
        }
        return try JSONDecoder().decode(Response.self, from: workflow())
    }
    func upload<Response: Decodable>(_ request: HTTPUploadRequest<Response>) async throws -> Response { throw HTTPError.invalidResponse }
    func download(_ url: URL) async throws -> URL { throw HTTPError.invalidResponse }
}

@main private enum RuntimeWorkflowProbe {
    @MainActor static func main() async throws {
        let transport = WorkflowProbeTransport()
        let url = URL(string: "https://workflow-probe.invalid")!
        let suite = "aa-pi-workflow-probe-\(UUID().uuidString)", account = "probe"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let key = "aa.native.new-session.v1." + Data((url.absoluteString + "\n" + account).utf8).base64EncodedString()
        let api = V2ConnectorAPI(transport: transport)
        func model() throws -> NewSessionModel {
            defaults.set(try JSONEncoder().encode(NewSessionPreference(pendingWorkflowIDs: ["create"], draftText: "retained draft")), forKey: key)
            return NewSessionModel(scope: .init(serverURL: url, accountID: account), devices: .init(connectorAPI: api),
                preparation: .init(connectorAPI: api), creation: .init(sessionAPI: V2SessionAPI(transport: transport)),
                projectAPI: V2ProjectAPI(transport: transport), defaults: defaults, workflowAPI: .init(transport: transport))
        }
        for phase in ["failed", "rejected", "cancelled", "expired"] {
            transport.phase = "outcome_unknown"; transport.accepted = nil
            let value = try model()
            _ = await value.resumeWorkflow()
            precondition(value.creationUncertain && value.hasPendingWorkflow)
            transport.phase = phase; transport.accepted = false
            let failure = V2RuntimeWorkflowFailure(workflow: try JSONDecoder().decode(V2RuntimeWorkflow.self, from: transport.workflow()))
            precondition(V2ClientFailure.isDefiniteWriteRejection(failure))
            precondition(V2ClientFailure(failure).kind == .rejected)
            _ = await value.resumeWorkflow()
            precondition(!value.creationUncertain && !value.hasPendingWorkflow)
            precondition(value.draft.text == "retained draft")
            value.invalidate()
        }
        transport.phase = "failed"; transport.accepted = true
        let accepted = try model()
        let failure = V2RuntimeWorkflowFailure(workflow: try JSONDecoder().decode(V2RuntimeWorkflow.self, from: transport.workflow()))
        precondition(!V2ClientFailure.isDefiniteWriteRejection(failure))
        _ = await accepted.resumeWorkflow()
        precondition(accepted.creationUncertain && accepted.hasPendingWorkflow, "missing metadata after acceptance cannot authorize another creation")
        accepted.invalidate()
        print("iOS actual NewSessionModel: definite rejection/cancellation releases uncertainty and retains draft; unknown/accepted-with-missing-metadata keeps the operation reference: passed")
    }
}
