import Foundation
import Testing
@testable import ClientCore

func fixtureData(_ name: String) throws -> Data {
    let url = Bundle.module.url(forResource: "backend", withExtension: "json", subdirectory: "Fixtures")!
    let root = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [String: Any]
    return try JSONSerialization.data(withJSONObject: root[name]!)
}

func fixture<Value: Decodable>(_ name: String, as: Value.Type = Value.self) throws -> Value {
    try JSONDecoder().decode(Value.self, from: fixtureData(name))
}

@Test @MainActor func backendResponsesDecode() throws {
    let snapshot: V2SessionSnapshot = try fixture("snapshot")
    #expect(snapshot.session.runtimeId == "rti_work")
    #expect(snapshot.state?.runtimeId == "rti_work")
    #expect(snapshot.state?.selections.keys.contains(.effort) == true)
    #expect(snapshot.timeline.items.first?.content == .message(V2MessageContent(rawContent: .object(["text": .string("Hello")]))))
    let types: V2RuntimeTypeListResponse = try fixture("runtimeTypes")
    let runtimes: V2DeviceRuntimeListResponse = try fixture("runtimes")
    #expect(V2RuntimeInventory(types: types.runtimeTypes, instances: runtimes.runtimes).canAdd(types.runtimeTypes[0]))
    let command: V2RuntimeCommandListResponse = try fixture("commands")
    #expect(command.commands.first?.argsSchema != nil)
    let _: V2WorkspaceDirectoryResponse = try fixture("rpcError")
    let _: V2AttachmentUploadResponse = try fixture("upload")
    let _: V2AttachmentDownload = try fixture("download")
    let _: V2DashboardSnapshot = try fixture("dashboard")
    let _: V2EventRecoveryResponse = try fixture("recovery")
    let _: AuthMe = try fixture("profile")
}
