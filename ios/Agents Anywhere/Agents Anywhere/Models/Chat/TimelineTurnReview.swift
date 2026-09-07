import Foundation

struct TimelineTurnReview: Hashable {
    struct File: Hashable, Identifiable {
        let id: String
        let path: String
        let displayPath: String
        var action: TimelineFileChange.Action
        var patches: [Patch]
        var additions: Int { patches.reduce(0) { $0 + $1.additions } }
        var deletions: Int { patches.reduce(0) { $0 + $1.deletions } }
    }
    struct Patch: Hashable, Identifiable {
        let id: String
        let text: String
        let isDiff: Bool
        let additions: Int
        let deletions: Int
    }
    let files: [File]
    var additions: Int { files.reduce(0) { $0 + $1.additions } }
    var deletions: Int { files.reduce(0) { $0 + $1.deletions } }

    static func build(items: [V2TimelineItem], root: String?, caseInsensitive: Bool = false) -> Self {
        // Realtime updates replace the same operation; they are not additional
        // patches. Separate operations on a file retain their chronological diffs.
        var byID: [String: V2TimelineItem] = [:]
        for item in items {
            if let old = byID[item.id], old.updatedSeq > item.updatedSeq || old.updatedSeq == item.updatedSeq && old.revision > item.revision { continue }
            byID[item.id] = item
        }
        let latest = byID.values.sorted { a, b in
            a.orderSeq == b.orderSeq ? a.id < b.id : a.orderSeq < b.orderSeq
        }
        var ordered: [String] = []
        var files: [String: File] = [:]
        for item in latest where item.isFileChange {
            for (index, raw) in TimelineFileChange.rawChanges(item.raw["content"] ?? .object([:])).enumerated() {
                let change = TimelineFileChange(raw: raw, index: index, cwd: root)
                guard let rawPath = change.path, !rawPath.isEmpty else { continue }
                let path = resolvedPath(rawPath, root: root)
                let foldsCase = caseInsensitive || path.range(of: #"^[A-Za-z]:/|^//"#, options: .regularExpression) != nil
                let key = foldsCase ? path.lowercased() : path
                let next = change.action
                if files[key]?.action == .add && next == .delete {
                    files.removeValue(forKey: key); ordered.removeAll { $0 == key }; continue
                }
                var file = files[key] ?? File(id: key, path: path, displayPath: displayPath(path, root: root, caseInsensitive: foldsCase), action: next, patches: [])
                if files[key] == nil { ordered.append(key) }
                else if file.action == .delete && next == .add { file.action = .modify }
                else if next == .delete || file.action != .add { file.action = next }
                if let code = change.diff ?? change.code, !code.isEmpty {
                    let counts = change.diff == nil ? (0, 0) : lineCounts(code)
                    file.patches.append(Patch(id: "\(item.id):\(index)", text: code, isDiff: change.diff != nil, additions: counts.0, deletions: counts.1))
                }
                files[key] = file
            }
        }
        return Self(files: ordered.compactMap { files[$0] })
    }

    static func lineCounts(_ diff: String) -> (Int, Int) {
        var additions = 0, deletions = 0
        for line in diff.split(separator: "\n", omittingEmptySubsequences: false) {
            if line.hasPrefix("+++ ") || line.hasPrefix("--- ") { continue }
            if line.hasPrefix("+") { additions += 1 }
            else if line.hasPrefix("-") { deletions += 1 }
        }
        return (additions, deletions)
    }

    static func resolvedPath(_ path: String, root: String?) -> String {
        let value = path.replacingOccurrences(of: "\\", with: "/")
        let absolute = value.hasPrefix("/") || value.hasPrefix("~/") || value.range(of: #"^[A-Za-z]:/"#, options: .regularExpression) != nil
        let joined = absolute || root == nil || root == "." ? value : root!.replacingOccurrences(of: "\\", with: "/") + "/" + value
        let prefix = joined.hasPrefix("//") ? "//" : joined.hasPrefix("/") ? "/" : ""
        var parts: [Substring] = []
        for part in joined.split(separator: "/") {
            if part == "." { continue }
            if part == "..", let last = parts.last, last != "..", !last.hasSuffix(":"), last != "~" { parts.removeLast() }
            else if part == "..", !prefix.isEmpty, parts.isEmpty { continue }
            else { parts.append(part) }
        }
        return prefix + parts.joined(separator: "/")
    }

    private static func displayPath(_ path: String, root: String?, caseInsensitive: Bool) -> String {
        guard let root, root != "." else { return path }
        let prefix = resolvedPath(root, root: nil).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let normalizedRoot = (root.hasPrefix("/") ? (root.hasPrefix("//") ? "//" : "/") : "") + prefix + "/"
        let matches = caseInsensitive ? path.lowercased().hasPrefix(normalizedRoot.lowercased()) : path.hasPrefix(normalizedRoot)
        return matches ? String(path.dropFirst(normalizedRoot.count)) : path
    }
}

extension V2TimelineItem {
    var isFileChange: Bool { type == .fileChange || raw["content"]?["kind"] == .string("file_change") }
    var startsVisibleTurn: Bool {
        guard type == .message, role == .user else { return false }
        if TimelineText.first(source["itemType"], source["rawType"]) == "steeringUserMessage" { return false }
        if source["runtime"] == .string("claude"),
           ["[Request interrupted by user]", "[Request interrupted by user for tool use]"].contains(displayText.trimmingCharacters(in: .whitespacesAndNewlines)) { return false }
        return true
    }
}
