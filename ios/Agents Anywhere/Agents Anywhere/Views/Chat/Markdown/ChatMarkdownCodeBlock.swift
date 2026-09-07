import SwiftUI
import Textual
import UIKit

/// The header is a real control outside the selectable, horizontally scrolling
/// code area. Textual supplies syntax highlighting, not the button interaction.
struct ChatMarkdownCodeBlock<Code: View>: View {
    let code: String
    let language: String?
    @ViewBuilder let highlightedCode: () -> Code
    @State private var copyCount = 0
    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 12) {
                Text(verbatim: language ?? "text").font(.caption.weight(.medium)).lineLimit(1)
                Spacer(minLength: 8)
                Button {
                    UIPasteboard.general.string = code
                    copied = true
                    copyCount += 1
                } label: {
                    ZStack {
                        copyLabel(copied: false).hidden()
                        copyLabel(copied: true).hidden()
                        copyLabel(copied: copied)
                    }
                    .frame(minHeight: 44).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("markdown.copyCode")
                .task(id: copyCount) {
                    guard copyCount > 0 else { return }
                    do { try await Task.sleep(for: .seconds(2)); copied = false } catch {}
                }
            }
            .foregroundStyle(.secondary).padding(.horizontal, 14)
            .background(.primary.opacity(0.04))
            Divider().opacity(0.5)
            ScrollView(.horizontal) {
                highlightedCode()
                    .textual.textSelectionScope()
                    .fixedSize(horizontal: true, vertical: false)
                    .padding(14)
            }
            .scrollBounceBehavior(.basedOnSize, axes: .horizontal)
            .fixedSize(horizontal: false, vertical: true)
        }
        .background(Color(uiColor: .secondarySystemBackground))
        .clipShape(.rect(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(.primary.opacity(0.07), lineWidth: 0.5).allowsHitTesting(false))
    }

    private func copyLabel(copied: Bool) -> some View {
        Label(copied ? String(localized: "已复制") : String(localized: "复制代码"),
            appSymbol: copied ? "checkmark" : "document.on.document")
            .font(.caption)
    }
}
