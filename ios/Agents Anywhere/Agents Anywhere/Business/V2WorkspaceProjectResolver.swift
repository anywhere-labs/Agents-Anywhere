import Foundation

struct V2WorkspaceProjectResolver {
    let api: V2ProjectAPI

    func confirmed(_ initial: V2ProjectOperation) async throws -> V2Project {
        var operation = initial
        for _ in 0..<20 {
            if let project = operation.project {
                try? await api.acknowledge(operation.operationId)
                try Task.checkCancellation()
                return project
            }
            if operation.status == "failed" {
                throw V2BusinessError.workspaceFilesUnavailable(message: operation.message ?? String(localized: "原生结果尚未确认"))
            }
            try await Task.sleep(for: .milliseconds(500))
            operation = try await api.operation(operation.operationId)
        }
        if let project = operation.project {
                try? await api.acknowledge(operation.operationId)
                try Task.checkCancellation()
                return project
            }
        throw V2BusinessError.workspaceFilesUnavailable(message: operation.status == "succeeded"
            ? String(localized: "已创建，正在同步；请稍后刷新项目列表")
            : String(localized: "原生创建结果尚未确认，请稍后核对"))
    }

    func resolve(projects: [V2Project], connectorID: String, path: String, deviceOS: String?,
                 runtime: V2DeviceRuntime? = nil, projectID: String? = nil,
                 requestID: String = UUID().uuidString, validate: () throws -> Void = {}) async throws -> V2Project {
        try validate()
        guard let runtime else { throw V2BusinessError.workspaceFilesUnavailable(message: String(localized: "请选择 Runtime 实例")) }
        if let projectID {
            guard let project = projects.first(where: { $0.id == projectID && $0.connectorId == connectorID && $0.runtimeId == runtime.id && $0.sourceState == "active" }) else {
                throw V2BusinessError.workspaceFilesUnavailable(message: String(localized: "所选项目不可用，请刷新"))
            }
            return project
        }
        if projects.contains(where: { $0.connectorId == connectorID && $0.runtimeId == runtime.id
            && ProjectWorkspacePath.key($0.workspacePath, deviceOS: deviceOS) == ProjectWorkspacePath.key(path, deviceOS: deviceOS) }) {
            throw V2BusinessError.workspaceFilesUnavailable(message: String(localized: "该目录已有项目，请从项目列表明确选择"))
        }
        return try await confirmed(try await api.create(.init(name: ProjectWorkspacePath.name(path), connectorId: connectorID,
            workspacePath: path, runtime: runtime.runtimeType, runtimeId: runtime.id, requestId: requestID)))
    }
}
