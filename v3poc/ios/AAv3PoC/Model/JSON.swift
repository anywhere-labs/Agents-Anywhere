import Foundation

/// A JSON value. The host forwards watch events to the renderer unchanged, so native code only reads the few fields
/// it needs (`type`, message `id` / `seq` / `parts[0]`, control `state` / `pending` / `usage`, session `config`).
nonisolated enum JSON: Equatable, Sendable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSON])
    case object([String: JSON])

    subscript(key: String) -> JSON? {
        get { if case let .object(object) = self { object[key] } else { nil } }
        set {
            guard case var .object(object) = self else { return }
            object[key] = newValue
            self = .object(object)
        }
    }

    subscript(index: Int) -> JSON? {
        guard case let .array(array) = self, array.indices.contains(index) else { return nil }
        return array[index]
    }

    var string: String? { if case let .string(value) = self { value } else { nil } }
    var double: Double? { if case let .number(value) = self { value } else { nil } }
    var int: Int? { double.map { Int($0) } }
    var bool: Bool? { if case let .bool(value) = self { value } else { nil } }
    var array: [JSON]? { if case let .array(value) = self { value } else { nil } }
    var object: [String: JSON]? { if case let .object(value) = self { value } else { nil } }

    /// Replaces every string (recursively) through `transform`; used for the fixture's `$TURN` / `$X` placeholders.
    func mapStrings(_ transform: (String) -> String) -> JSON {
        switch self {
        case let .string(value): .string(transform(value))
        case let .array(values): .array(values.map { $0.mapStrings(transform) })
        case let .object(values): .object(values.mapValues { $0.mapStrings(transform) })
        default: self
        }
    }
}

extension JSON: ExpressibleByStringLiteral, ExpressibleByIntegerLiteral, ExpressibleByFloatLiteral,
    ExpressibleByBooleanLiteral, ExpressibleByArrayLiteral, ExpressibleByDictionaryLiteral, ExpressibleByNilLiteral {
    nonisolated init(stringLiteral value: String) { self = .string(value) }
    nonisolated init(integerLiteral value: Int) { self = .number(Double(value)) }
    nonisolated init(floatLiteral value: Double) { self = .number(value) }
    nonisolated init(booleanLiteral value: Bool) { self = .bool(value) }
    nonisolated init(arrayLiteral elements: JSON...) { self = .array(elements) }
    nonisolated init(dictionaryLiteral elements: (String, JSON)...) {
        self = .object(Dictionary(elements, uniquingKeysWith: { _, last in last }))
    }
    nonisolated init(nilLiteral: ()) { self = .null }
}

extension JSON: Codable {
    nonisolated init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() { self = .null }
        else if let value = try? container.decode(Bool.self) { self = .bool(value) }
        else if let value = try? container.decode(Double.self) { self = .number(value) }
        else if let value = try? container.decode(String.self) { self = .string(value) }
        else if let value = try? container.decode([JSON].self) { self = .array(value) }
        else { self = .object(try container.decode([String: JSON].self)) }
    }

    nonisolated func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case let .bool(value): try container.encode(value)
        case let .number(value):
            if value.rounded() == value, abs(value) < 9e15 { try container.encode(Int64(value)) }
            else { try container.encode(value) }
        case let .string(value): try container.encode(value)
        case let .array(value): try container.encode(value)
        case let .object(value): try container.encode(value)
        }
    }
}

extension JSON {
    /// From a WKScriptMessage body (NSDictionary / NSArray / NSNumber / NSString / NSNull).
    nonisolated init(any value: Any?) {
        switch value {
        case nil, is NSNull: self = .null
        case let number as NSNumber:
            if CFGetTypeID(number) == CFBooleanGetTypeID() { self = .bool(number.boolValue) }
            else { self = .number(number.doubleValue) }
        case let string as String: self = .string(string)
        case let array as [Any]: self = .array(array.map { JSON(any: $0) })
        case let dictionary as [String: Any]: self = .object(dictionary.mapValues { JSON(any: $0) })
        default: self = .null
        }
    }

    nonisolated func encodedString() -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.withoutEscapingSlashes]
        guard let data = try? encoder.encode(self) else { return "null" }
        return String(decoding: data, as: UTF8.self)
    }

    nonisolated static func decode(_ data: Data) throws -> JSON {
        try JSONDecoder().decode(JSON.self, from: data)
    }
}
