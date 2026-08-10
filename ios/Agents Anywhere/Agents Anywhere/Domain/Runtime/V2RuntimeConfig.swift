import Foundation

struct V2RuntimeConfigSchema: Hashable {
    let fields: [V2RuntimeConfigField]

    init(schema: JSONValue, uiSchema: JSONValue) throws {
        guard case let .object(root) = schema else {
            throw V2BusinessError.invalidRuntimeConfigSchema
        }
        let properties = root.object(for: "properties") ?? [:]
        let requiredNames = Set(root.stringArray(for: "required"))
        let uiRoot = uiSchema.objectValue ?? [:]
        let preferredOrder = uiRoot.stringArray(for: "order")
        let remainingNames = properties.keys
            .filter { !preferredOrder.contains($0) }
            .sorted()
        let orderedNames = preferredOrder.filter { properties[$0] != nil } + remainingNames

        fields = try orderedNames.map { name in
            guard case let .object(fieldSchema) = properties[name] else {
                throw V2BusinessError.invalidRuntimeConfigSchema
            }
            let uiField = uiRoot[name]?.objectValue ?? [:]
            return V2RuntimeConfigField(
                id: name,
                title: fieldSchema.string(for: "title") ?? name,
                description: fieldSchema.string(for: "description"),
                isRequired: requiredNames.contains(name),
                defaultValue: fieldSchema["default"],
                kind: V2RuntimeConfigFieldKind(schema: fieldSchema, uiSchema: uiField)
            )
        }
    }

    func initialValues(config: JSONValue?) -> [String: JSONValue] {
        var values = config?.objectValue ?? [:]
        for field in fields where values[field.id] == nil {
            if let defaultValue = field.defaultValue {
                values[field.id] = defaultValue
            }
        }
        return values
    }
}

struct V2RuntimeConfigField: Identifiable, Hashable {
    let id: String
    let title: String
    let description: String?
    let isRequired: Bool
    let defaultValue: JSONValue?
    let kind: V2RuntimeConfigFieldKind
}

enum V2RuntimeConfigFieldKind: Hashable {
    case text(minLength: Int?, maxLength: Int?, secure: Bool)
    case boolean
    case number(integer: Bool, minimum: Double?, maximum: Double?)
    case choice([V2RuntimeConfigOption])
    case keyValue
    case json

    init(schema: [String: JSONValue], uiSchema: [String: JSONValue]) {
        if let options = schema.array(for: "enum"), !options.isEmpty {
            self = .choice(options.map(V2RuntimeConfigOption.init))
            return
        }

        let component = uiSchema.string(for: "component")
        switch schema.string(for: "type") {
        case "string":
            self = .text(
                minLength: schema.integer(for: "minLength"),
                maxLength: schema.integer(for: "maxLength"),
                secure: component == "password" || component == "secure"
            )
        case "boolean":
            self = .boolean
        case "integer":
            self = .number(
                integer: true,
                minimum: schema.number(for: "minimum"),
                maximum: schema.number(for: "maximum")
            )
        case "number":
            self = .number(
                integer: false,
                minimum: schema.number(for: "minimum"),
                maximum: schema.number(for: "maximum")
            )
        case "object" where component == "keyValue" || schema["additionalProperties"] != nil:
            self = .keyValue
        default:
            self = .json
        }
    }
}

struct V2RuntimeConfigOption: Identifiable, Hashable {
    let value: JSONValue

    var id: String {
        switch value {
        case let .string(value): "string:\(value)"
        case let .number(value): "number:\(value)"
        case let .bool(value): "bool:\(value)"
        case let .object(value): "object:\(value.hashValue)"
        case let .array(value): "array:\(value.hashValue)"
        case .null: "null"
        }
    }

    var title: String { value.displayString }
}

private extension JSONValue {
    var objectValue: [String: JSONValue]? {
        guard case let .object(value) = self else { return nil }
        return value
    }
}

private extension Dictionary where Key == String, Value == JSONValue {
    func string(for key: String) -> String? {
        guard case let .string(value) = self[key] else { return nil }
        return value
    }

    func number(for key: String) -> Double? {
        guard case let .number(value) = self[key] else { return nil }
        return value
    }

    func integer(for key: String) -> Int? {
        guard let value = number(for: key) else { return nil }
        return Int(value)
    }

    func object(for key: String) -> [String: JSONValue]? {
        guard case let .object(value) = self[key] else { return nil }
        return value
    }

    func array(for key: String) -> [JSONValue]? {
        guard case let .array(value) = self[key] else { return nil }
        return value
    }

    func stringArray(for key: String) -> [String] {
        array(for: key)?.compactMap { value in
            guard case let .string(string) = value else { return nil }
            return string
        } ?? []
    }
}
