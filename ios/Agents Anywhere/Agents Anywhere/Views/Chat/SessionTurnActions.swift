import CoreTransferable
import SwiftUI

struct SessionTurnActions: View, Equatable {
    let action: TimelineTurnAction
    @State private var copied = false

    static func == (lhs: Self, rhs: Self) -> Bool { lhs.action == rhs.action }

    var body: some View {
        HStack(spacing: 2) {
            Button {
                UIPasteboard.general.string = action.copyText; copied = true
            } label: { AppSymbol(copied ? "checkmark" : "document.on.document").frame(width: 44, height: 44) }
            .accessibilityLabel(copied ? String(localized: "已复制") : String(localized: "复制回复"))
            .task(id: copied) {
                guard copied else { return }
                do { try await Task.sleep(for: .seconds(2)); copied = false } catch {}
            }
            ShareLink(item: TurnReplyShareItem(action: action), preview: SharePreview(String(localized: "回复"))) {
                AppSymbol("square.and.arrow.up").frame(width: 44, height: 44)
            }
            .accessibilityLabel(String(localized: "分享回复"))
        }
        .disabled(!action.hasReplyText)
        .buttonStyle(.plain).font(.system(size: 15)).foregroundStyle(.secondary).padding(.leading, -10)
        .accessibilityIdentifier("chat.turn.actions")
    }
}

/// Exports the joined reply text only when a share actually starts.
private struct TurnReplyShareItem: Transferable {
    let action: TimelineTurnAction
    var text: String { action.copyText }
    static var transferRepresentation: some TransferRepresentation {
        ProxyRepresentation(exporting: \.text)
    }
}
