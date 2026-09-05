import WebKit

/// Handles the Web preview's download links (including blob URLs) using WebKit's
/// native download pipeline, then hands the resulting file to the system sheet.
@MainActor final class WorkspacePreviewDownloads: NSObject, WKDownloadDelegate {
    var onComplete: (WorkspaceDownloadedFile) -> Void
    var onFailure: (String) -> Void
    var onLoading: (Bool) -> Void
    private var active: WKDownload?
    private var destination: URL?
    private var name = "download"

    init(onComplete: @escaping (WorkspaceDownloadedFile) -> Void, onFailure: @escaping (String) -> Void,
         onLoading: @escaping (Bool) -> Void) {
        self.onComplete = onComplete; self.onFailure = onFailure; self.onLoading = onLoading
    }

    func attach(_ download: WKDownload) {
        guard active == nil else { download.cancel(nil); return }
        active = download; download.delegate = self; onLoading(true)
    }

    func cancel() {
        let download = active
        active = nil; download?.delegate = nil
        let temporary = destination
        destination = nil
        download?.cancel { _ in if let temporary { try? FileManager.default.removeItem(at: temporary) } }
    }

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String,
                  completionHandler: @escaping (URL?) -> Void) {
        guard active === download else { completionHandler(nil); return }
        name = suggestedFilename
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("aa-web-download-\(UUID().uuidString)")
        destination = file
        completionHandler(file)
    }

    func download(_ download: WKDownload, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                  decisionHandler: @escaping (WKDownload.RedirectPolicy) -> Void) {
        guard let origin = download.webView?.url, request.url?.hasSameOrigin(as: origin) == true else {
            decisionHandler(.cancel); return
        }
        decisionHandler(.allow)
    }

    func downloadDidFinish(_ download: WKDownload) {
        guard active === download, let file = destination else { return }
        defer { finish() }
        do { onComplete(try WorkspaceDownloadedFile(moving: file, name: name)) }
        catch { onFailure(error.localizedDescription) }
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        guard active === download else { return }
        finish()
        if (error as? URLError)?.code != .cancelled { onFailure(error.localizedDescription) }
    }

    private func finish() {
        if let destination { try? FileManager.default.removeItem(at: destination) }
        destination = nil; active?.delegate = nil; active = nil; onLoading(false)
    }
}
