import SwiftUI
import Textual

/// Resolve an interactive attachment immediately. The image view owns loading,
/// retry and preview, with a reserved footprint while the network request runs.
nonisolated struct ChatImageLoader: AttachmentLoader {
    func attachment(for url: URL, text: String, environment: ColorEnvironmentValues) async throws -> ChatMarkdownImageAttachment {
        ChatMarkdownImageAttachment(url: url, description: text, colors: environment)
    }
}

nonisolated struct ChatMarkdownImageAttachment: Attachment {
    let url: URL
    let description: String
    let colors: ColorEnvironmentValues

    @MainActor var body: some View {
        ChatMarkdownImage(url: url, description: description, colors: colors)
            .textual.textSelectionExcluded()
    }

    func sizeThatFits(_ proposal: ProposedViewSize, in environment: TextEnvironmentValues) -> CGSize {
        let width = min(420, proposal.width ?? 320)
        return CGSize(width: width, height: SessionFileReference.path(from: url) == nil ? width * 0.75 : 68)
    }
}

private struct ChatMarkdownImage: View {
    let url: URL
    let description: String
    let colors: ColorEnvironmentValues
    @State private var attachment: AnyAttachment?
    @State private var failed = false
    @State private var retry = 0
    @State private var showsPreview = false
    @State private var loadedURL: URL?
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.colorSchemeContrast) private var contrast
    @Environment(\.openURL) private var openURL

    var body: some View {
        Button {
            if let path = SessionFileReference.path(from: url), let link = SessionFileReference.link(path) {
                openURL(link)
            } else if attachment != nil {
                showsPreview = true
            } else if failed {
                retry += 1
            }
        } label: {
            ZStack {
                Color(uiColor: .secondarySystemBackground)
                if let path = SessionFileReference.path(from: url) {
                    Label(description.isEmpty ? (path as NSString).lastPathComponent : description, appSymbol: "photo")
                        .font(.subheadline).lineLimit(2).padding(12)
                } else if let attachment {
                    attachment.body
                } else if failed {
                    Label(String(localized: "轻点重试预览"), appSymbol: "arrow.clockwise")
                        .font(.caption).foregroundStyle(.secondary).padding(12)
                } else {
                    ProgressView().progressViewStyle(.circular)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .clipShape(.rect(cornerRadius: 16)).contentShape(.rect(cornerRadius: 16))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(description.isEmpty ? String(localized: "查看图片") : description)
        .accessibilityIdentifier("markdown.imagePreview")
        .sheet(isPresented: $showsPreview) {
            if let attachment { ChatMarkdownImagePreview(attachment: attachment, title: description) }
        }
        .task(id: Request(url: url, retry: retry, colors: colorEnvironment)) {
            guard SessionFileReference.path(from: url) == nil else { return }
            if loadedURL != url { attachment = nil; loadedURL = url }
            failed = false
            do {
                let value = try await URLAttachmentLoader.image().attachment(for: url, text: description,
                    environment: colorEnvironment)
                try Task.checkCancellation()
                attachment = AnyAttachment(value)
            } catch { if !Task.isCancelled { failed = true } }
        }
    }

    private var colorEnvironment: ColorEnvironmentValues {
        var value = colors
        value.colorScheme = colorScheme
        value.colorSchemeContrast = contrast
        return value
    }

    private struct Request: Equatable { let url: URL; let retry: Int; let colors: ColorEnvironmentValues }
}
