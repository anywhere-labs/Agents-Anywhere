import SwiftUI

struct StructuredAgentFields: View {
    let schema: JSONValue
    @Binding var values: [String: JSONValue]
    var disabled = false
    private var fields: [String: JSONValue] { if case let .object(fields) = schema["properties"] { return fields }; return [:] }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(fields.keys.sorted(), id: \.self) { key in
                if let field = fields[key] {
                    let title = field["title"]?.stringValue ?? key
                    VStack(alignment: .leading, spacing: 6) {
                        Text(title).font(.subheadline)
                        if let description = field["description"]?.stringValue { Text(description).font(.caption) }
                        if field["type"] == .string("boolean") {
                            Toggle(title, isOn: Binding(get: { values[key] == .bool(true) }, set: { values[key] = .bool($0) }))
                        } else if case let .array(options) = field["enum"] {
                            Picker(title, selection: Binding(get: { values[key]?.stringValue ?? "" }, set: { values[key] = .string($0) })) {
                                Text("请选择").tag("")
                                ForEach(options.indices, id: \.self) { index in Text(label(field, index, options[index])).tag(options[index].stringValue ?? "") }
                            }
                        } else if field["type"] == .string("array"), case let .array(options) = field["items"]?["enum"] {
                            ForEach(options, id: \.self) { item in
                                Toggle(item.stringValue ?? "", isOn: Binding(get: { array(key).contains(item) }, set: { checked in values[key] = .array(checked ? array(key) + [item] : array(key).filter { $0 != item }) }))
                            }
                        } else {
                            TextField(title, text: Binding(get: { values[key]?.stringValue ?? "" }, set: { text in
                                if field["type"] == .string("number") || field["type"] == .string("integer") {
                                    if text.isEmpty { values.removeValue(forKey: key) }
                                    else if let number = Double(text), number.isFinite { values[key] = .number(number) }
                                    else { values[key] = .string(text) }
                                } else { values[key] = .string(text) }
                            }))
                        }
                    }
                }
            }
        }.disabled(disabled)
    }
    private func array(_ key: String) -> [JSONValue] { if case let .array(items) = values[key] { return items }; return [] }
    private func label(_ field: JSONValue, _ index: Int, _ value: JSONValue) -> String {
        if case let .array(names) = field["enumNames"], names.indices.contains(index) { return names[index].stringValue ?? "" }
        return value.stringValue ?? ""
    }
}
