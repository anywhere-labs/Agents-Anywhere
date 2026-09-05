import SwiftUI

struct SessionTurnActions: View {
    let action: TimelineTurnAction
    @State private var copied = false

    var body: some View {
        let text = action.copyText
        HStack(spacing: 2) {
            Button {
                UIPasteboard.general.string = text; copied = true
            } label: { Image(systemName: copied ? "checkmark" : "document.on.document").frame(width: 44, height: 44) }
            .accessibilityLabel(copied ? "已复制" : "复制回复")
            .task(id: copied) {
                guard copied else { return }
                do { try await Task.sleep(for: .seconds(2)); copied = false } catch {}
            }
            ShareLink(item: text) { Image(systemName: "square.and.arrow.up").frame(width: 44, height: 44) }
                .accessibilityLabel("分享回复")
        }
        .disabled(text.isEmpty)
        .buttonStyle(.plain).font(.system(size: 15)).foregroundStyle(.secondary).padding(.leading, -10)
        .accessibilityIdentifier("chat.turn.actions")
    }
}
