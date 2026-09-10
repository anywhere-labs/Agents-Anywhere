import SwiftUI

struct RuntimeEnvironmentRowEditor: View {
    @Bindable var row: RuntimeEnvironmentRow
    let onRemove: () -> Void
    @FocusState private var focusedField: RuntimeConfigurationInput?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 12) {
                VStack(alignment: .leading, spacing: 12) {
                    TextField(String(localized: "Variable name"), text: $row.key)
                        .runtimeConfigInput().focused($focusedField, equals: .identifier)
                    TextField(String(localized: "Value"), text: $row.value)
                        .runtimeConfigInput().focused($focusedField, equals: .value).disabled(row.removesInherited)
                }
                Menu {
                    Toggle(String(localized: "Remove inherited variable"), isOn: $row.removesInherited)
                    Button(String(localized: "Remove variable"), systemImage: "trash", role: .destructive) {
                        focusedField = nil
                        onRemove()
                    }
                } label: { AppSymbol("ellipsis").frame(width: 44, height: 44) }
                    .accessibilityLabel(String(localized: "Variable actions"))
            }
        }
        .padding(.vertical, 8)
    }
}

struct RuntimeCustomModelRowEditor: View {
    @Bindable var row: RuntimeCustomModelRow
    let onRemove: () -> Void
    @FocusState private var focusedField: RuntimeConfigurationInput?

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text(String(localized: "Custom model")).font(.subheadline.weight(.medium))
                Spacer()
                Button(String(localized: "Remove model"), appSymbol: "trash", role: .destructive) {
                    focusedField = nil
                    onRemove()
                }.buttonStyle(.borderless).labelStyle(.iconOnly).frame(width: 44, height: 44)
            }
            TextField(String(localized: "Model ID"), text: $row.modelID)
                .runtimeConfigInput().focused($focusedField, equals: .identifier)
            TextField(String(localized: "Display name"), text: $row.displayName)
                .runtimeConfigInput().focused($focusedField, equals: .value)
            HStack {
                Text(String(localized: "Reasoning efforts")).font(.subheadline.weight(.medium))
                Spacer()
                Button(String(localized: "Add effort"), appSymbol: "plus") {
                    row.efforts.append(.init())
                }.buttonStyle(.borderless).labelStyle(.iconOnly).frame(width: 44, height: 44)
            }
            if row.efforts.isEmpty {
                Text(String(localized: "This model has no custom reasoning efforts."))
                    .font(.footnote).foregroundStyle(.secondary)
            }
            ForEach(row.efforts) { effort in
                Divider()
                RuntimeEffortRowEditor(row: effort) { row.removeEffort(effort.id) }
            }
        }
        .padding(.vertical, 8)
    }
}

private struct RuntimeEffortRowEditor: View {
    @Bindable var row: RuntimeEffortRow
    let onRemove: () -> Void
    @FocusState private var focusedField: RuntimeConfigurationInput?

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 12) {
                TextField(String(localized: "Effort ID"), text: $row.effortID)
                    .runtimeConfigInput().focused($focusedField, equals: .identifier)
                TextField(String(localized: "dashboard.device.customEffortDisplayName"), text: $row.displayName)
                    .runtimeConfigInput().focused($focusedField, equals: .value)
            }
            Button(String(localized: "Remove effort"), appSymbol: "trash", role: .destructive) {
                focusedField = nil
                onRemove()
            }.buttonStyle(.borderless).labelStyle(.iconOnly).frame(width: 44, height: 44)
        }
    }
}

private enum RuntimeConfigurationInput: Hashable { case identifier, value }
