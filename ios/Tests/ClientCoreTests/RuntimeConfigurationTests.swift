import Foundation
import Observation
import SwiftUI
import Synchronization
import Testing
@testable import ClientCore

@Suite @MainActor struct RuntimeConfigurationTests {
    private func schema(named: Bool = false) throws -> V2RuntimeConfigSchema {
        let url = Bundle.module.url(forResource: "codex-config-schema", withExtension: "json", subdirectory: "Fixtures")!
        let source = try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: url))
        return try .init(schema: source, uiSchema: .object([
            "order": .array(["useSystemCodex", "codexExecutablePath", "codexHome", "modelGateway", "environment", "customModels"].map(JSONValue.string)),
            "modelGateway": .object(["component": .string("modelGateway")]),
            "environment": .object(["component": .string("keyValue")]),
            "customModels": .object(["component": .string("customModels")]),
            "requiredForNamedInstance": .array([.string("codexHome")]),
        ]), defaults: ["useSystemCodex": .bool(true), "environment": .object([:]), "customModels": .array([])], requiresNamedInstance: named)
    }

    @Test func realSchemaUsesStructuredEditorsAndWebTranslationKeys() throws {
        let value = try schema()
        #expect(value.fields.map(\.id) == ["useSystemCodex", "codexExecutablePath", "codexHome", "modelGateway", "environment", "customModels"])
        #expect(value.fields[3].kind == .modelGateway)
        #expect(value.fields[4].kind == .keyValue)
        #expect(value.fields[5].kind == .customModels)
        #expect(value.fields[0].translationKey("labelKey")?.hasPrefix("dashboard.device.runtimeConfigFields.") == true)
        #expect(try value.forNamedInstance().fields.first { $0.id == "codexHome" }?.isRequired == true)
    }

    @Test func gatewayCanBeOmittedButIncompleteOrMalformedGatewaysFail() throws {
        let draft = RuntimeConfigurationModel(schema: try schema(), config: nil)
        #expect(try draft.makeConfig()["modelGateway"] == nil)
        draft.gateways["modelGateway"] = .init(baseURL: "https://gateway.example/v1", apiKey: "secret")
        #expect(try draft.makeConfig()["modelGateway"] == .object(["baseUrl": .string("https://gateway.example/v1"), "apiKey": .string("secret")]))
        draft.gateways["modelGateway"]?.apiKey = ""
        #expect(throws: RuntimeConfigurationValidationError.self) { try draft.makeConfig() }
        #expect(draft.errors["modelGateway"] != nil)
        #expect(draft.gateways["modelGateway"]?.baseURL == "https://gateway.example/v1")
        draft.gateways["modelGateway"] = .init(baseURL: "file:///tmp/gateway", apiKey: "secret")
        #expect(throws: RuntimeConfigurationValidationError.self) { try draft.makeConfig() }
        draft.gateways["modelGateway"] = .init()
        #expect(try draft.makeConfig()["modelGateway"] == nil)
    }

    @Test func environmentRetainsUnsetEmptyAndEqualsWithoutTextParsing() throws {
        let config: JSONValue = .object(["environment": .object(["UNSET": .null, "EMPTY": .string(""), "TOKEN": .string("a=b=c")]), "futureField": .number(12)])
        let draft = RuntimeConfigurationModel(schema: try schema(), config: config)
        let value = try draft.makeConfig()
        #expect(value["environment"] == config["environment"])
        #expect(value["futureField"] == .number(12))
        draft.environments["environment"]?.append(.init(key: " TOKEN ", value: "duplicate"))
        #expect(throws: RuntimeConfigurationValidationError.self) { try draft.makeConfig() }
        #expect(draft.environments["environment"]?.count == 4)
    }

    @Test func customModelsPreserveEffortsAndRejectDuplicatesOrMissingNames() throws {
        let draft = RuntimeConfigurationModel(schema: try schema(), config: nil)
        let model = RuntimeCustomModelRow(modelID: " model-one ", displayName: "Model One", efforts: [.init(effortID: "high", displayName: "High")])
        draft.customModels["customModels"] = [model, .init()]
        let result = try draft.makeConfig()["customModels"]?.configArray
        #expect(result?.count == 1)
        #expect(result?.first?["modelId"] == .string("model-one"))
        #expect(result?.first?["efforts"]?.configArray?.count == 1)
        draft.customModels["customModels"] = [model, model]
        #expect(throws: RuntimeConfigurationValidationError.self) { try draft.makeConfig() }
        draft.customModels["customModels"] = [.init(modelID: "id")]
        #expect(throws: RuntimeConfigurationValidationError.self) { try draft.makeConfig() }
        draft.customModels["customModels"] = [.init(modelID: "id", displayName: "Name", efforts: [.init(effortID: "low", displayName: "Low"), .init(effortID: "low", displayName: "Low")])]
        #expect(throws: RuntimeConfigurationValidationError.self) { try draft.makeConfig() }
    }

    @Test func resetPreservesOnlyNamedInstanceRequiredConfiguration() throws {
        let original: JSONValue = .object(["codexHome": .string("/work/codex"), "useSystemCodex": .bool(false)])
        let named = RuntimeConfigurationModel(schema: try schema(named: true), config: original)
        named.textValues["codexHome"] = "/edited"
        named.resetDefaults()
        #expect(named.textValues["codexHome"] == "/work/codex")
        #expect(try named.makeConfig()["useSystemCodex"] == .bool(true))
        let basic = RuntimeConfigurationModel(schema: try schema(), config: original)
        basic.resetDefaults()
        #expect(try basic.makeConfig()["codexHome"] == nil)
    }

    @Test func deviceSelectionCannotEscapeCurrentConnectorOrProject() throws {
        var first = try snapshot().session
        first.projectId = "a"
        var second = try snapshot(id: "second").session
        second.projectId = "b"
        let model = DeviceManagementModel()
        model.updateSessions(connectorId: first.connectorId, allSessions: [first, second])
        model.selectProject("a")
        model.toggleSessionSelection(second.id)
        #expect(model.selectedSessionIds.isEmpty)
        model.toggleSelectAll()
        #expect(model.selectedSessionIds == [first.id])
        model.selectProject("b")
        #expect(model.selectedSessionIds.isEmpty)
        model.toggleSelectAll()
        model.updateSessions(connectorId: "different-device", allSessions: [first, second])
        #expect(model.sessions.isEmpty && model.selectedSessionIds.isEmpty)
    }

    @Test func unsavedDraftTracksIncompleteFieldsAndIgnoresRowIdentity() throws {
        let config: JSONValue = .object(["environment": .object(["TOKEN": .string("value")])])
        let draft = RuntimeConfigurationModel(schema: try schema(), config: config)
        #expect(!draft.hasChanges)
        draft.environments["environment"] = [.init(key: "TOKEN", value: "value")]
        #expect(!draft.hasChanges)
        draft.gateways["modelGateway"]?.baseURL = "https://incomplete.example"
        #expect(draft.hasChanges)
        #expect(throws: RuntimeConfigurationValidationError.self) { try draft.makeConfig() }
        #expect(draft.hasChanges)
        draft.gateways["modelGateway"]?.baseURL = ""
        #expect(!draft.hasChanges)
        draft.resetDefaults()
        #expect(draft.hasChanges)
        let defaults = RuntimeConfigurationModel(schema: try schema(), config: nil)
        defaults.resetDefaults()
        #expect(!defaults.hasChanges)
    }

    @Test func emptyRowsCanBeDeletedWhileNativeFieldBindingsAreStillAlive() throws {
        let draft = RuntimeConfigurationModel(schema: try schema(), config: nil)
        for _ in 0..<20 {
            @Bindable var variable = RuntimeEnvironmentRow()
            @Bindable var model = RuntimeCustomModelRow()
            @Bindable var effort = RuntimeEffortRow()
            draft.environments["environment", default: []].append(variable)
            draft.customModels["customModels", default: []].append(model)
            model.efforts.append(effort)
            let variableInput = $variable.key
            let modelInput = $model.modelID
            let effortInput = $effort.effortID

            model.removeEffort(effort.id)
            draft.removeCustomModel(model.id, fieldID: "customModels")
            draft.removeEnvironmentRow(variable.id, fieldID: "environment")
            // UIKit may finish an edit as its row disappears. These bindings
            // must remain safe without recreating the removed configuration.
            variableInput.wrappedValue = "LATE_EDIT"
            modelInput.wrappedValue = "late-model"
            effortInput.wrappedValue = "late-effort"
            #expect(variableInput.wrappedValue == "LATE_EDIT")
            #expect(modelInput.wrappedValue == "late-model")
            #expect(effortInput.wrappedValue == "late-effort")
            #expect(!draft.hasChanges)
            let config = try draft.makeConfig()
            #expect(config["environment"] == .object([:]))
            #expect(config["customModels"] == .array([]))
        }
    }

    @Test func deletingEarlierRowsDoesNotRetargetSurvivingFieldBindings() throws {
        let draft = RuntimeConfigurationModel(schema: try schema(), config: nil)
        let removedVariable = RuntimeEnvironmentRow()
        @Bindable var variable = RuntimeEnvironmentRow(key: "KEEP", value: "before")
        draft.environments["environment"] = [removedVariable, variable]
        let variableInput = $variable.value

        let removedModel = RuntimeCustomModelRow()
        let removedEffort = RuntimeEffortRow()
        @Bindable var effort = RuntimeEffortRow(effortID: "high", displayName: "High")
        @Bindable var model = RuntimeCustomModelRow(modelID: "keep", displayName: "Before", efforts: [removedEffort, effort])
        draft.customModels["customModels"] = [removedModel, model]
        let modelInput = $model.displayName
        let effortInput = $effort.displayName

        draft.removeEnvironmentRow(removedVariable.id, fieldID: "environment")
        draft.removeCustomModel(removedModel.id, fieldID: "customModels")
        model.removeEffort(removedEffort.id)
        variableInput.wrappedValue = "after"
        modelInput.wrappedValue = "After"
        effortInput.wrappedValue = "More reasoning"

        let config = try draft.makeConfig()
        #expect(config["environment"] == .object(["KEEP": .string("after")]))
        let models = try #require(config["customModels"]?.configArray)
        #expect(models.count == 1)
        #expect(models[0]["modelId"] == .string("keep"))
        #expect(models[0]["displayName"] == .string("After"))
        #expect(models[0]["efforts"]?.configArray == [.object([
            "effortId": .string("high"), "displayName": .string("More reasoning")
        ])])
    }

    @Test func resettingConfigurationDetachesAllPreviouslyBoundRows() throws {
        let draft = RuntimeConfigurationModel(schema: try schema(), config: nil)
        @Bindable var variable = RuntimeEnvironmentRow(key: "TOKEN", value: "before")
        @Bindable var effort = RuntimeEffortRow(effortID: "high", displayName: "High")
        @Bindable var model = RuntimeCustomModelRow(modelID: "before", displayName: "Before", efforts: [effort])
        draft.environments["environment"] = [variable]
        draft.customModels["customModels"] = [model]
        let variableInput = $variable.value
        let modelInput = $model.displayName
        let effortInput = $effort.displayName
        draft.resetDefaults()
        let reset = try draft.makeConfig()
        variableInput.wrappedValue = "late value"
        modelInput.wrappedValue = "Late model"
        effortInput.wrappedValue = "Late effort"
        #expect(try draft.makeConfig() == reset)
        #expect(!draft.hasChanges)
    }

    @Test func editsInsideRowObjectsStillNotifyTheUnsavedChangesObserver() throws {
        let draft = RuntimeConfigurationModel(schema: try schema(), config: .object([
            "customModels": .array([.object([
                "modelId": .string("model"), "displayName": .string("Model"),
                "efforts": .array([.object(["effortId": .string("high"), "displayName": .string("High")])])
            ])])
        ]))
        let changed = Mutex(false)
        withObservationTracking { _ = draft.hasChanges } onChange: { changed.withLock { $0 = true } }
        let effort = try #require(draft.customModels["customModels"]?.first?.efforts.first)
        effort.displayName = "More reasoning"
        #expect(changed.withLock { $0 })
        #expect(draft.hasChanges)
        effort.displayName = "High"
        #expect(!draft.hasChanges)
    }
}
