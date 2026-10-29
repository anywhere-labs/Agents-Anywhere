import Foundation

nonisolated enum AgentForm {
    static func defaults(_ schema: JSONValue) -> [String: JSONValue] {
        guard case let .object(fields) = schema["properties"] else { return [:] }
        let required: [JSONValue] = if case let .array(items) = schema["required"] { items } else { [] }
        return fields.reduce(into: [:]) { result, entry in
            let (key, field) = entry
            if let value = field["default"] { result[key] = value }
            else if required.contains(.string(key)) {
                switch field["type"]?.stringValue {
                case "boolean": result[key] = .bool(false)
                case "string" where field["enum"] == nil: result[key] = .string("")
                case "array": result[key] = .array([])
                default: break
                }
            }
        }
    }

    static func valid(_ schema: JSONValue, _ values: [String: JSONValue]) -> Bool {
        guard case let .object(fields) = schema["properties"] else { return false }
        if case let .array(required) = schema["required"], required.contains(where: { values[$0.stringValue ?? ""] == nil }) { return false }
        return values.allSatisfy { key, value in
            guard let field = fields[key] else { return false }
            switch (field["type"]?.stringValue, value) {
            case ("boolean", .bool): return true
            case let ("string", .string(text)):
                if case let .array(options) = field["enum"], !options.contains(value) { return false }
                return text.unicodeScalars.count >= (field["minLength"]?.intValue ?? 0) && text.unicodeScalars.count <= (field["maxLength"]?.intValue ?? Int.max)
            case let (type, .number(number)) where type == "integer" || type == "number":
                let min: Double = if case let .number(value) = field["minimum"] { value } else { -.infinity }
                let max: Double = if case let .number(value) = field["maximum"] { value } else { .infinity }
                return number.isFinite && number >= min && number <= max && (type != "integer" || number.rounded() == number)
            case let ("array", .array(items)):
                return items.count >= (field["minItems"]?.intValue ?? 0) && items.count <= (field["maxItems"]?.intValue ?? Int.max)
            default: return false
            }
        }
    }

    static func configurationSchema(_ snapshot: JSONValue, includeModel: Bool = false) -> JSONValue {
        guard case let .array(options) = snapshot["options"] else { return .object(["type": .string("object"), "properties": .object([:])]) }
        var fields: [String: JSONValue] = [:]
        for option in options where includeModel || option["category"] != .string("model") {
            guard let id = option["configId"]?.stringValue ?? option["id"]?.stringValue else { continue }
            var field: [String: JSONValue] = ["type": .string(option["type"] == .string("boolean") ? "boolean" : "string"), "title": option["name"] ?? .string(id)]
            field["default"] = option["currentValue"]
            if case let .array(groups) = option["options"] {
                let choices = groups.flatMap { group -> [JSONValue] in if case let .array(items) = group["options"] { return items }; return [group] }
                field["enum"] = .array(choices.compactMap { $0["value"] })
                field["enumNames"] = .array(choices.compactMap { $0["name"] })
            }
            fields[id] = .object(field)
        }
        return .object(["type": .string("object"), "properties": .object(fields)])
    }
}
