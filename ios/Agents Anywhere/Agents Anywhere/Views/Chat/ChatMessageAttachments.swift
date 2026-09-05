import SwiftUI
import UIKit

struct ChatMessageAttachments: View {
    let files: [ChatMessageAttachment]
    let onOpen: (V2AttachmentContent) -> Void
    let loadThumbnail: (V2AttachmentContent) async throws -> Data?
    var alignment: HorizontalAlignment = .trailing

    var body: some View {
        VStack(alignment: alignment, spacing: 8) {
            ForEach(files) { file in
                if file.content.isImage {
                    ChatMessageImage(file: file, onOpen: onOpen, loadThumbnail: loadThumbnail)
                } else {
                    Button { onOpen(file.content) } label: {
                        HStack(spacing: 12) {
                            Image(systemName: "doc.text").font(.title2).frame(width: 30)
                            VStack(alignment: .leading, spacing: 3) {
                                Text(file.content.name ?? "附件").font(.subheadline.weight(.medium)).lineLimit(2)
                                Text(description(file.content)).font(.caption).foregroundStyle(.secondary)
                            }.frame(maxWidth: .infinity, alignment: .leading)
                            Image(systemName: "arrow.up.right").font(.caption).foregroundStyle(.secondary)
                        }.padding(12).frame(maxWidth: 320, alignment: .leading)
                            .background(.quaternary.opacity(0.6), in: .rect(cornerRadius: 16))
                            .contentShape(.rect(cornerRadius: 16))
                    }.buttonStyle(.plain)
                }
            }
        }
    }
    private func description(_ file: V2AttachmentContent) -> String {
        let ext = ((file.name ?? "") as NSString).pathExtension.uppercased()
        return [ext.isEmpty ? "文件" : ext, file.size.map { ByteCountFormatter.string(fromByteCount: Int64($0), countStyle: .file) }]
            .compactMap { $0 }.joined(separator: " · ")
    }
}

private struct ChatMessageImage: View {
    let file: ChatMessageAttachment
    let onOpen: (V2AttachmentContent) -> Void
    let loadThumbnail: (V2AttachmentContent) async throws -> Data?
    @State private var image: UIImage?
    @State private var visible = false
    @State private var failed = false
    @State private var retry = 0

    var body: some View {
        Button {
            if failed && image == nil { failed = false; retry += 1 }
            else { onOpen(file.content) }
        } label: {
            ZStack {
                RoundedRectangle(cornerRadius: 16).fill(.quaternary.opacity(0.6))
                if let image {
                    Image(uiImage: image).resizable().scaledToFit()
                } else if failed {
                    Label("轻点重试预览", systemImage: "arrow.clockwise").font(.caption).foregroundStyle(.secondary)
                } else {
                    ProgressView().progressViewStyle(.circular)
                }
            }
            // Fixed preview footprint: decoding or switching from local bytes
            // to a remote thumbnail cannot move the surrounding conversation.
            .aspectRatio(4.0 / 3.0, contentMode: .fit).frame(maxWidth: 320)
            .clipShape(.rect(cornerRadius: 16))
            .contentShape(.rect(cornerRadius: 16))
        }
        .buttonStyle(.plain).accessibilityLabel(file.content.name ?? "图片附件")
        .onAppear { if image == nil, let data = file.previewData { image = UIImage(data: data) } }
        .onScrollVisibilityChange(threshold: 0.01) { visible = $0 }
        .task(id: Request(visible: visible, key: file.content.cacheKey, retry: retry)) {
            guard visible, image == nil else { return }
            do {
                let data = try await loadThumbnail(file.content)
                guard !Task.isCancelled else { return }
                image = data.flatMap { UIImage(data: $0) }
                failed = image == nil
            } catch { if !Task.isCancelled { failed = true } }
        }
    }
    private struct Request: Equatable { let visible: Bool; let key: String; let retry: Int }
}

struct ChatComposerAttachment: View {
    let attachment: ChatAttachment
    let onRemove: () -> Void
    @State private var image: UIImage?
    var body: some View {
        Group {
            if attachment.isImage {
                ZStack {
                    RoundedRectangle(cornerRadius: 12).fill(.quaternary)
                    if let image { Image(uiImage: image).resizable().scaledToFill() }
                    else { Image(systemName: "photo").foregroundStyle(.secondary) }
                }.frame(width: 72, height: 72).clipShape(.rect(cornerRadius: 12))
            } else {
                HStack(spacing: 8) {
                    Image(systemName: "doc.text").font(.title3)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(attachment.name).font(.caption.weight(.medium)).lineLimit(2)
                        Text(ByteCountFormatter.string(fromByteCount: Int64(attachment.data.count), countStyle: .file))
                            .font(.caption2).foregroundStyle(.secondary)
                    }.frame(maxWidth: 140, alignment: .leading)
                }.padding(.horizontal, 12).padding(.trailing, 20).frame(height: 72)
                    .background(.primary.opacity(0.07), in: .rect(cornerRadius: 12))
            }
        }
        .overlay(alignment: .topTrailing) {
            Button(action: onRemove) {
                Image(systemName: "xmark.circle.fill").symbolRenderingMode(.palette)
                    .foregroundStyle(.white, .black.opacity(0.7)).font(.system(size: 19))
                    .frame(width: 44, height: 44).contentShape(Rectangle())
            }.buttonStyle(.plain).offset(x: 9, y: -9).accessibilityLabel("移除 \(attachment.name)")
        }
        .task(id: attachment.id) {
            if let data = attachment.previewData { image = UIImage(data: data) }
        }
        .accessibilityLabel(attachment.name)
    }
}
