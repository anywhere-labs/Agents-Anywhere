import SwiftUI

struct SheetCloseButton: View {
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            AppSymbol("xmark", size: 18)
                .frame(width: 36, height: 36)
                .glassEffect(.regular.interactive(), in: .circle)
        }
        .buttonStyle(.plain)
        .frame(width: 44, height: 44).contentShape(.circle)
        .keyboardShortcut(.cancelAction)
        .accessibilityLabel(String(localized: "Close"))
    }
}

/// Browse sheets always close at the trailing edge. A pushed page keeps its
/// native back button at the leading edge; it never turns into another close.
struct SheetCloseToolbar: ToolbarContent {
    var disabled = false
    let action: () -> Void
    var body: some ToolbarContent {
        ToolbarItem(placement: .topBarTrailing) {
            SheetCloseButton(action: action).disabled(disabled)
        }.sharedBackgroundVisibility(.hidden)
    }
}

struct SheetEditorToolbar: ToolbarContent {
    var saveTitle = String(localized: "Save")
    var isWorking = false
    var saveDisabled = false
    let onCancel: () -> Void
    let onSave: () -> Void
    var body: some ToolbarContent {
        ToolbarItem(placement: .cancellationAction) {
            Button(String(localized: "Cancel"), action: onCancel)
                .disabled(isWorking).keyboardShortcut(.cancelAction)
        }
        ToolbarItem(placement: .confirmationAction) {
            Button(action: onSave) {
                Text(saveTitle).opacity(isWorking ? 0 : 1)
                    .overlay { if isWorking { ProgressView().controlSize(.small) } }
            }
            .buttonStyle(.glassProminent).buttonBorderShape(.capsule)
            .disabled(isWorking || saveDisabled).keyboardShortcut("s", modifiers: .command)
        }
    }
}

extension View {
    func confirmDiscardChanges(_ isPresented: Binding<Bool>, onDiscard: @escaping () -> Void) -> some View {
        confirmationDialog(String(localized: "Discard unsaved changes?"), isPresented: isPresented, titleVisibility: .visible) {
            Button(String(localized: "Discard changes"), role: .destructive, action: onDiscard)
            Button(String(localized: "Keep editing"), role: .cancel) {}
        }
    }
}
