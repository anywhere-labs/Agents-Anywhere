import SafariServices
import SwiftUI
import UIKit

/// "检测到 http://localhost:5173 · 预览" above the composer (preview 1.0, PV-5).
/// Shown only while this session's processes listen on a port, the device declares
/// `session.port_preview` as available and the instance has port preview; a 404 or
/// `preview_disabled` hides it for this app run.
struct SessionPortPreviewCard: View {
    let session: V2SessionModel
    let store: PortPreviewStore
    @State private var notice: NoticeRequest?
    @State private var presented: PresentedPreview?
    @State private var copied: PortPreviewStore.Key?

    private struct NoticeRequest {
        let key: PortPreviewStore.Key
        let view: V3PreviewView
    }

    private struct PresentedPreview: Identifiable {
        let id = UUID()
        let url: URL
    }

    /// The device serves the page; without it (or without a network) nothing opens.
    private var canPreview: Bool {
        session.metadata?.connectorStatus == .online && session.network.availability != .offline
    }

    private var hidden: Bool {
        store.isDisabled || !session.runtime.portPreviewAvailable || session.listeningPorts.isEmpty
    }

    var body: some View {
        // The container stays mounted so an open browser survives the card hiding.
        VStack(alignment: .leading, spacing: 6) {
            let ports = V3SessionPorts.visible(session.listeningPorts)
            if !hidden, !ports.isEmpty {
                ForEach(ports) { row($0) }
            }
        }
        .padding(.horizontal, hidden ? 0 : 16)
        .padding(.vertical, hidden ? 0 : 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityIdentifier("chat.portPreview")
        .onChange(of: Set(session.listeningPorts.keys)) { _, ports in
            store.retain(sessionId: session.id, ports: ports)
        }
        .alert(String(localized: "预览不是端到端加密的"), isPresented: Binding(get: { notice != nil }, set: { if !$0 { notice = nil } }),
               presenting: notice) { request in
            Button(String(localized: "继续预览")) {
                Task { handle(await store.confirmNotice(request.key, view: request.view)) }
            }
            Button(String(localized: "取消"), role: .cancel) {}
        } message: { _ in
            Text(String(localized: "会话内容已端到端加密，但预览页面的流量会经过服务器转发，服务器能看到页面内容。"))
        }
        .sheet(item: $presented) { preview in
            InAppSafariView(url: preview.url) { presented = nil }.ignoresSafeArea()
        }
    }

    @ViewBuilder private func row(_ port: V3ListeningPort) -> some View {
        let key = PortPreviewStore.Key(sessionId: session.id, port: port.port)
        let phase = store.phase(key)
        let busy = phase == .opening || store.launching.contains(key)
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Image(systemName: "globe").font(.subheadline).foregroundStyle(.secondary).accessibilityHidden(true)
                Text(String(localized: "检测到 \(port.localURL)"))
                    .font(.subheadline).lineLimit(1).truncationMode(.middle)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if busy { ProgressView().controlSize(.small) }
                Button(String(localized: "预览")) { preview(key) }
                    .buttonStyle(.bordered).controlSize(.small)
                    .disabled(!canPreview || busy || phase.isStopping)
            }
            if let view = phase.view {
                HStack(spacing: 16) {
                    Button(String(localized: "停止预览"), systemImage: "stop.circle") { Task { await store.stop(key) } }
                        .disabled(phase.isStopping)
                    if let url = view.url, !url.isEmpty {
                        Button(copied == key ? String(localized: "已复制") : String(localized: "复制链接"), systemImage: "doc.on.doc") {
                            // The preview domain address, not the one-time ticket.
                            UIPasteboard.general.string = url
                            copied = key
                            Task { try? await Task.sleep(for: .seconds(2)); if copied == key { copied = nil } }
                        }
                    }
                }
                .font(.caption).buttonStyle(.plain).foregroundStyle(.tint)
                .padding(.leading, 24)
            }
            if let message = store.messages[key] {
                Text(message).font(.caption).foregroundStyle(.red).padding(.leading, 24)
            }
        }
    }

    private func preview(_ key: PortPreviewStore.Key) {
        guard let deviceId = session.metadata?.connectorId else { return }
        Task { handle(await store.preview(key, deviceId: deviceId)) }
    }

    private func handle(_ step: PortPreviewStore.Step) {
        switch step {
        case let .confirm(view):
            notice = NoticeRequest(key: .init(sessionId: session.id, port: view.port), view: view)
        case let .present(url):
            presented = PresentedPreview(url: url)
        case .none:
            break
        }
    }
}

private extension PortPreviewStore.Phase {
    var isStopping: Bool { if case .stopping = self { true } else { false } }
}

/// The ticket URL opens in an in-app Safari view; its cookie stays in that view.
struct InAppSafariView: UIViewControllerRepresentable {
    let url: URL
    let onFinish: () -> Void

    func makeUIViewController(context: Context) -> SFSafariViewController {
        let controller = SFSafariViewController(url: url)
        controller.dismissButtonStyle = .done
        controller.delegate = context.coordinator
        return controller
    }

    func updateUIViewController(_ controller: SFSafariViewController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(onFinish: onFinish) }

    final class Coordinator: NSObject, SFSafariViewControllerDelegate {
        let onFinish: () -> Void
        init(onFinish: @escaping () -> Void) { self.onFinish = onFinish }
        func safariViewControllerDidFinish(_ controller: SFSafariViewController) { onFinish() }
    }
}
