import Foundation
import Observation

struct RuntimeEnvironmentRow: Identifiable, Equatable {
    var id = UUID()
    var key = ""
    var value = ""
    var removesInherited = false
}
struct RuntimeEffortRow: Identifiable, Equatable {
    var id = UUID()
    var effortID = ""
    var displayName = ""
}
struct RuntimeCustomModelRow: Identifiable, Equatable {
    var id = UUID()
    var modelID = ""
    var displayName = ""
    var efforts: [RuntimeEffortRow] = []
}
struct RuntimeGatewayDraft: Equatable {
    var baseURL = ""
    var apiKey = ""
}

/// The editable draft keeps row identities and incomplete text independently
/// from the JSON sent to the runtime. Reconnects do not replace this draft.
@MainActor @Observable
final class RuntimeConfigurationModel {
    let schema: V2RuntimeConfigSchema
    var textValues: [String: String] = [:]
    var boolValues: [String: Bool] = [:]
    var choiceValues: [String: JSONValue] = [:]
    var gateways: [String: RuntimeGatewayDraft] = [:]
    var environments: [String: [RuntimeEnvironmentRow]] = [:]
    var customModels: [String: [RuntimeCustomModelRow]] = [:]
    private(set) var errors: [String: String] = [:]
    private var original: [String: JSONValue]
    private var base: [String: JSONValue]

    init(schema: V2RuntimeConfigSchema, config: JSONValue?) {
        self.schema = schema
        let initial = schema.initialValues(config: config)
        original = initial
        base = initial
        load(initial)
    }

    func resetDefaults() {
        var values = schema.initialValues(config: nil)
        for field in schema.namedRequiredFields where schema.fields.contains(where: { $0.id == field && $0.isRequired }) {
            if let value = original[field] { values[field] = value }
        }
        base = values
        errors = [:]
        load(values)
    }

    func makeConfig() throws -> [String: JSONValue] {
        var result = base
        errors = [:]
        for field in schema.fields {
            switch field.kind {
            case .text:
                let value = textValues[field.id] ?? ""
                result[field.id] = value.isEmpty && !field.isRequired ? nil : .string(value)
            case .boolean:
                result[field.id] = .bool(boolValues[field.id] ?? false)
            case .choice:
                result[field.id] = choiceValues[field.id]
            case .number:
                let value = (textValues[field.id] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                if value.isEmpty { result[field.id] = nil }
                else if let number = Double(value), number.isFinite { result[field.id] = .number(number) }
                else { errors[field.id] = String(localized: "Enter a valid number.") }
            case .modelGateway:
                let draft = gateways[field.id] ?? .init()
                if draft.baseURL.isEmpty && draft.apiKey.isEmpty { result[field.id] = nil }
                else { result[field.id] = .object(["baseUrl": .string(draft.baseURL), "apiKey": .string(draft.apiKey)]) }
            case .keyValue:
                var values: [String: JSONValue] = [:]
                for row in environments[field.id] ?? [] {
                    let key = row.key.trimmingCharacters(in: .whitespacesAndNewlines)
                    guard !key.isEmpty else { continue }
                    if values[key] != nil { errors[field.id] = String(localized: "Variable names must be unique.") }
                    values[key] = row.removesInherited ? .null : .string(row.value)
                }
                result[field.id] = .object(values)
            case .customModels:
                var seen: Set<String> = []
                let rows: [JSONValue] = (customModels[field.id] ?? []).compactMap { row in
                    let modelID = row.modelID.trimmingCharacters(in: .whitespacesAndNewlines)
                    let name = row.displayName.trimmingCharacters(in: .whitespacesAndNewlines)
                    var effortIDs: Set<String> = []
                    let efforts: [JSONValue] = row.efforts.compactMap { effort in
                        let id = effort.effortID.trimmingCharacters(in: .whitespacesAndNewlines)
                        let title = effort.displayName.trimmingCharacters(in: .whitespacesAndNewlines)
                        if id.isEmpty && title.isEmpty { return nil }
                        if !effortIDs.insert(id).inserted { errors[field.id] = String(localized: "Reasoning effort IDs must be unique within a model.") }
                        return .object(["effortId": .string(id), "displayName": .string(title)])
                    }
                    if modelID.isEmpty && name.isEmpty && efforts.isEmpty { return nil }
                    if !seen.insert(modelID).inserted { errors[field.id] = String(localized: "Model IDs must be unique.") }
                    var value: [String: JSONValue] = ["modelId": .string(modelID), "displayName": .string(name)]
                    if !efforts.isEmpty { value["efforts"] = .array(efforts) }
                    return .object(value)
                }
                result[field.id] = .array(rows)
            case .json:
                let text = (textValues[field.id] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                if text.isEmpty { result[field.id] = nil }
                else if let data = text.data(using: .utf8), let value = try? JSONDecoder().decode(JSONValue.self, from: data) {
                    result[field.id] = value
                } else { errors[field.id] = String(localized: "Enter valid JSON.") }
            }
            if errors[field.id] == nil {
                if let value = result[field.id] {
                    errors[field.id] = RuntimeConfigValidation.error(value, schema: field.schema)
                } else if field.isRequired { errors[field.id] = String(localized: "This field is required.") }
            }
        }
        guard errors.isEmpty else { throw RuntimeConfigurationValidationError() }
        return result
    }

    private func load(_ values: [String: JSONValue]) {
        textValues = [:]; boolValues = [:]; choiceValues = [:]
        gateways = [:]; environments = [:]; customModels = [:]
        for field in schema.fields {
            let value = values[field.id]
            switch field.kind {
            case .text, .number: textValues[field.id] = value?.stringValue ?? ""
            case .boolean: if case let .bool(flag) = value { boolValues[field.id] = flag }
            case .choice: choiceValues[field.id] = value
            case .modelGateway:
                let object = value?.configObject ?? [:]
                gateways[field.id] = .init(baseURL: object["baseUrl"]?.stringValue ?? "", apiKey: object["apiKey"]?.stringValue ?? "")
            case .keyValue:
                environments[field.id] = (value?.configObject ?? [:]).sorted { $0.key < $1.key }.map { key, item in
                    .init(key: key, value: item == .null ? "" : item.stringValue ?? "", removesInherited: item == .null)
                }
            case .customModels:
                customModels[field.id] = (value?.configArray ?? []).map { item in
                    let object = item.configObject ?? [:]
                    return .init(modelID: object["modelId"]?.stringValue ?? "", displayName: object["displayName"]?.stringValue ?? "",
                        efforts: (object["efforts"]?.configArray ?? []).map { effort in
                            .init(effortID: effort.configObject?["effortId"]?.stringValue ?? "",
                                displayName: effort.configObject?["displayName"]?.stringValue ?? "")
                        })
                }
            case .json:
                if let value, let data = try? JSONEncoder.configPretty.encode(value) {
                    textValues[field.id] = String(decoding: data, as: UTF8.self)
                }
            }
        }
    }
}
struct RuntimeConfigurationValidationError: LocalizedError {
    var errorDescription: String? { String(localized: "Review the highlighted configuration fields.") }
}

enum RuntimeConfigValidation {
    static func error(_ value: JSONValue, schema: [String: JSONValue]) -> String? {
        for combinator in ["anyOf", "oneOf"] {
            if let alternatives = schema[combinator]?.configArray {
                let matches = alternatives.filter { error(value, schema: $0.configObject ?? [:]) == nil }.count
                if matches == 0 || (combinator == "oneOf" && matches != 1) { return String(localized: "The value has an unsupported type or format.") }
            }
        }
        let types = schema["type"]?.configArray?.compactMap(\.stringValue) ?? schema["type"]?.stringValue.map { [$0] } ?? []
        if !types.isEmpty && !types.contains(where: { matches(value, type: $0) }) {
            return String(localized: "The value has an unsupported type or format.")
        }
        if let options = schema["enum"]?.configArray, !options.contains(value) { return String(localized: "Choose one of the available options.") }
        switch value {
        case let .string(text):
            let count = Double(text.unicodeScalars.count)
            if let min = schema["minLength"]?.configNumber, count < min { return String(localized: "This field is required.") }
            if let max = schema["maxLength"]?.configNumber, count > max { return String(localized: "The value is too long.") }
            if let pattern = schema["pattern"]?.stringValue, text.range(of: pattern, options: .regularExpression) == nil {
                return String(localized: "Enter a value in the required format.")
            }
        case let .number(number):
            if !number.isFinite || schema["minimum"]?.configNumber.map({ number < $0 }) == true ||
                schema["maximum"]?.configNumber.map({ number > $0 }) == true { return String(localized: "The number is outside the allowed range.") }
        case let .array(items):
            if schema["minItems"]?.configNumber.map({ Double(items.count) < $0 }) == true ||
                schema["maxItems"]?.configNumber.map({ Double(items.count) > $0 }) == true { return String(localized: "The list has an invalid number of items.") }
            if schema["uniqueItems"] == .bool(true), Set(items).count != items.count { return String(localized: "List items must be unique.") }
            if let itemSchema = schema["items"]?.configObject {
                for item in items { if let message = error(item, schema: itemSchema) { return message } }
            }
        case let .object(object):
            let properties = schema["properties"]?.configObject ?? [:]
            for key in schema["required"]?.configArray?.compactMap(\.stringValue) ?? [] where object[key] == nil {
                return String(localized: "Complete all required fields in this group.")
            }
            for (key, child) in object {
                if let propertyNames = schema["propertyNames"]?.configObject,
                   let issue = error(.string(key), schema: propertyNames) { return issue }
                if let property = properties[key]?.configObject {
                    if let issue = error(child, schema: property) { return issue }
                } else if schema["additionalProperties"] == .bool(false) {
                    return String(localized: "This configuration contains an unsupported field.")
                } else if let extra = schema["additionalProperties"]?.configObject, let issue = error(child, schema: extra) { return issue }
            }
        default: break
        }
        return nil
    }
    private static func matches(_ value: JSONValue, type: String) -> Bool {
        switch (value, type) {
        case (.string, "string"), (.bool, "boolean"), (.object, "object"), (.array, "array"), (.null, "null"): true
        case let (.number(value), "integer"): value.isFinite && value.rounded() == value
        case (.number, "number"): true
        default: false
        }
    }
}
extension JSONValue {
    var configObject: [String: JSONValue]? { if case let .object(value) = self { value } else { nil } }
    var configArray: [JSONValue]? { if case let .array(value) = self { value } else { nil } }
    var configNumber: Double? { if case let .number(value) = self { value } else { nil } }
}
private extension JSONEncoder {
    static var configPretty: JSONEncoder {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys]; return encoder
    }
}
