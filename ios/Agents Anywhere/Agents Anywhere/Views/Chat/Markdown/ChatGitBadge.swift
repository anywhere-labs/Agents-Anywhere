import SwiftUI
import Textual
import CoreText

nonisolated struct ChatGitBadgeAttachment: Attachment {
    let directives: [GitDirective]
    var description: String { directives.map(\.label).joined(separator: " · ") }
    var selectionStyle: AttachmentSelectionStyle { .text }

    @MainActor var body: some View {
        ChatGitBadge(directives: directives)
            .textual.textSelectionExcluded()
    }

    func baselineOffset(in environment: TextEnvironmentValues) -> CGFloat {
        -FontScaled(CGFloat(0.22)).resolve(in: environment)
    }

    func sizeThatFits(_ proposal: ProposedViewSize, in environment: TextEnvironmentValues) -> CGSize {
        let size = FontScaled(CGFloat(0.8)).resolve(in: environment)
        let font = CTFontCreateUIFontForLanguage(.system, size, nil) ?? CTFontCreateWithName("Helvetica" as CFString, size, nil)
        let text = NSAttributedString(string: description, attributes: [NSAttributedString.Key(kCTFontAttributeName as String): font])
        let width = CGFloat(CTLineGetTypographicBounds(CTLineCreateWithAttributedString(text), nil, nil, nil)) + size * 2.8
        return CGSize(width: min(width.rounded(.up), proposal.width ?? 320), height: size * 1.8)
    }
}

private struct ChatGitBadge: View {
    let directives: [GitDirective]
    @Environment(\.openURL) private var openURL
    @ScaledMetric(relativeTo: .body) private var fontSize: CGFloat = 13.6
    private var label: String { directives.map(\.label).joined(separator: " · ") }
    private var links: [GitDirective] { directives.filter { $0.url != nil } }

    var body: some View {
        Group {
            if links.count > 1 {
                Menu {
                    ForEach(Array(links.enumerated()), id: \.offset) { _, directive in
                        if let url = directive.url { Link(directive.attributes["branch"] ?? directive.label, destination: url) }
                    }
                } label: { capsule }
            } else if let url = links.first?.url {
                Button { openURL(url) } label: { capsule }
            } else { capsule }
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(label)
        .accessibilityIdentifier("markdown.gitBadge")
    }

    private var capsule: some View {
        HStack(spacing: fontSize * 0.35) {
            AppSymbol("arrow.triangle.branch", size: fontSize)
            Text(label).lineLimit(1).truncationMode(.middle)
        }
        .font(.system(size: fontSize))
        .padding(.horizontal, fontSize * 0.6)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .foregroundStyle(.secondary)
        .background(.quaternary, in: Capsule())
        .contentShape(Capsule())
    }
}
