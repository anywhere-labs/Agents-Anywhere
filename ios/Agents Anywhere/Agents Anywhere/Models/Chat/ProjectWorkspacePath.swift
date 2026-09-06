import Foundation

/// Remote path comparison follows the server, not the filesystem of this phone.
nonisolated enum ProjectWorkspacePath {
    static func key(_ value: String, deviceOS: String?) -> String? {
        let path = value.trimmingCharacters(in: .whitespacesAndNewlines)
        let drive = path.range(of: "^[A-Za-z]:[/\\\\]", options: .regularExpression) != nil
        let windows = deviceOS == "windows" || drive || path.hasPrefix("\\\\")
        if windows {
            let normalized = path.replacingOccurrences(of: "\\", with: "/")
            guard drive || normalized.hasPrefix("//") else { return nil }
            let parts = normalized.split(separator: "/").filter { $0 != "." }
            if !drive && parts.count < 2 { return nil }
            var result = (drive ? "" : "//") + parts.joined(separator: "/")
            if drive && parts.count == 1 { result += "/" }
            // PureWindowsPath preserves '..'; resolving it here would disagree with the server.
            return result.folding(options: .caseInsensitive, locale: Locale(identifier: "en_US_POSIX"))
        }
        guard path.hasPrefix("/") else { return nil }
        var parts: [Substring] = []
        for part in path.split(separator: "/") {
            if part == "." { continue }
            if part == ".." { if !parts.isEmpty { parts.removeLast() } }
            else { parts.append(part) }
        }
        return (path.hasPrefix("//") && !path.hasPrefix("///") ? "//" : "/") + parts.joined(separator: "/")
    }
}

struct ProjectReuseRequired: LocalizedError {
    let project: V2Project
    var errorDescription: String? { "这个目录已属于项目「\(project.name)」。" }
}
