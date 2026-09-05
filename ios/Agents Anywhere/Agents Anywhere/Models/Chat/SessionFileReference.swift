import Foundation

/// Device paths are interpreted by the server's scoped preview service, never
/// opened as files on this iPhone. Web links retain normal system navigation.
nonisolated enum SessionFileReference {
    static func path(from url: URL) -> String? {
        if url.absoluteString.range(of: "^[a-zA-Z]:[/\\\\]", options: .regularExpression) != nil {
            return stripLocation(url.absoluteString.removingPercentEncoding ?? url.absoluteString)
        }
        let scheme = url.scheme?.lowercased()
        if scheme == "aa-workspace-file" {
            return URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "path" }?.value
        }
        guard scheme == nil || ["file", "sandbox"].contains(scheme ?? "") else { return nil }
        guard url.host == nil || url.host?.isEmpty == true || url.host == "localhost" else { return nil }
        let raw = scheme == nil ? url.relativeString : url.path
        guard !raw.hasPrefix("#"), !raw.hasPrefix("//"), !raw.isEmpty else { return nil }
        return stripLocation(raw.removingPercentEncoding ?? raw)
    }
    static func inlinePath(_ text: String) -> String? {
        guard !text.contains(" "), !text.contains("://"), text.contains("/"),
              text.range(of: "\\.[a-zA-Z0-9]+(?::\\d+(?::\\d+)?)?$", options: .regularExpression) != nil else { return nil }
        return stripLocation(text)
    }
    static func link(_ path: String) -> URL? {
        var value = URLComponents(); value.scheme = "aa-workspace-file"; value.host = "preview"
        value.queryItems = [URLQueryItem(name: "path", value: path)]
        return value.url
    }
    static func stripLocation(_ path: String) -> String {
        path.replacingOccurrences(of: "(?::\\d+(?::\\d+)?|#L\\d+(?:C\\d+)?)$", with: "", options: .regularExpression)
    }
}
