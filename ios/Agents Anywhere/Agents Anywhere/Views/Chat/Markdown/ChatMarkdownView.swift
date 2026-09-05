import SwiftUI
import Textual

struct ChatMarkdownView: View {
    let text: String
    var isStreaming = false
    @State private var blocks: [MarkdownBlockSnapshot] = []

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            ForEach(blocks) { block in
                MarkdownBlockView(block: block, isStreaming: isStreaming, isTail: block.id == blocks.last?.id)
                    .equatable()
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .onChange(of: text, initial: true) { _, source in
            let parser = AttributedStringMarkdownParser(baseURL: nil, syntaxExtensions: [.math])
            guard let document = try? parser.attributedString(for: source) else { return }
            blocks = MarkdownBlockSnapshot.split(document)
        }
    }
}

private struct MarkdownBlockView: View, Equatable {
    let block: MarkdownBlockSnapshot
    let isStreaming: Bool
    let isTail: Bool
    @State private var heightFloor: CGFloat = 0
    @State private var measuredWidth: CGFloat = 0
    @State private var hasSettled = false
    @State private var headingLedger = GlyphRevealLedger()
    @Environment(\.dynamicTypeSize) private var dynamicType

    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.block == rhs.block && lhs.isStreaming == rhs.isStreaming && lhs.isTail == rhs.isTail
    }

    var body: some View {
        // Only changed blocks reach Textual's parser. The complete document was
        // parsed above, so cross-block references and nested structures survive.
        StructuredText(String(block.content.hashValue), parser: ParsedBlock(content: block.content))
            .textual.structuredTextStyle(ChatMarkdownStyle(headingLedger: headingLedger))
            .textual.imageAttachmentLoader(ChatImageLoader())
            .textual.textSelection(.enabled)
            .environment(\.streamingGlyphAnimation, isStreaming && !hasSettled)
            .font(.body)
            .foregroundStyle(.primary)
            .fixedSize(horizontal: false, vertical: true)
            .onGeometryChange(for: CGSize.self, of: \.size) { size in
                guard size.width > 1 else { return }
                if abs(measuredWidth - size.width) > 1 {
                    measuredWidth = size.width
                    heightFloor = ceil(size.height)
                } else if size.height > heightFloor + 0.5 {
                    heightFloor = ceil(size.height)
                }
            }
            // A fragment can briefly report an empty layout as the highlighter
            // or attachment resolves. Preserve its last real height in that gap.
            .frame(minHeight: heightFloor, alignment: .topLeading)
            .frame(maxWidth: .infinity, alignment: .leading)
            .onChange(of: dynamicType) { heightFloor = 0; measuredWidth = 0 }
            .task(id: isTail) {
                hasSettled = false
                guard !isTail else { return }
                do { try await Task.sleep(for: ReplyPresentation.settleDelay) } catch { return }
                // Finish any new glyphs, then stop the drawing clock for this
                // completed block even while the rest of the response streams.
                hasSettled = true
            }
    }
}

private struct ParsedBlock: MarkupParser {
    let content: AttributedString
    func attributedString(for input: String) throws -> AttributedString { content }
}

/// Apply one complete style. A default bundle closer to StructuredText would
/// override individual styles applied outside it, silently bypassing our renderer.
private struct ChatMarkdownStyle: StructuredText.Style {
    private let defaults = StructuredText.DefaultStyle()
    let headingStyle: ChatHeadingStyle
    let paragraphStyle = ChatParagraphStyle()
    let codeBlockStyle = ChatCodeBlockStyle()
    let tableCellStyle = ChatTableCellStyle()

    init(headingLedger: GlyphRevealLedger) {
        headingStyle = ChatHeadingStyle(ledger: headingLedger)
    }

    var inlineStyle: InlineStyle { defaults.inlineStyle }
    var blockQuoteStyle: StructuredText.DefaultBlockQuoteStyle { defaults.blockQuoteStyle }
    var listItemStyle: StructuredText.DefaultListItemStyle { defaults.listItemStyle }
    var unorderedListMarker: StructuredText.SymbolListMarker { defaults.unorderedListMarker }
    var orderedListMarker: StructuredText.DecimalListMarker { defaults.orderedListMarker }
    var tableStyle: StructuredText.DefaultTableStyle { defaults.tableStyle }
    var thematicBreakStyle: StructuredText.DividerThematicBreakStyle { defaults.thematicBreakStyle }
}

private struct ChatParagraphStyle: StructuredText.ParagraphStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .textual.lineSpacing(.fontScaled(0.23))
            .textual.blockSpacing(.fontScaled(top: 0.8))
            .modifier(StreamingGlyphReveal())
    }
}

private struct ChatHeadingStyle: StructuredText.HeadingStyle {
    let ledger: GlyphRevealLedger

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .textual.fontScale(configuration.headingLevel == 1 ? 1.5 : configuration.headingLevel == 2 ? 1.25 : 1.08)
            .fontWeight(.semibold)
            .textual.blockSpacing(.fontScaled(top: 1.25, bottom: 0.55))
            // Textual identifies headings by their changing slug. Keep births
            // in the stable outer block so an append doesn't replay the heading.
            .modifier(StreamingGlyphReveal(ledger: ledger))
    }
}

private struct ChatCodeBlockStyle: StructuredText.CodeBlockStyle {
    func makeBody(configuration: Configuration) -> some View {
        CodeBlockCard(configuration: configuration)
            .textual.blockSpacing(.fontScaled(top: 0.9, bottom: 0.5))
    }
}

private struct ChatTableCellStyle: StructuredText.TableCellStyle {
    func makeBody(configuration: Configuration) -> some View {
        StructuredText.DefaultTableCellStyle().makeBody(configuration: configuration)
            .modifier(StreamingGlyphReveal())
    }
}

private struct CodeBlockCard: View {
    let configuration: StructuredText.CodeBlockStyleConfiguration
    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(configuration.languageHint ?? "text").font(.caption.weight(.medium))
                Spacer()
                Button {
                    configuration.codeBlock.copyToPasteboard()
                    copied = true
                } label: {
                    Label(copied ? "已复制" : "复制代码", systemImage: copied ? "checkmark" : "document.on.document")
                        .font(.caption)
                        .padding(.vertical, 8)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(copied ? "代码已复制" : "复制代码")
                .task(id: copied) {
                    guard copied else { return }
                    do { try await Task.sleep(for: .seconds(2)); copied = false } catch {}
                }
            }
            .foregroundStyle(.secondary)
            .padding(.horizontal, 14)
            .padding(.vertical, 4)
            .background(.primary.opacity(0.04))
            Divider().opacity(0.5)
            Overflow {
                configuration.label
                    .monospaced()
                    .textual.fontScale(0.86)
                    .textual.lineSpacing(.fontScaled(0.35))
                    .modifier(StreamingGlyphReveal())
                    .padding(14)
            }
        }
        .background(Color(uiColor: .secondarySystemBackground))
        .clipShape(.rect(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(.primary.opacity(0.07), lineWidth: 0.5))
    }

}

nonisolated private struct ChatImageLoader: AttachmentLoader {
    func attachment(for url: URL, text: String, environment: ColorEnvironmentValues) async throws -> ChatImageAttachment {
        let loader: any AttachmentLoader = url.scheme == nil || url.scheme == "resource"
            ? ResourceAttachmentLoader.image(named: { @Sendable in $0.lastPathComponent })
            : URLAttachmentLoader.image()
        return ChatImageAttachment(base: try await loader.attachment(for: url, text: text, environment: environment))
    }
}

/// A small adapter lets bundled demo images and URL images share the same loader.
/// The labeled initializer avoids Textual 0.5's overlapping eraser overloads.
nonisolated private struct ChatImageAttachment: Attachment {
    let base: any Attachment
    var description: String { base.description }
    var selectionStyle: AttachmentSelectionStyle { base.selectionStyle }
    @MainActor var body: some View { AnyView(base.body) }
    func baselineOffset(in environment: TextEnvironmentValues) -> CGFloat { base.baselineOffset(in: environment) }
    func sizeThatFits(_ proposal: ProposedViewSize, in environment: TextEnvironmentValues) -> CGSize {
        base.sizeThatFits(proposal, in: environment)
    }
    func pngData() -> Data? { base.pngData() }
    static func == (lhs: Self, rhs: Self) -> Bool { AnyHashable(lhs.base) == AnyHashable(rhs.base) }
    func hash(into hasher: inout Hasher) { hasher.combine(base) }
}
