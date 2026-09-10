import SwiftUI
import Textual

extension EnvironmentValues {
    @Entry var chatLayoutTraceOwner = "markdown"
}

struct ChatMarkdownView: View {
    let text: String
    var isStreaming = false
    var resolvesFileReferences = false
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
            guard var document = try? parser.attributedString(for: source) else { return }
            if resolvesFileReferences {
                // Web also makes inline code such as src/main.swift:42 a file
                // reference. Preserve code styling while adding its scoped link.
                for run in document.runs {
                    if run.link == nil, run.inlinePresentationIntent?.contains(.code) == true,
                       let reference = SessionFileReference.inlineReference(String(document[run.range].characters)) {
                        document[run.range].link = reference.link
                    }
                }
            }
            document = GitDirectiveParser.enrich(document) { directives, attributes in
                var badge = AttributedString(directives.map(\.label).joined(separator: " · "), attributes: attributes)
                badge.textual.attachment = AnyAttachment(ChatGitBadgeAttachment(directives: directives))
                return badge
            }
            let next = MarkdownBlockSnapshot.split(document)
            if blocks != next { blocks = next }
        }
    }
}

private struct MarkdownBlockView: View, Equatable {
    let block: MarkdownBlockSnapshot
    let isStreaming: Bool
    let isTail: Bool
    @State private var hasSettled = false
    @State private var headingLedger = GlyphRevealLedger()
    @Environment(\.dynamicTypeSize) private var dynamicType
    @Environment(\.displayScale) private var displayScale
    @Environment(\.layoutDirection) private var direction
    @Environment(\.chatLayoutTraceOwner) private var traceOwner

    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.block == rhs.block && lhs.isStreaming == rhs.isStreaming && lhs.isTail == rhs.isTail
    }

    var body: some View {
        // Only changed blocks reach Textual's parser. The complete document was
        // parsed above, so cross-block references and nested structures survive.
        MarkdownBlockLayout(dynamicType: dynamicType, displayScale: displayScale, direction: direction) {
            StructuredText(String(block.content.hashValue), parser: ParsedMarkdownText(content: block.content))
                .textual.structuredTextStyle(ChatMarkdownStyle(headingLedger: headingLedger))
                .textual.imageAttachmentLoader(ChatImageLoader())
                // Controls own their gestures. Only paragraph/heading labels and
                // the native code/table text areas install selection overlays.
                .textual.textSelection(.disabled)
                .environment(\.streamingGlyphAnimation, isStreaming && !hasSettled)
                .font(.body)
                .foregroundStyle(.primary)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .traceChatLayout("markdown:\(traceOwner):\(block.id):layout")
        .task(id: RevealPhase(isStreaming: isStreaming, isTail: isTail)) {
            // Opening static history must not schedule delayed state changes
            // for every paragraph. A live append still settles completed blocks.
            guard isStreaming else { return }
            hasSettled = false
            guard !isTail else { return }
            do { try await Task.sleep(for: ReplyPresentation.settleDelay) } catch { return }
            // Finish any new glyphs, then stop the drawing clock for this
            // completed block even while the rest of the response streams.
            hasSettled = true
        }
    }

    private struct RevealPhase: Equatable {
        let isStreaming: Bool
        let isTail: Bool
    }
}

/// Apply one complete style. A default bundle closer to StructuredText would
/// override individual styles applied outside it, silently bypassing our renderer.
private struct ChatMarkdownStyle: StructuredText.Style {
    private let defaults = StructuredText.DefaultStyle()
    let headingStyle: ChatHeadingStyle
    let paragraphStyle = ChatParagraphStyle()
    let codeBlockStyle = ChatCodeBlockStyle()

    init(headingLedger: GlyphRevealLedger) {
        headingStyle = ChatHeadingStyle(ledger: headingLedger)
    }

    var inlineStyle: InlineStyle { defaults.inlineStyle }
    var blockQuoteStyle: StructuredText.DefaultBlockQuoteStyle { defaults.blockQuoteStyle }
    var listItemStyle: StructuredText.DefaultListItemStyle { defaults.listItemStyle }
    var unorderedListMarker: StructuredText.SymbolListMarker { defaults.unorderedListMarker }
    var orderedListMarker: StructuredText.DecimalListMarker { defaults.orderedListMarker }
    var tableStyle: ChatTableStyle { ChatTableStyle() }
    var tableCellStyle: StructuredText.DefaultTableCellStyle { defaults.tableCellStyle }
    var thematicBreakStyle: StructuredText.DividerThematicBreakStyle { defaults.thematicBreakStyle }
}

private struct ChatParagraphStyle: StructuredText.ParagraphStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .textual.lineSpacing(.fontScaled(0.23))
            .textual.blockSpacing(.fontScaled(top: 0.8))
            .modifier(StreamingGlyphReveal())
            .textual.textSelectionScope()
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
            .textual.textSelectionScope()
    }
}

private struct ChatCodeBlockStyle: StructuredText.CodeBlockStyle {
    func makeBody(configuration: Configuration) -> some View {
        ChatMarkdownCodeBlock(code: configuration.codeBlock.text, language: configuration.languageHint) {
            configuration.label
                .monospaced()
                .textual.fontScale(0.86)
                .textual.lineSpacing(.fontScaled(0.35))
                .modifier(StreamingGlyphReveal())
        }
        .textual.blockSpacing(.fontScaled(top: 0.9, bottom: 0.5))
    }
}

private struct ChatTableStyle: StructuredText.TableStyle {
    func makeBody(configuration: Configuration) -> some View {
        ChatMarkdownTable(rows: configuration.rows, columns: configuration.columns)
            .textual.blockSpacing(.fontScaled(top: 0.9, bottom: 0.5))
    }
}
