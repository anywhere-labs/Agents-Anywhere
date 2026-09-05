import Foundation
import Observation
import SwiftUI

struct RuntimeConfigurationSheet: View {
    @Environment(\.dismiss) private var dismiss

    let runtime: V2DeviceRuntime
    let schema: V2RuntimeConfigSchema
    let startAfterSaving: Bool
    let onSave: ([String: JSONValue]) async throws -> Void

    @State private var model: RuntimeConfigurationModel
    @State private var isSaving = false
    @State private var errorMessage: String?

    init(
        runtime: V2DeviceRuntime,
        schema: V2RuntimeConfigSchema,
        startAfterSaving: Bool,
        onSave: @escaping ([String: JSONValue]) async throws -> Void
    ) {
        self.runtime = runtime
        self.schema = schema
        self.startAfterSaving = startAfterSaving
        self.onSave = onSave
        _model = State(initialValue: RuntimeConfigurationModel(schema: schema, config: runtime.config))
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    ForEach(schema.fields) { field in
                        RuntimeConfigurationFieldView(field: field, model: model)
                    }
                } header: {
                    Text(runtime.displayName)
                } footer: {
                    Text("Configuration is validated by the Agent runtime before it is saved.")
                }

                if let errorMessage {
                    Section {
                        Label(errorMessage, systemImage: "exclamationmark.triangle")
                            .foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle("Runtime configuration")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(startAfterSaving ? "Configure & Start" : "Save") {
                        Task { await save() }
                    }
                    .disabled(isSaving)
                }
            }
            .overlay {
                if isSaving {
                    ProgressView()
                        .controlSize(.large)
                        .padding(24)
                        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 8))
                }
            }
        }
    }

    private func save() async {
        guard !isSaving else { return }
        isSaving = true
        defer { isSaving = false }
        do {
            let config = try model.makeConfig()
            try await onSave(config)
            dismiss()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

@MainActor
@Observable
final class RuntimeConfigurationModel {
    let schema: V2RuntimeConfigSchema
    var textValues: [String: String] = [:]
    var boolValues: [String: Bool] = [:]
    var choiceValues: [String: JSONValue] = [:]

    init(schema: V2RuntimeConfigSchema, config: JSONValue?) {
        self.schema = schema
        let values = schema.initialValues(config: config)
        for field in schema.fields {
            let value = values[field.id]
            switch field.kind {
            case .text, .number:
                textValues[field.id] = value?.stringValue ?? ""
            case .boolean:
                if case let .bool(boolean) = value {
                    boolValues[field.id] = boolean
                } else {
                    boolValues[field.id] = false
                }
            case let .choice(options):
                choiceValues[field.id] = value ?? options.first?.value ?? .null
            case .keyValue:
                textValues[field.id] = Self.keyValueText(value)
            case .json:
                textValues[field.id] = Self.jsonText(value)
            }
        }
    }

    func textBinding(fieldId: String) -> Binding<String> {
        Binding(
            get: { self.textValues[fieldId] ?? "" },
            set: { self.textValues[fieldId] = $0 }
        )
    }

    func boolBinding(fieldId: String) -> Binding<Bool> {
        Binding(
            get: { self.boolValues[fieldId] ?? false },
            set: { self.boolValues[fieldId] = $0 }
        )
    }

    func choiceBinding(fieldId: String) -> Binding<JSONValue> {
        Binding(
            get: { self.choiceValues[fieldId] ?? .null },
            set: { self.choiceValues[fieldId] = $0 }
        )
    }

    func makeConfig() throws -> [String: JSONValue] {
        var config: [String: JSONValue] = [:]
        for field in schema.fields {
            switch field.kind {
            case .text:
                let value = textValues[field.id]?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                if field.isRequired && value.isEmpty {
                    throw V2BusinessError.invalidRuntimeConfigField(title: field.title)
                }
                if !value.isEmpty { config[field.id] = .string(value) }
            case let .number(integer, minimum, maximum):
                let rawValue = textValues[field.id]?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                if rawValue.isEmpty && !field.isRequired { continue }
                guard let number = Double(rawValue),
                      minimum.map({ number >= $0 }) ?? true,
                      maximum.map({ number <= $0 }) ?? true,
                      !integer || number.rounded() == number
                else {
                    throw V2BusinessError.invalidRuntimeConfigField(title: field.title)
                }
                config[field.id] = .number(number)
            case .boolean:
                config[field.id] = .bool(boolValues[field.id] ?? false)
            case .choice:
                guard let value = choiceValues[field.id], value != .null || !field.isRequired else {
                    throw V2BusinessError.invalidRuntimeConfigField(title: field.title)
                }
                config[field.id] = value
            case .keyValue:
                config[field.id] = try parseKeyValueField(field)
            case .json:
                config[field.id] = try parseJSONField(field)
            }
        }
        return config
    }

    private func parseKeyValueField(_ field: V2RuntimeConfigField) throws -> JSONValue {
        let lines = (textValues[field.id] ?? "").split(whereSeparator: \.isNewline)
        var values: [String: JSONValue] = [:]
        for line in lines {
            let parts = line.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
            let key = parts.first?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            guard !key.isEmpty, parts.count == 2 else {
                throw V2BusinessError.invalidRuntimeConfigField(title: field.title)
            }
            values[key] = .string(String(parts[1]))
        }
        return .object(values)
    }

    private func parseJSONField(_ field: V2RuntimeConfigField) throws -> JSONValue {
        let text = textValues[field.id]?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if text.isEmpty && !field.isRequired { return .null }
        guard let data = text.data(using: .utf8),
              let value = try? JSONDecoder().decode(JSONValue.self, from: data)
        else {
            throw V2BusinessError.invalidRuntimeConfigField(title: field.title)
        }
        return value
    }

    private static func keyValueText(_ value: JSONValue?) -> String {
        guard case let .object(values) = value else { return "" }
        return values.keys.sorted().map { key in
            "\(key)=\(values[key]?.stringValue ?? "")"
        }.joined(separator: "\n")
    }

    private static func jsonText(_ value: JSONValue?) -> String {
        guard let value,
              let data = try? JSONEncoder.prettyPrinted.encode(value),
              let text = String(data: data, encoding: .utf8)
        else { return "" }
        return text
    }
}

private struct RuntimeConfigurationFieldView: View {
    let field: V2RuntimeConfigField
    @Bindable var model: RuntimeConfigurationModel

    var body: some View {
        switch field.kind {
        case let .text(_, _, secure):
            if secure {
                SecureField(field.title, text: model.textBinding(fieldId: field.id))
            } else {
                TextField(field.title, text: model.textBinding(fieldId: field.id))
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
            }
        case .boolean:
            Toggle(field.title, isOn: model.boolBinding(fieldId: field.id))
                .toggleStyle(.switch).tint(nil).accentColor(nil)
        case .number:
            TextField(field.title, text: model.textBinding(fieldId: field.id))
                .keyboardType(.decimalPad)
        case let .choice(options):
            Picker(field.title, selection: model.choiceBinding(fieldId: field.id)) {
                ForEach(options) { option in
                    Text(option.title).tag(option.value)
                }
            }
        case .keyValue:
            RuntimeMultilineField(
                title: field.title,
                description: field.description,
                placeholder: "NAME=value",
                text: model.textBinding(fieldId: field.id)
            )
        case .json:
            RuntimeMultilineField(
                title: field.title,
                description: field.description,
                placeholder: "{}",
                text: model.textBinding(fieldId: field.id)
            )
        }
    }
}

private struct RuntimeMultilineField: View {
    let title: String
    let description: String?
    let placeholder: String
    @Binding var text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(.body)
            if let description {
                Text(description)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            TextEditor(text: $text)
                .font(.body.monospaced())
                .frame(minHeight: 110)
                .overlay(alignment: .topLeading) {
                    if text.isEmpty {
                        Text(placeholder)
                            .font(.body.monospaced())
                            .foregroundStyle(.tertiary)
                            .padding(.top, 8)
                            .padding(.leading, 5)
                            .allowsHitTesting(false)
                    }
                }
        }
    }
}

private extension JSONEncoder {
    static var prettyPrinted: JSONEncoder {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        return encoder
    }
}
