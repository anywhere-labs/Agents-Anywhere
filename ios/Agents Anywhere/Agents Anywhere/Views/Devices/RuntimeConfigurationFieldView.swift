import SwiftUI

struct RuntimeConfigurationFieldView: View {
    let field: V2RuntimeConfigField
    @Bindable var model: RuntimeConfigurationModel
    @Environment(\.locale) private var locale

    private var title: String { RuntimeConfigCopy.title(field, locale: locale) }
    private var description: String? { RuntimeConfigCopy.description(field, locale: locale) }

    var body: some View {
        Section {
            if field.kind == .boolean {
                Toggle(title, isOn: binding(\.boolValues, default: false))
                    .toggleStyle(.switch).tint(.green)
            } else {
                editor
            }
            if let error = model.errors[field.id] {
                Label(error, appSymbol: "exclamationmark.circle")
                    .font(.footnote).foregroundStyle(.red).accessibilityIdentifier("configuration.error.\(field.id)")
            }
        } header: {
            if field.kind != .boolean { Text(title + (field.isRequired ? " *" : "")) }
        } footer: {
            if let description, !description.isEmpty {
                Text(description)
            }
        }
    }

    @ViewBuilder private var editor: some View {
        switch field.kind {
        case let .text(_, _, secure):
            if secure {
                RuntimeSecretInput(title: title, text: binding(\.textValues, default: ""))
            } else {
                TextField(field.defaultValue?.stringValue ?? title, text: binding(\.textValues, default: ""))
                    .runtimeConfigInput().accessibilityLabel(title)
            }
        case .number:
            TextField(title, text: binding(\.textValues, default: ""))
                .keyboardType(.numbersAndPunctuation).runtimeConfigInput()
        case let .choice(options):
            Picker(title, selection: binding(\.choiceValues, default: .null)) {
                Text(String(localized: "Choose an option")).tag(JSONValue.null)
                ForEach(options) { Text($0.title).tag($0.value) }
            }.pickerStyle(.menu).runtimeConfigInput()
        case .modelGateway:
            gateway
        case .keyValue:
            environment
        case .customModels:
            models
        case .json:
            TextEditor(text: binding(\.textValues, default: ""))
                .font(.footnote.monospaced()).frame(minHeight: 140)
                .runtimeConfigInput().accessibilityLabel(title)
        case .boolean: EmptyView()
        }
    }

    private var gateway: some View {
        VStack(alignment: .leading, spacing: 20) {
            let properties = field.schema["properties"]?.configObject ?? [:]
            let urlSchema = properties["baseUrl"]?.configObject ?? [:]
            let keySchema = properties["apiKey"]?.configObject ?? [:]
            VStack(alignment: .leading, spacing: 8) {
                Text(RuntimeConfigCopy.schemaText(urlSchema, key: "labelKey", fallback: String(localized: "Gateway URL"), locale: locale))
                    .font(.subheadline.weight(.medium))
                TextField("https://", text: binding(\.gateways, default: .init()).baseURL)
                    .keyboardType(.URL).runtimeConfigInput().accessibilityLabel(String(localized: "Gateway URL"))
                Text(RuntimeConfigCopy.schemaText(urlSchema, key: "descriptionKey", fallback: urlSchema["description"]?.stringValue ?? "", locale: locale))
                    .font(.footnote).foregroundStyle(.secondary)
            }
            VStack(alignment: .leading, spacing: 8) {
                Text(RuntimeConfigCopy.schemaText(keySchema, key: "labelKey", fallback: String(localized: "Gateway API key"), locale: locale))
                    .font(.subheadline.weight(.medium))
                RuntimeSecretInput(title: RuntimeConfigCopy.lookup(String(localized: "Gateway API key"), locale: locale),
                    text: binding(\.gateways, default: .init()).apiKey,
                    showTitle: String(localized: "dashboard.device.showModelGatewayApiKey"),
                    hideTitle: String(localized: "dashboard.device.hideModelGatewayApiKey"))
                Text(RuntimeConfigCopy.schemaText(keySchema, key: "descriptionKey", fallback: keySchema["description"]?.stringValue ?? "", locale: locale))
                    .font(.footnote).foregroundStyle(.secondary)
            }
        }.padding(.vertical, 8)
    }

    @ViewBuilder private var environment: some View {
        if model.environments[field.id, default: []].isEmpty {
            Text(String(localized: "No environment overrides.")).font(.subheadline).foregroundStyle(.secondary)
        }
        ForEach(model.environments[field.id] ?? []) { row in
            RuntimeEnvironmentRowEditor(row: row) {
                model.removeEnvironmentRow(row.id, fieldID: field.id)
            }
        }
        AppGlassButton(String(localized: "Add variable"), systemImage: "plus", maxWidth: nil) {
            model.environments[field.id, default: []].append(.init())
        }
    }

    @ViewBuilder private var models: some View {
        if model.customModels[field.id, default: []].isEmpty {
            Text(String(localized: "No custom models.")).font(.subheadline).foregroundStyle(.secondary)
        }
        ForEach(model.customModels[field.id] ?? []) { row in
            RuntimeCustomModelRowEditor(row: row) {
                model.removeCustomModel(row.id, fieldID: field.id)
            }
        }
        AppGlassButton(String(localized: "Add custom model"), systemImage: "plus", maxWidth: nil) {
            model.customModels[field.id, default: []].append(.init())
        }
    }

    private func binding<T>(_ keyPath: ReferenceWritableKeyPath<RuntimeConfigurationModel, [String: T]>,
        default fallback: T) -> Binding<T> {
        Binding(get: { model[keyPath: keyPath][field.id] ?? fallback },
            set: { model[keyPath: keyPath][field.id] = $0 })
    }
}

struct RuntimeSecretInput: View {
    let title: String
    @Binding var text: String
    var showTitle = String(localized: "Show secret")
    var hideTitle = String(localized: "Hide secret")
    @State private var isVisible = false
    var body: some View {
        HStack(spacing: 8) {
            Group {
                if isVisible { TextField(title, text: $text) }
                else { SecureField(title, text: $text) }
            }.textContentType(nil).accessibilityLabel(title)
            Button(isVisible ? hideTitle : showTitle, appSymbol: isVisible ? "eye.slash" : "eye") {
                isVisible.toggle()
            }.labelStyle(.iconOnly).frame(width: 32, height: 32)
        }.runtimeConfigInput()
    }
}

extension View {
    func runtimeConfigInput() -> some View {
        self.textInputAutocapitalization(.never).autocorrectionDisabled()
            .textFieldStyle(.plain)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

enum RuntimeConfigCopy {
    static func lookup(_ key: String, locale: Locale) -> String {
        String(localized: String.LocalizationValue(key), locale: locale)
    }
    static func schemaText(_ schema: [String: JSONValue], key: String, fallback: String, locale: Locale) -> String {
        if let key = schema["metadata"]?.configObject?["i18n"]?.configObject?[key]?.stringValue {
            let text = lookup(key, locale: locale)
            if text != key { return text }
        }
        return lookup(fallback, locale: locale)
    }
    static func title(_ field: V2RuntimeConfigField, locale: Locale) -> String {
        if field.kind == .modelGateway && field.isRequired {
            return lookup("dashboard.device.runtimeConfigComponents.modelGateway.requiredLabel", locale: locale)
        }
        let fallback = componentKey(field).map { lookup($0 + ".label", locale: locale) } ?? field.title
        return schemaText(field.schema, key: "labelKey", fallback: fallback, locale: locale)
    }
    static func description(_ field: V2RuntimeConfigField, locale: Locale) -> String? {
        if field.kind == .modelGateway && field.isRequired {
            return lookup("dashboard.device.runtimeConfigComponents.modelGateway.requiredDescription", locale: locale)
        }
        let fallback = componentKey(field).map { lookup($0 + ".description", locale: locale) } ?? field.description ?? ""
        return schemaText(field.schema, key: "descriptionKey", fallback: fallback, locale: locale)
    }
    private static func componentKey(_ field: V2RuntimeConfigField) -> String? {
        switch field.kind {
        case .modelGateway: "dashboard.device.runtimeConfigComponents.modelGateway"
        case .customModels: "dashboard.device.runtimeConfigComponents.customModels"
        case .keyValue: "dashboard.device.runtimeConfigComponents.keyValue"
        default: nil
        }
    }
}
