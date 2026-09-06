import SwiftUI

struct RuntimeConfigurationFieldView: View {
    let field: V2RuntimeConfigField
    @Bindable var model: RuntimeConfigurationModel
    @Environment(\.locale) private var locale

    private var title: String { RuntimeConfigCopy.title(field, locale: locale) }
    private var description: String? { RuntimeConfigCopy.description(field, locale: locale) }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if field.kind == .boolean {
                Toggle(isOn: binding(model.boolValues[field.id] ?? false) { model.boolValues[field.id] = $0 }) {
                    heading
                }.toggleStyle(.switch).tint(.green)
            } else {
                heading
                editor
            }
            if let error = model.errors[field.id] {
                Label(error, appSymbol: "exclamationmark.circle")
                    .font(.footnote).foregroundStyle(.red).accessibilityIdentifier("configuration.error.\(field.id)")
            }
        }
    }

    private var heading: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title + (field.isRequired ? " *" : "")).font(.headline)
            if let description, !description.isEmpty {
                Text(description).font(.subheadline).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    @ViewBuilder private var editor: some View {
        switch field.kind {
        case let .text(_, _, secure):
            if secure {
                RuntimeSecretInput(title: title, text: binding(model.textValues[field.id] ?? "") { model.textValues[field.id] = $0 })
            } else {
                TextField(field.defaultValue?.stringValue ?? title, text: binding(model.textValues[field.id] ?? "") { model.textValues[field.id] = $0 })
                    .runtimeConfigInput().accessibilityLabel(title)
            }
        case .number:
            TextField(title, text: binding(model.textValues[field.id] ?? "") { model.textValues[field.id] = $0 })
                .keyboardType(.numbersAndPunctuation).runtimeConfigInput()
        case let .choice(options):
            Picker(title, selection: binding(model.choiceValues[field.id] ?? .null) { model.choiceValues[field.id] = $0 }) {
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
            TextEditor(text: binding(model.textValues[field.id] ?? "") { model.textValues[field.id] = $0 })
                .font(.footnote.monospaced()).frame(minHeight: 140)
                .scrollContentBackground(.hidden).runtimeConfigInput().accessibilityLabel(title)
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
                TextField("https://", text: binding(model.gateways[field.id, default: .init()].baseURL) {
                    model.gateways[field.id, default: .init()].baseURL = $0
                }).keyboardType(.URL).runtimeConfigInput().accessibilityLabel(String(localized: "Gateway URL"))
                Text(RuntimeConfigCopy.schemaText(urlSchema, key: "descriptionKey", fallback: urlSchema["description"]?.stringValue ?? "", locale: locale))
                    .font(.footnote).foregroundStyle(.secondary)
            }
            VStack(alignment: .leading, spacing: 8) {
                Text(RuntimeConfigCopy.schemaText(keySchema, key: "labelKey", fallback: String(localized: "Gateway API key"), locale: locale))
                    .font(.subheadline.weight(.medium))
                RuntimeSecretInput(title: RuntimeConfigCopy.lookup(String(localized: "Gateway API key"), locale: locale), text:
                    binding(model.gateways[field.id, default: .init()].apiKey) { model.gateways[field.id, default: .init()].apiKey = $0 })
                Text(RuntimeConfigCopy.schemaText(keySchema, key: "descriptionKey", fallback: keySchema["description"]?.stringValue ?? "", locale: locale))
                    .font(.footnote).foregroundStyle(.secondary)
            }
        }.padding(16).background(.quaternary.opacity(0.35), in: .rect(cornerRadius: 22))
    }

    private var environment: some View {
        VStack(alignment: .leading, spacing: 12) {
            if model.environments[field.id, default: []].isEmpty {
                Text(String(localized: "No environment overrides.")).font(.subheadline).foregroundStyle(.secondary)
            }
            ForEach(Binding(get: { model.environments[field.id] ?? [] }, set: { model.environments[field.id] = $0 })) { $row in
                VStack(alignment: .leading, spacing: 8) {
                    HStack(alignment: .top, spacing: 10) {
                        VStack(spacing: 10) {
                            TextField(String(localized: "Variable name"), text: $row.key).runtimeConfigInput()
                            TextField(row.removesInherited ? String(localized: "Remove inherited variable") : String(localized: "Value"), text: $row.value)
                                .runtimeConfigInput().disabled(row.removesInherited)
                        }
                        Menu {
                            Toggle(String(localized: "Remove inherited variable"), isOn: $row.removesInherited)
                            Button(String(localized: "Remove variable"), appSymbol: "trash", role: .destructive) {
                                model.environments[field.id]?.removeAll { $0.id == row.id }
                            }
                        } label: { AppSymbol("ellipsis").frame(width: 44, height: 44) }
                            .accessibilityLabel(String(localized: "Variable actions"))
                    }
                    if row.removesInherited {
                        Label(String(localized: "Inherited variable will be removed."), appSymbol: "minus.circle")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                }
            }
            AppGlassButton(String(localized: "Add variable"), systemImage: "plus", maxWidth: nil) {
                model.environments[field.id, default: []].append(.init())
            }
        }.padding(16).background(.quaternary.opacity(0.35), in: .rect(cornerRadius: 22))
    }

    private var models: some View {
        VStack(alignment: .leading, spacing: 16) {
            if model.customModels[field.id, default: []].isEmpty {
                Text(String(localized: "No custom models.")).font(.subheadline).foregroundStyle(.secondary)
            }
            ForEach(Binding(get: { model.customModels[field.id] ?? [] }, set: { model.customModels[field.id] = $0 })) { $row in
                VStack(alignment: .leading, spacing: 14) {
                    HStack(spacing: 10) {
                        Text(String(localized: "Custom model")).font(.subheadline.weight(.medium))
                        Spacer()
                        Button(String(localized: "Remove model"), appSymbol: "trash", role: .destructive) {
                            model.customModels[field.id]?.removeAll { $0.id == row.id }
                        }.labelStyle(.iconOnly).frame(width: 44, height: 44)
                    }
                    TextField(String(localized: "Model ID"), text: $row.modelID).runtimeConfigInput()
                    TextField(String(localized: "Display name"), text: $row.displayName).runtimeConfigInput()
                    HStack {
                        Text(String(localized: "Reasoning efforts")).font(.subheadline.weight(.medium))
                        Spacer()
                        Button(String(localized: "Add effort"), appSymbol: "plus") { row.efforts.append(.init()) }
                            .labelStyle(.iconOnly).frame(width: 44, height: 44)
                    }
                    if row.efforts.isEmpty {
                        Text(String(localized: "This model has no custom reasoning efforts.")).font(.footnote).foregroundStyle(.secondary)
                    }
                    ForEach($row.efforts) { $effort in
                        HStack(alignment: .top, spacing: 10) {
                            VStack(spacing: 10) {
                                TextField(String(localized: "Effort ID"), text: $effort.effortID).runtimeConfigInput()
                                TextField(String(localized: "Display name"), text: $effort.displayName).runtimeConfigInput()
                            }
                            Button(String(localized: "Remove effort"), appSymbol: "trash", role: .destructive) {
                                row.efforts.removeAll { $0.id == effort.id }
                            }.labelStyle(.iconOnly).frame(width: 44, height: 44)
                        }
                    }
                }.padding(16).background(.quaternary.opacity(0.35), in: .rect(cornerRadius: 22))
            }
            AppGlassButton(String(localized: "Add custom model"), systemImage: "plus", maxWidth: nil) {
                model.customModels[field.id, default: []].append(.init())
            }
        }
    }

    private func binding<T>(_ value: T, set: @escaping (T) -> Void) -> Binding<T> {
        Binding(get: { value }, set: set)
    }
}

struct RuntimeSecretInput: View {
    let title: String
    @Binding var text: String
    @State private var isVisible = false
    var body: some View {
        HStack(spacing: 8) {
            Group {
                if isVisible { TextField(title, text: $text) }
                else { SecureField(title, text: $text) }
            }.textContentType(nil).accessibilityLabel(title)
            Button(isVisible ? String(localized: "Hide secret") : String(localized: "Show secret"), appSymbol: isVisible ? "eye.slash" : "eye") {
                isVisible.toggle()
            }.labelStyle(.iconOnly).frame(width: 32, height: 32)
        }.runtimeConfigInput()
    }
}

extension View {
    func runtimeConfigInput() -> some View {
        self.textInputAutocapitalization(.never).autocorrectionDisabled()
            .padding(12).frame(maxWidth: .infinity, alignment: .leading)
            .background(.quaternary.opacity(0.5), in: .rect(cornerRadius: 14))
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
