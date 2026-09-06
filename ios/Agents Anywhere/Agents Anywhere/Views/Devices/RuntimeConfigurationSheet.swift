import SwiftUI
import UIKit

struct RuntimeConfigurationSheet: View {
    @Environment(\.dismiss) private var dismiss
    let displayName: String
    let allowsNaming: Bool
    private let initialName: String
    let startAfterSaving: Bool
    var canSave: Bool
    let onSave: (String, [String: JSONValue]) async throws -> Void
    @State private var model: RuntimeConfigurationModel
    @State private var instanceName: String
    @State private var isSaving = false
    @State private var confirmsDiscard = false
    @State private var toasts = ChatToastStore()

    init(runtime: V2DeviceRuntime, schema: V2RuntimeConfigSchema, startAfterSaving: Bool,
         canSave: Bool = true, onSave: @escaping ([String: JSONValue]) async throws -> Void) {
        displayName = runtime.sessionDisplayName; allowsNaming = false; initialName = runtime.name
        self.startAfterSaving = startAfterSaving; self.canSave = canSave
        self.onSave = { _, config in try await onSave(config) }
        _instanceName = State(initialValue: runtime.name)
        _model = State(initialValue: RuntimeConfigurationModel(schema: schema, config: runtime.config))
    }
    init(type: V2RuntimeType, schema: V2RuntimeConfigSchema, suggestedName: String,
         canSave: Bool = true, onSave: @escaping (String, [String: JSONValue]) async throws -> Void) {
        displayName = type.displayName; allowsNaming = true; startAfterSaving = true; initialName = suggestedName
        self.canSave = canSave; self.onSave = onSave
        _instanceName = State(initialValue: suggestedName)
        _model = State(initialValue: RuntimeConfigurationModel(schema: schema, config: .object(type.defaults)))
    }

    var body: some View {
        NavigationStack {
            ScrollViewReader { proxy in
                Form {
                    Group {
                        if allowsNaming {
                            Section(String(localized: "Instance name")) {
                                TextField(String(localized: "Name"), text: $instanceName)
                                    .runtimeConfigInput()
                            }
                        }
                        ForEach(model.schema.fields) { field in
                            RuntimeConfigurationFieldView(field: field, model: model).id(field.id)
                        }
                        if !canSave {
                            Label(String(localized: "Device disconnected. Your changes are kept until it reconnects."), appSymbol: "wifi.slash")
                                .font(.footnote).foregroundStyle(.secondary)
                        }
                    }
                }
                .frame(maxWidth: 720).frame(maxWidth: .infinity)
                .scrollDismissesKeyboard(.interactively)
                .onChange(of: model.errors) { _, errors in
                    if let first = model.schema.fields.first(where: { errors[$0.id] != nil }) {
                        withAnimation(.smooth) { proxy.scrollTo(first.id, anchor: .top) }
                    }
                }
            }
            .disabled(isSaving)
            .navigationTitle(Text(String(localized: "Configure \(displayName)")))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                SheetEditorToolbar(saveTitle: allowsNaming ? String(localized: "Add") : String(localized: "Save"),
                    isWorking: isSaving,
                    saveDisabled: !canSave || (allowsNaming && instanceName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty),
                    onCancel: { if hasChanges { confirmsDiscard = true } else { dismiss() } },
                    onSave: {
                        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
                        Task { await Task.yield(); await save() }
                    })
            }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                HStack(spacing: 16) {
                    Button {
                        model.resetDefaults()
                    } label: {
                        Label(String(localized: "Reset all defaults"), appSymbol: "arrow.counterclockwise")
                            .font(.subheadline).lineLimit(2)
                    }.disabled(isSaving)
                    Spacer(minLength: 0)
                }
                .padding(18).frame(maxWidth: 720).frame(maxWidth: .infinity)
                .background(.bar)
            }
            .overlay(alignment: .top) { ChatErrorToasts(store: toasts, isRetrying: false, onRetry: { _ in }) }
        }
        .appSheetPresentation(.expanded).interactiveDismissDisabled(isSaving || hasChanges)
        .confirmDiscardChanges($confirmsDiscard) { dismiss() }
    }
    private var hasChanges: Bool { model.hasChanges || instanceName != initialName }
    private func save() async {
        guard canSave, !isSaving else { return }
        do {
            let config = try model.makeConfig()
            isSaving = true
            defer { isSaving = false }
            try await onSave(instanceName.trimmingCharacters(in: .whitespacesAndNewlines), config)
            dismiss()
        } catch is RuntimeConfigurationValidationError {
            // Field validation remains inline, with focus on the first invalid group.
        } catch {
            toasts.update(source: "configuration", failure: .init(kind: .rejected, message: error.localizedDescription))
        }
    }
}
