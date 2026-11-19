import UIKit
import UniformTypeIdentifiers
import WebKit

/// Serves `aa-app://renderer/renderer.html` from the app bundle (or `AA_POC_RENDERER_PATH`) and
/// `aa-app://file?path=<percent-encoded>` as a generated placeholder image. The page never sees credentials:
/// a real app would fetch attachments here with its own token.
final class RendererSchemeHandler: NSObject, WKURLSchemeHandler {
    static let scheme = "aa-app"
    static let rendererURL = URL(string: "aa-app://renderer/renderer.html")!

    /// The renderer file, or nil when it was not bundled.
    static var rendererFile: URL? {
        if let path = DebugLaunch.rendererPath { return URL(fileURLWithPath: path) }
        return Bundle.main.url(forResource: "renderer", withExtension: "html")
    }

    func webView(_ webView: WKWebView, start task: any WKURLSchemeTask) {
        guard let url = task.request.url else { return fail(task, code: 400) }
        switch url.host {
        case "renderer":
            // Single-file build: renderer.html. Any other name is looked up next to it, for a split build.
            let name = url.lastPathComponent.isEmpty ? "renderer.html" : url.lastPathComponent
            let file: URL? = name == "renderer.html" ? Self.rendererFile
                : Self.rendererFile?.deletingLastPathComponent().appendingPathComponent(name)
            guard let file, let data = try? Data(contentsOf: file) else { return fail(task, code: 404) }
            respond(task, url: url, data: data, mime: UTType(filenameExtension: file.pathExtension)?.preferredMIMEType ?? "text/html")
        case "file":
            let path = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "path" }?.value ?? "file"
            let data = Self.placeholderImage(name: (path as NSString).lastPathComponent)
            respond(task, url: url, data: data, mime: "image/png")
        default:
            fail(task, code: 404)
        }
    }

    func webView(_ webView: WKWebView, stop task: any WKURLSchemeTask) {}

    private func respond(_ task: any WKURLSchemeTask, url: URL, data: Data, mime: String) {
        let headers = ["Content-Type": mime.hasPrefix("text/") ? "\(mime); charset=utf-8" : mime,
                       "Content-Length": "\(data.count)", "Cache-Control": "no-store"]
        let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers)!
        task.didReceive(response)
        task.didReceive(data)
        task.didFinish()
    }

    private func fail(_ task: any WKURLSchemeTask, code: Int) {
        if let url = task.request.url,
           let response = HTTPURLResponse(url: url, statusCode: code, httpVersion: "HTTP/1.1", headerFields: [:]) {
            task.didReceive(response)
            task.didReceive(Data())
            task.didFinish()
        } else {
            task.didFailWithError(URLError(.fileDoesNotExist))
        }
    }

    /// A screenshot-like placeholder with the file name, standing in for an attachment fetched with the user's token.
    static func placeholderImage(name: String) -> Data {
        let size = CGSize(width: 480, height: 320)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 2
        return UIGraphicsImageRenderer(size: size, format: format).pngData { context in
            let cg = context.cgContext
            let colors = [UIColor(red: 0.90, green: 0.93, blue: 0.97, alpha: 1).cgColor,
                          UIColor(red: 0.80, green: 0.86, blue: 0.94, alpha: 1).cgColor] as CFArray
            if let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: colors, locations: [0, 1]) {
                cg.drawLinearGradient(gradient, start: .zero, end: CGPoint(x: size.width, y: size.height), options: [])
            }
            UIColor.white.withAlphaComponent(0.85).setFill()
            UIBezierPath(roundedRect: CGRect(x: 32, y: 32, width: 416, height: 196), cornerRadius: 18).fill()
            UIColor(white: 0.78, alpha: 1).setFill()
            for (index, width) in [260.0, 340, 300, 220].enumerated() {
                UIBezierPath(roundedRect: CGRect(x: 56, y: 60 + Double(index) * 36, width: width, height: 14), cornerRadius: 7).fill()
            }
            UIColor.systemGreen.setFill()
            UIBezierPath(ovalIn: CGRect(x: 404, y: 54, width: 20, height: 20)).fill()
            let attributes: [NSAttributedString.Key: Any] = [.font: UIFont.systemFont(ofSize: 22, weight: .semibold),
                                                             .foregroundColor: UIColor(white: 0.25, alpha: 1)]
            // Centered: renderers crop thumbnails to their own aspect ratio.
            let text = name as NSString
            let width = min(text.size(withAttributes: attributes).width, size.width - 120)
            text.draw(with: CGRect(x: (size.width - width) / 2, y: 258, width: width, height: 30),
                      options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine], attributes: attributes, context: nil)
        }
    }
}
