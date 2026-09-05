import Foundation

/// Generic action forms cover native scalar fields, nested objects and enum
/// arrays. The standardized inputRequest component owns its richer question UI.
/// Unknown schema constraints are surfaced, never replaced by an empty payload.
struct NoticeActionForm {
    struct Field: Identifiable {
        let path: [String]
        let title: String
        let detail: String?
        let kind: Kind
        let defaultValue: JSONValue?
        var id: String { (try? JSONEncoder().encode(path)).flatMap { String(data: $0, encoding: .utf8) } ?? "" }
    }
    enum Kind {
        case text(secure: Bool), boolean, number, choice([JSONValue]), choices([JSONValue])
    }
    let schema: JSONValue
    let fields: [Field]

    init?(schema: JSONValue, uiSchema: JSONValue?) {
        guard schema["type"]?.stringValue == "object" else { return nil }
        var fields: [Field] = []
        guard Self.read(schema, ui: uiSchema, path: [], fields: &fields) else { return nil }
        self.schema = schema; self.fields = fields
    }

    func payload(_ values: [String: JSONValue]) -> JSONValue? {
        var result = JSONValue.object([:])
        for field in fields {
            var value = values[field.id] ?? field.defaultValue
            if case .boolean = field.kind, value == nil { value = .bool(false) }
            if case .number = field.kind, case let .string(raw) = value {
                guard let number = Double(raw), number.isFinite else {
                    if raw.isEmpty { continue }; return nil
                }
                value = .number(number)
            }
            if let value { result = Self.inserting(value, at: field.path, into: result) }
        }
        return Self.valid(result, schema: schema) ? result : nil
    }

    private static func read(_ schema: JSONValue, ui: JSONValue?, path: [String], fields: inout [Field]) -> Bool {
        guard path.count < 8, case let .object(properties) = schema["properties"] else { return false }
        let permitted: Set<String> = ["type", "title", "description", "properties", "required", "additionalProperties", "$schema"]
        guard keys(schema).isSubset(of: permitted), schema["additionalProperties"] == nil || schema["additionalProperties"] == .bool(false) else { return false }
        for key in properties.keys.sorted() {
            guard let value = properties[key] else { continue }
            if value["type"]?.stringValue == "object" {
                guard read(value, ui: ui?[key], path: path + [key], fields: &fields) else { return false }
                continue
            }
            let allowed: Set<String> = ["type", "title", "description", "default", "enum", "minLength", "maxLength", "pattern",
                "minimum", "maximum", "items", "minItems", "maxItems", "uniqueItems"]
            guard keys(value).isSubset(of: allowed) else { return false }
            let kind: Kind
            if let options = value["enum"]?.arrayValue { kind = .choice(options) }
            else {
                switch value["type"]?.stringValue {
                case "string": kind = .text(secure: ["password", "secure"].contains(ui?[key]?["component"]?.stringValue ?? ""))
                case "boolean": kind = .boolean
                case "integer", "number": kind = .number
                case "array":
                    guard let options = value["items"]?["enum"]?.arrayValue else { return false }
                    kind = .choices(options)
                default: return false
                }
            }
            fields.append(.init(path: path + [key], title: value["title"]?.stringValue ?? key,
                detail: value["description"]?.stringValue, kind: kind, defaultValue: value["default"]))
        }
        return true
    }

    private static func keys(_ value: JSONValue) -> Set<String> {
        if case let .object(object) = value { return Set(object.keys) }
        return []
    }
    private static func inserting(_ value: JSONValue, at path: [String], into object: JSONValue) -> JSONValue {
        guard let key = path.first else { return value }
        var result: [String: JSONValue]
        if case let .object(existing) = object { result = existing } else { result = [:] }
        result[key] = inserting(value, at: Array(path.dropFirst()), into: result[key] ?? .object([:]))
        return .object(result)
    }
    private static func valid(_ value: JSONValue, schema: JSONValue) -> Bool {
        if let options = schema["enum"]?.arrayValue, !options.contains(value) { return false }
        switch (schema["type"]?.stringValue, value) {
        case ("object", let .object(object)):
            let required = schema["required"]?.arrayValue?.compactMap(\.stringValue) ?? []
            guard required.allSatisfy({ object[$0] != nil }) else { return false }
            for (key, item) in object {
                guard let child = schema["properties"]?[key], valid(item, schema: child) else { return false }
            }
            return true
        case ("string", let .string(text)):
            if let min = number(schema["minLength"]), Double(text.unicodeScalars.count) < min { return false }
            if let max = number(schema["maxLength"]), Double(text.unicodeScalars.count) > max { return false }
            if let pattern = schema["pattern"]?.stringValue, text.range(of: pattern, options: .regularExpression) == nil { return false }
            return true
        case ("number", let .number(value)), ("integer", let .number(value)):
            if schema["type"] == .string("integer"), value.rounded() != value { return false }
            return value.isFinite && number(schema["minimum"]).map { value >= $0 } != false
                && number(schema["maximum"]).map { value <= $0 } != false
        case ("boolean", .bool): return true
        case ("array", let .array(items)):
            guard let itemSchema = schema["items"] else { return false }
            if schema["uniqueItems"] == .bool(true), Set(items).count != items.count { return false }
            return number(schema["minItems"]).map { Double(items.count) >= $0 } != false
                && number(schema["maxItems"]).map { Double(items.count) <= $0 } != false
                && items.allSatisfy { valid($0, schema: itemSchema) }
        case (nil, _): return schema["enum"]?.arrayValue?.contains(value) == true
        default: return false
        }
    }
    private static func number(_ value: JSONValue?) -> Double? {
        if case let .number(number) = value { return number }; return nil
    }
}
