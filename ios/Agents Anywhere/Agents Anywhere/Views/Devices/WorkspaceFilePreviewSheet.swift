import SwiftUI
import WebKit

/// Every fs-backed preview uses the same scoped Web preview as the Web client.
/// Native code only creates its one-use entry token; file rendering stays in Web.
struct WorkspaceFilePreviewSheet: View {
    let connectorId: String
    let root: String
    let path: String
    let service: V2WorkspaceFilesService
    var session: V2SessionModel?
    @State private var url: URL?
    @State private var error: String?
    @State private var loading = true
    @State private var attempt = 0
    @State private var downloadedFile: WorkspaceDownloadedFile?
    @State private var isDownloading = false
    @State private var downloadToasts = ChatToastStore()
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    private var name: String { (path.replacingOccurrences(of: "\\", with: "/") as NSString).lastPathComponent }
    private var canRead: Bool {
        guard let session else { return true }
        return session.isValid && session.network.availability != .offline && session.metadata?.connectorStatus == .online
    }
    var body: some View {
        NavigationStack {
            ZStack {
                if let url {
                    WorkspacePreviewWebView(url: url, onLoaded: { loading = false }, onFailure: {
                        loading = false; error = $0
                    }, onClose: { dismiss() }, onExternal: { openURL($0) },
                        onDownload: { downloadedFile = $0 }, onDownloadFailure: downloadFailed,
                        onDownloading: { isDownloading = $0 }).id(url)
                }
                if let error {
                    ContentUnavailableView {
                        Label("无法预览文件", systemImage: "doc.badge.ellipsis")
                    } description: { Text(error) } actions: { Button("重试") { attempt += 1 }.disabled(!canRead) }
                    .background(Color(uiColor: .systemBackground))
                } else if loading { ProgressView("加载预览…").padding(20).background(.regularMaterial, in: .rect(cornerRadius: 18)) }
            }
            .navigationTitle(name.isEmpty ? "文件预览" : name).navigationBarTitleDisplayMode(.inline)
            .safeAreaInset(edge: .bottom, spacing: 0) {
                if !canRead { Text("设备或网络已离线，恢复连接后可重新加载。")
                    .font(.footnote).foregroundStyle(.secondary).padding(12).frame(maxWidth: .infinity).background(.regularMaterial) }
            }
            .toolbar {
                if isDownloading { ToolbarItem(placement: .topBarTrailing) { ProgressView().accessibilityLabel("正在下载") } }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("重新加载", systemImage: "arrow.clockwise") { attempt += 1 }.disabled(!canRead || loading)
                }
                ToolbarItem(placement: .confirmationAction) { Button("关闭", systemImage: "xmark") { dismiss() } }
            }
        }
        .presentationDetents([.large]).presentationDragIndicator(.visible)
        .overlay(alignment: .top) {
            ChatErrorToasts(store: downloadToasts, isRetrying: false, onRetry: { _ in })
        }
        .sheet(item: $downloadedFile) { file in
            WorkspaceFileActivitySheet(file: file) { error in
                downloadedFile = nil
                if let error { downloadFailed(error) }
            }
        }
        .task(id: "\(attempt):\(canRead)") {
            guard canRead else { loading = false; return }
            // Reload needs a fresh entry token; the previous token may be consumed.
            loading = true; error = nil; url = nil; isDownloading = false
            do {
                let entry = V2WorkspaceEntry(name: name, path: path, type: "file", size: nil, modifiedAt: nil)
                let prepared = try await service.previewURL(connectorId: connectorId, root: root, entry: entry)
                try Task.checkCancellation()
                guard canRead else { return }
                url = prepared
            } catch { if !Task.isCancelled { loading = false; self.error = error.localizedDescription } }
        }
    }
    private func downloadFailed(_ message: String) {
        downloadToasts.update(source: "download", failure: V2ClientFailure(kind: .rejected, message: message))
    }
}

private struct WorkspacePreviewWebView: UIViewRepresentable {
    let url: URL
    let onLoaded: () -> Void
    let onFailure: (String) -> Void
    let onClose: () -> Void
    let onExternal: (URL) -> Void
    let onDownload: (WorkspaceDownloadedFile) -> Void
    let onDownloadFailure: (String) -> Void
    let onDownloading: (Bool) -> Void
    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator; webView.uiDelegate = context.coordinator
        webView.isOpaque = false; webView.backgroundColor = .systemBackground
        webView.load(URLRequest(url: url))
        return webView
    }
    func updateUIView(_ view: WKWebView, context: Context) {
        context.coordinator.parent = self
        context.coordinator.downloads.onComplete = onDownload
        context.coordinator.downloads.onFailure = onDownloadFailure
        context.coordinator.downloads.onLoading = onDownloading
    }
    static func dismantleUIView(_ view: WKWebView, coordinator: Coordinator) {
        coordinator.downloads.cancel()
        view.stopLoading(); view.navigationDelegate = nil; view.uiDelegate = nil
    }
    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        var parent: WorkspacePreviewWebView
        let downloads: WorkspacePreviewDownloads
        init(_ parent: WorkspacePreviewWebView) {
            self.parent = parent
            downloads = WorkspacePreviewDownloads(onComplete: parent.onDownload, onFailure: parent.onDownloadFailure, onLoading: parent.onDownloading)
        }
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { parent.onLoaded() }
        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { failed(error) }
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { failed(error) }
        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { parent.onFailure("预览页面已退出，请重新加载。") }
        func webViewDidClose(_ webView: WKWebView) { parent.onClose() }
        private func failed(_ error: Error) {
            if (error as? URLError)?.code != .cancelled { parent.onFailure(error.localizedDescription) }
        }
        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let target = action.request.url else { decisionHandler(.cancel); return }
            let scheme = target.scheme?.lowercased() ?? ""
            if ["about", "blob", "data"].contains(scheme) { decisionHandler(action.shouldPerformDownload ? .download : .allow); return }
            guard ["http", "https"].contains(scheme) else { decisionHandler(.cancel); return }
            if target.scheme == parent.url.scheme && target.host == parent.url.host && target.port == parent.url.port {
                decisionHandler(action.shouldPerformDownload ? .download : .allow)
            } else {
                decisionHandler(.cancel)
                if action.navigationType == .linkActivated { parent.onExternal(target) }
            }
        }
        func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
            decisionHandler(response.canShowMIMEType ? .allow : .download)
        }
        func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { downloads.attach(download) }
        func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { downloads.attach(download) }
        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            if let url = action.request.url, ["http", "https"].contains(url.scheme ?? "") { parent.onExternal(url) }
            return nil
        }
    }
}
