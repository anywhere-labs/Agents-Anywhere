import SwiftUI
import UIKit

/// Content fields of a timeline item that the device keeps in its blob store.
/// Each one can be loaded on request: text in full, images as a picture, and
/// anything else (or anything too large to show here) opened as a file.
struct TimelineBlobRefsView: View {
    let item: V2TimelineItem
    let blobs: SessionBlobStore
    let onOpen: (V2AttachmentContent) -> Void
    /// Paths whose loaded text the host view already shows in place of the preview.
    var shownInPlace: Set<String> = []

    var body: some View {
        let content = item.contentTree
        VStack(alignment: .leading, spacing: 8) {
            ForEach(item.blobRefs) { ref in
                TimelineBlobRefRow(ref: ref, content: content, blobs: blobs, onOpen: onOpen,
                                   shownInPlace: shownInPlace.contains(ref.path))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct TimelineBlobRefRow: View {
    let ref: V2TimelineBlobRef
    let content: JSONValue
    let blobs: SessionBlobStore
    let onOpen: (V2AttachmentContent) -> Void
    let shownInPlace: Bool

    var body: some View {
        let kind = ref.kind(in: content)
        let state = blobs.state(ref.blobId)
        VStack(alignment: .leading, spacing: 6) {
            header(kind: kind, state: state)
            switch state {
            case let .text(text) where !shownInPlace:
                TimelineCodePanel(label: String(localized: "\(ref.label(in: content)) · 完整内容"), code: text)
                    .clipShape(.rect(cornerRadius: 14))
            case let .image(data):
                TimelineBlobImage(data: data, label: ref.label(in: content)) { onOpen(ref.attachment(in: content)) }
            case let .failed(message):
                Text(message).font(.caption).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true)
            default:
                EmptyView()
            }
        }
    }

    @ViewBuilder private func header(kind: V2TimelineBlobRef.Kind, state: SessionBlobStore.State) -> some View {
        HStack(spacing: 8) {
            AppSymbol(symbol(kind), size: 15).frame(width: 18).foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 2) {
                Text(title(kind)).font(.caption.weight(.medium)).lineLimit(1).truncationMode(.middle)
                Text(subtitle(kind, state: state)).font(.caption2).foregroundStyle(.secondary).lineLimit(2)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            action(kind: kind, state: state)
        }
        .padding(.horizontal, 10).frame(minHeight: 44)
        .background(.quaternary.opacity(0.4), in: .rect(cornerRadius: 12))
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder private func action(kind: V2TimelineBlobRef.Kind, state: SessionBlobStore.State) -> some View {
        if !SessionBlobStore.showsInline(ref, kind: kind) {
            Button(String(localized: "打开")) { onOpen(ref.attachment(in: content)) }
                .font(.caption.weight(.medium)).buttonStyle(.borderless)
                .disabled(ref.bytes > SessionBlobStore.fileLimit)
        } else {
            switch state {
            case .idle:
                Button(kind == .text ? String(localized: "展开完整内容") : String(localized: "加载图片")) {
                    blobs.load(ref, kind: kind)
                }
                .font(.caption.weight(.medium)).buttonStyle(.borderless)
            case .loading:
                ProgressView().progressViewStyle(.circular).controlSize(.small)
                    .accessibilityLabel(String(localized: "正在读取完整内容"))
            case .failed:
                Button(String(localized: "重试")) { blobs.load(ref, kind: kind) }
                    .font(.caption.weight(.medium)).buttonStyle(.borderless)
            case .text, .image:
                EmptyView()
            }
        }
    }

    private func title(_ kind: V2TimelineBlobRef.Kind) -> String {
        switch kind {
        case .text: String(localized: "\(ref.label(in: content)) 的完整内容")
        case .image: String(localized: "图片")
        case .audio: String(localized: "音频")
        case .other: ref.suggestedFileName(in: content)
        }
    }

    private func subtitle(_ kind: V2TimelineBlobRef.Kind, state: SessionBlobStore.State) -> String {
        let size = ByteCountFormatter.string(fromByteCount: Int64(ref.bytes), countStyle: .file)
        if ref.bytes > SessionBlobStore.fileLimit {
            return String(localized: "\(size)，太大，无法在这里打开")
        }
        switch state {
        case .loading: return String(localized: "正在读取 \(size)…")
        case .text where shownInPlace: return String(localized: "已在上方显示完整内容（\(size)）")
        default: break
        }
        if !SessionBlobStore.showsInline(ref, kind: kind), kind == .text || kind == .image {
            return String(localized: "\(size)，较大，以文件打开")
        }
        return ref.placeholder(in: content).map { "\($0) · \(size)" } ?? String(localized: "存在设备上 · \(size)")
    }

    private func symbol(_ kind: V2TimelineBlobRef.Kind) -> String {
        switch kind {
        case .text: "doc.text"
        case .image: "photo"
        case .audio: "music.note"
        case .other: "doc"
        }
    }
}

/// Loaded image bytes, decoded to a thumbnail off the main actor; tapping opens the full image.
private struct TimelineBlobImage: View {
    let data: Data
    let label: String
    let onOpen: () -> Void
    @State private var image: UIImage?
    @State private var failed = false

    var body: some View {
        Button(action: onOpen) {
            ZStack {
                RoundedRectangle(cornerRadius: 14).fill(.quaternary.opacity(0.6))
                if let image {
                    Image(uiImage: image).resizable().scaledToFit()
                } else if failed {
                    Text(String(localized: "无法显示这张图片")).font(.caption).foregroundStyle(.secondary)
                } else {
                    ProgressView().progressViewStyle(.circular)
                }
            }
            .aspectRatio(4.0 / 3.0, contentMode: .fit).frame(maxWidth: 320)
            .clipShape(.rect(cornerRadius: 14)).contentShape(.rect(cornerRadius: 14))
        }
        .buttonStyle(.plain).accessibilityLabel(label).accessibilityHint(String(localized: "打开大图"))
        .task(id: data) {
            let source = data
            let thumbnail = await Task.detached(priority: .utility) { ChatImageThumbnail.make(data: source) }.value
            guard !Task.isCancelled else { return }
            image = thumbnail.flatMap { UIImage(data: $0) }
            failed = image == nil
        }
    }
}
