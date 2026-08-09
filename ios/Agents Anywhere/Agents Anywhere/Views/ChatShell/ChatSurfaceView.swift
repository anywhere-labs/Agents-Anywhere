import SwiftUI

struct ChatSurfaceView: View {
    let conversationTitle: String?
    let topInset: CGFloat
    let bottomInset: CGFloat
    let onMenu: () -> Void
    let onNewChat: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            ChatSurfaceHeader(
                conversationTitle: conversationTitle,
                topInset: topInset,
                onMenu: onMenu,
                onNewChat: onNewChat,
            )

            ChatSurfaceEmptyState(conversationTitle: conversationTitle)

            ChatComposer(bottomInset: bottomInset)
        }
    }
}

private struct ChatSurfaceHeader: View {
    let conversationTitle: String?
    let topInset: CGFloat
    let onMenu: () -> Void
    let onNewChat: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            ChatCircleButton(systemImage: "line.3.horizontal", label: "Open sidebar", action: onMenu)

            Text(conversationTitle ?? "Agents Anywhere")
                .font(.headline)
                .lineLimit(1)
                .frame(maxWidth: .infinity)

            ChatCircleButton(systemImage: "square.and.pencil", label: "New chat", action: onNewChat)
        }
        .padding(.horizontal, 14)
        .padding(.top, topInset + 8)
        .padding(.bottom, 10)
    }
}

private struct ChatCircleButton: View {
    let systemImage: String
    let label: LocalizedStringResource
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.body.weight(.semibold))
                .frame(width: 42, height: 42)
                .background(.thinMaterial, in: Circle())
                .overlay {
                    Circle()
                        .strokeBorder(.primary.opacity(0.1), lineWidth: 1)
                }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text(label))
    }
}

private struct ChatSurfaceEmptyState: View {
    let conversationTitle: String?

    var body: some View {
        VStack(spacing: 16) {
            Spacer()

            Image(systemName: conversationTitle == nil ? "sparkles" : "ellipsis.message")
                .font(.largeTitle.weight(.medium))
                .foregroundStyle(.secondary)

            if let conversationTitle {
                Text(conversationTitle)
                    .font(.title2.weight(.semibold))
                    .multilineTextAlignment(.center)
            } else {
                Text("What can I help with?", comment: "Empty-state prompt on the mock chat home screen.")
                    .font(.title2.weight(.semibold))
                    .multilineTextAlignment(.center)
            }

            Spacer()
        }
        .padding(.horizontal, 28)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

private struct ChatComposer: View {
    let bottomInset: CGFloat

    @State private var prompt = ""

    var body: some View {
        HStack(alignment: .bottom, spacing: 10) {
            Button(action: {}) {
                Image(systemName: "plus")
                    .font(.body.weight(.semibold))
                    .frame(width: 38, height: 38)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Add attachment")

            TextField("Message", text: $prompt, axis: .vertical)
                .lineLimit(1 ... 5)
                .textFieldStyle(.plain)
                .padding(.vertical, 9)

            Button(action: {}) {
                Image(systemName: "arrow.up")
                    .font(.body.weight(.bold))
                    .foregroundStyle(.background)
                    .frame(width: 36, height: 36)
                    .background(.primary, in: Circle())
            }
            .buttonStyle(.plain)
            .disabled(prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            .opacity(prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? 0.45 : 1)
            .accessibilityLabel("Send message")
        }
        .padding(.leading, 10)
        .padding(.trailing, 8)
        .padding(.vertical, 6)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 26, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 26, style: .continuous)
                .strokeBorder(.primary.opacity(0.12), lineWidth: 1)
        }
        .padding(.horizontal, 12)
        .padding(.bottom, max(bottomInset, 10))
    }
}
