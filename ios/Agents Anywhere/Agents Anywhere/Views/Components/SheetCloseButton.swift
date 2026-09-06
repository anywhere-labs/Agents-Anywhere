import SwiftUI

struct SheetCloseButton: View {
    let action: () -> Void

    var body: some View {
        Button(role: .close, action: action) {
            Label(String(localized: "Close"), appSymbol: "xmark")
        }
        .labelStyle(.iconOnly)
        .keyboardShortcut(.cancelAction)
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
        }
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
        SheetSaveToolbar(saveTitle: saveTitle, isWorking: isWorking, saveDisabled: saveDisabled, onSave: onSave)
    }
}

/// Pushed editors keep the system Back button and interactive pop gesture.
struct SheetSaveToolbar: ToolbarContent {
    var saveTitle = String(localized: "Save")
    var isWorking = false
    var saveDisabled = false
    let onSave: () -> Void

    var body: some ToolbarContent {
        ToolbarItem(placement: .confirmationAction) {
            Button(role: .confirm, action: onSave) {
                Text(saveTitle).opacity(isWorking ? 0 : 1)
                    .overlay { if isWorking { ProgressView().controlSize(.small) } }
            }
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
