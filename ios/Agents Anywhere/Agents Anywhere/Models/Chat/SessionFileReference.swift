import Foundation

/// Device paths stay on the connector. A location is carried separately from
/// the path so it cannot become part of the scoped file read request.
nonisolated struct SessionFileReference: Hashable, Identifiable {
    let path: String
    var line: Int? = nil
    var column: Int? = nil
    var id: String { link?.absoluteString ?? path }

    init(path: String, line: Int? = nil, column: Int? = nil) {
        self.path = path
        self.line = line.flatMap { $0 > 0 ? $0 : nil }
        self.column = self.line == nil ? nil : column.flatMap { $0 > 0 ? $0 : nil }
    }

    static func parse(_ value: String) -> Self {
        let pattern = #"(?::(\d+)(?::(\d+))?|#L(\d+)(?:C(\d+))?)$"#
        guard let range = value.range(of: pattern, options: .regularExpression) else { return Self(path: value) }
        let suffix = String(value[range])
        let numbers = suffix.split(whereSeparator: { !$0.isNumber }).map { Int($0) }
        return Self(path: String(value[..<range.lowerBound]), line: numbers.first ?? nil, column: numbers.count > 1 ? numbers[1] : nil)
    }

    static func reference(from url: URL) -> Self? {
        let decoded = url.absoluteString.removingPercentEncoding ?? url.absoluteString
        if decoded.range(of: #"^[a-zA-Z]:[/\\]"#, options: .regularExpression) != nil || decoded.hasPrefix("\\\\") {
            return parse(decoded)
        }
        if parse(decoded).line != nil, let reference = inlineReference(decoded) { return reference }
        let scheme = url.scheme?.lowercased()
        if scheme == "aa-workspace-file" {
            guard url.host == "preview", let fields = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems,
                  let path = fields.first(where: { $0.name == "path" })?.value, !path.isEmpty else { return nil }
            return Self(path: path, line: fields.first(where: { $0.name == "line" })?.value.flatMap(Int.init),
                column: fields.first(where: { $0.name == "column" })?.value.flatMap(Int.init))
        }
        guard scheme == nil || ["file", "sandbox"].contains(scheme ?? ""),
              url.host == nil || url.host?.isEmpty == true || url.host == "localhost" else { return nil }
        let raw = scheme == nil ? url.relativeString : url.path(percentEncoded: true) + (url.fragment(percentEncoded: true).map { "#" + $0 } ?? "")
        guard !raw.hasPrefix("#"), !raw.hasPrefix("//"), !raw.isEmpty else { return nil }
        return parse(raw.removingPercentEncoding ?? raw)
    }

    static func inlineReference(_ text: String) -> Self? {
        guard !text.isEmpty, !text.contains(where: { $0.isNewline }), !text.contains("://"),
              !text.hasPrefix("//") else { return nil }
        let reference = parse(text)
        let path = reference.path
        let explicit = path.hasPrefix("/") || path.hasPrefix("./") || path.hasPrefix("../") || path.hasPrefix("~/")
            || path.hasPrefix(".\\") || path.hasPrefix("..\\") || path.hasPrefix("~\\")
            || path.hasPrefix("\\\\") || path.range(of: #"^[A-Za-z]:[/\\]"#, options: .regularExpression) != nil
        let name = path.replacingOccurrences(of: "\\", with: "/").split(separator: "/").last.map(String.init) ?? path
        let fileName = name.range(of: #"^(?:[\p{L}\p{N}_@+ -]+\.)+[\p{L}\p{N}_+-]+$|^\.[\p{L}\p{N}_-]+$"#, options: .regularExpression) != nil
            || ["Dockerfile", "Makefile", "Justfile", "LICENSE", "README", "AGENTS.md"].contains(name)
        let knownFile = ["md", "txt", "swift", "ts", "tsx", "js", "jsx", "json", "jsonc", "yaml", "yml", "toml", "xml", "html", "css", "scss", "py", "rs", "go", "java", "kt", "kts", "c", "h", "cpp", "hpp", "m", "mm", "sh", "zsh", "sql", "vue", "svelte", "png", "jpg", "jpeg", "webp", "svg", "pdf", "csv", "log"].contains(name.split(separator: ".").last.map(String.init)?.lowercased() ?? "")
            || ["Dockerfile", "Makefile", "Justfile", "LICENSE", "README", ".gitignore", ".env", ".npmrc", ".yarnrc", ".editorconfig"].contains(name)
        guard explicit || fileName && (path.contains("/") || path.contains("\\") || knownFile) else { return nil }
        // Inline code containing a command or sentence should remain code.
        guard explicit || !text.contains(where: { $0.isWhitespace }) else { return nil }
        guard !path.isEmpty else { return nil }
        return reference
    }

    var link: URL? {
        var value = URLComponents(); value.scheme = "aa-workspace-file"; value.host = "preview"
        value.queryItems = [URLQueryItem(name: "path", value: path)]
        if let line { value.queryItems?.append(URLQueryItem(name: "line", value: String(line))) }
        if let column { value.queryItems?.append(URLQueryItem(name: "column", value: String(column))) }
        return value.url
    }

    static func path(from url: URL) -> String? { reference(from: url)?.path }
    static func inlinePath(_ text: String) -> String? { inlineReference(text)?.path }
    static func link(_ path: String) -> URL? { Self(path: path).link }
    static func stripLocation(_ path: String) -> String { parse(path).path }
}
