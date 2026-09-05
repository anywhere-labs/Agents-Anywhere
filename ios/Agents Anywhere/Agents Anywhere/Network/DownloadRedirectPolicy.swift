import Foundation

nonisolated extension URL {
    func hasSameOrigin(as other: URL) -> Bool {
        guard ["http", "https"].contains(scheme?.lowercased() ?? ""), user == nil, password == nil else { return false }
        let defaultPort = scheme?.lowercased() == "https" ? 443 : 80
        let otherDefaultPort = other.scheme?.lowercased() == "https" ? 443 : 80
        return scheme?.lowercased() == other.scheme?.lowercased() && host?.lowercased() == other.host?.lowercased()
            && (port ?? defaultPort) == (other.port ?? otherDefaultPort)
    }
}

nonisolated final class DownloadRedirectPolicy: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    let origin: URL
    init(origin: URL) { self.origin = origin }

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(request.url?.hasSameOrigin(as: origin) == true ? request : nil)
    }
}
