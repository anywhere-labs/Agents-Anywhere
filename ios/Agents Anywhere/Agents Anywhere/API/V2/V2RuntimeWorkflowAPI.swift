import Foundation

struct V2RuntimeWorkflowAPI {
    let transport: any HTTPTransport
    func operate(sessionID: String, operation: String, generation: String) async throws -> JSONValue {
        try await transport.send(HTTPRequest<JSONValue, JSONValue>(method: .post,
            path: "/runtime-workflows/sessions/\(sessionID.v2URLPathComponentEncoded)/operations",
            body: .object(["operation": .string(operation), "operationId": .string(UUID().uuidString),
                "expectedGeneration": .string(generation), "values": .object([:])])))
    }
    func recover(sessionID: String, generation: String, operationID: String = UUID().uuidString, sourceRevision: String? = nil) async throws -> JSONValue {
        var body: [String: JSONValue] = ["operationId": .string(operationID), "expectedGeneration": .string(generation)]
        if let sourceRevision { body["sourceRevision"] = .string(sourceRevision); body["cliExited"] = .bool(true) }
        return try await transport.send(HTTPRequest<JSONValue, JSONValue>(method: .post,
            path: "/runtime-workflows/sessions/\(sessionID.v2URLPathComponentEncoded)/recover",
            body: .object(body)))
    }
    func closeSession(sessionID: String, generation: String) async throws -> JSONValue {
        try await transport.send(HTTPRequest<JSONValue, JSONValue>(method: .post,
            path: "/runtime-workflows/sessions/\(sessionID.v2URLPathComponentEncoded)/close",
            body: .object(["closeOperationId": .string(UUID().uuidString), "ownerGeneration": .string(generation)])))
    }
    func configuration(sessionID: String) async throws -> JSONValue {
        try await transport.send(HTTPRequest<EmptyRequestBody, JSONValue>(method: .get, path: "/runtime-workflows/sessions/\(sessionID.v2URLPathComponentEncoded)/configuration"))
    }
    func updateConfiguration(sessionID: String, operationID: String, expectedRevision: Int, values: [String: JSONValue]) async throws -> JSONValue {
        try await transport.send(HTTPRequest<JSONValue, JSONValue>(method: .post, path: "/runtime-workflows/sessions/\(sessionID.v2URLPathComponentEncoded)/configuration", body: .object(["operationId": .string(operationID), "expectedRevision": .number(Double(expectedRevision)), "values": .object(values)])))
    }
    func components(connectorID: String, runtimeID: String, request: [String: JSONValue]) async throws -> JSONValue {
        try await transport.send(HTTPRequest<JSONValue, JSONValue>(method: .post, path: "/connectors/\(connectorID.v2URLPathComponentEncoded)/runtimes/\(runtimeID.v2URLPathComponentEncoded)/components", body: .object(request)))
    }
    func post(_ path: String, _ body: [String: JSONValue]) async throws -> V2RuntimeWorkflow {
        try await transport.send(HTTPRequest<JSONValue, V2RuntimeWorkflow>(method: .post, path: "/runtime-workflows/" + path, body: .object(body)))
    }
    func get(kind: String, id: String) async throws -> V2RuntimeWorkflow {
        try await transport.send(HTTPRequest<EmptyRequestBody, V2RuntimeWorkflow>(method: .get, path: "/runtime-workflows/\(kind)/\(id.v2URLPathComponentEncoded)"))
    }
    func get(_ value: V2RuntimeWorkflow) async throws -> V2RuntimeWorkflow {
        try await transport.send(HTTPRequest<EmptyRequestBody, V2RuntimeWorkflow>(method: .get, path: "/runtime-workflows/\(value.kind)/\(value.id.v2URLPathComponentEncoded)"))
    }
    func respond(_ value: V2RuntimeWorkflow, request: V2WorkflowInteraction, action: String, input: JSONValue?) async throws {
        var body: [String: JSONValue] = ["interactionId": .string(request.id), "ownerGeneration": .string(request.ownerGeneration),
            "requestRevision": .number(Double(request.requestRevision)), "responseOperationId": .string(UUID().uuidString), "actionId": .string(action)]
        if let input { body["input"] = input }
        let _: JSONValue = try await transport.send(HTTPRequest<JSONValue, JSONValue>(method: .post,
            path: "/runtime-workflows/\(value.kind)/\(value.id.v2URLPathComponentEncoded)/responses", body: .object(body)))
    }
}
