import Foundation

/// Remote path comparison follows the server, not the filesystem of this phone.
nonisolated enum ProjectWorkspacePath {
    static func project(in projects: [V2Project], connectorID: String, path: String, deviceOS: String?) -> V2Project? {
        guard let key = key(path, deviceOS: deviceOS) else { return nil }
        return projects.first { $0.connectorId == connectorID && self.key($0.workspacePath, deviceOS: deviceOS) == key }
    }

    static func name(_ path: String) -> String {
        let value = path.trimmingCharacters(in: .whitespacesAndNewlines)
        let windows = value.range(of: "^[A-Za-z]:[/\\\\]", options: .regularExpression) != nil || value.hasPrefix("\\\\")
        let parts = (windows ? value.replacingOccurrences(of: "\\", with: "/") : value).split(separator: "/")
        if parts.isEmpty || (windows && (parts.count == 1 || (value.hasPrefix("\\\\") && parts.count == 2))) {
            return "Workspace"
        }
        return String(parts.last!)
    }

    static func availableName(_ name: String, projects: [V2Project], ignoring id: String? = nil) -> String {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let base = String((trimmed.isEmpty ? "Workspace" : trimmed).unicodeScalars.prefix(255))
        let names = Set(projects.filter { $0.id != id }.map(\.name))
        var candidate = base
        var suffix = 1
        while names.contains(candidate) {
            let ending = " (\(suffix))"
            candidate = String(base.unicodeScalars.prefix(255 - ending.count)) + ending
            suffix += 1
        }
        return candidate
    }

    static func parent(_ path: String) -> String? {
        guard let normalized = key(path, deviceOS: nil) else { return nil }
        let windows = normalized.range(of: "^[a-z]:/", options: .regularExpression) != nil || path.hasPrefix("\\\\")
        let slashes = windows ? path.replacingOccurrences(of: "\\", with: "/") : path
        var parts = slashes.split(separator: "/")
        if windows, parts.count == 1 { return "" } // Connector fs/list's Windows drive picker.
        if slashes.hasPrefix("//"), parts.count <= 2 { return nil }
        guard !parts.isEmpty else { return nil }
        parts.removeLast()
        if windows { return (slashes.hasPrefix("//") ? "//" : "") + parts.joined(separator: "/") + (parts.count == 1 ? "/" : "") }
        return (slashes.hasPrefix("//") ? "//" : "/") + parts.joined(separator: "/")
    }

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
    var errorDescription: String? { String(localized: "这个目录已属于项目「\(project.name)」。") }
}
