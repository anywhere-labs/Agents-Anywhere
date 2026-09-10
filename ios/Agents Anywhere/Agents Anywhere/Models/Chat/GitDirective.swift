import Foundation

nonisolated struct GitDirective: Hashable, Sendable {
    enum Action: String, Sendable { case stage, commit, createBranch = "create-branch", push, createPR = "create-pr" }
    let action: Action
    let attributes: [String: String]

    var label: String {
        let branch = attributes["branch"].flatMap { $0.isEmpty ? nil : $0 }
        switch action {
        case .stage: return String(localized: "已暂存")
        case .commit: return String(localized: "已提交")
        case .createBranch: return branch.map { String(localized: "已创建分支 \($0)") } ?? String(localized: "已创建分支")
        case .push: return branch.map { String(localized: "已推送 \($0)") } ?? String(localized: "已推送")
        case .createPR:
            let title = attributes["isDraft"] == "true" ? String(localized: "已创建草稿 PR") : String(localized: "已创建 PR")
            return title + (branch.map { " · " + $0 } ?? "")
        }
    }
    var url: URL? {
        guard action == .createPR, let value = attributes["url"], let url = URL(string: value),
              ["https", "http"].contains(url.scheme?.lowercased() ?? ""), url.host != nil else { return nil }
        return url
    }
}

nonisolated enum GitDirectiveParser {
    struct Match: Equatable { let range: NSRange; let directives: [GitDirective] }
    private static let pattern = try! NSRegularExpression(pattern: #"::git-(stage|commit|create-branch|push|create-pr)\{((?:[^"{}]|"(?:\\.|[^"\\])*")*)\}"#)
    private static let attributes = try! NSRegularExpression(pattern: #"([A-Za-z][A-Za-z0-9_-]*)\s*=\s*"((?:\\.|[^"\\])*)""#)

    static func matches(in text: String) -> [Match] {
        let source = text as NSString
        var result: [Match] = []
        for match in pattern.matches(in: text, range: NSRange(location: 0, length: source.length)) {
            guard let action = GitDirective.Action(rawValue: source.substring(with: match.range(at: 1))) else { continue }
            let body = source.substring(with: match.range(at: 2)) as NSString
            var values: [String: String] = [:]
            for attribute in attributes.matches(in: body as String, range: NSRange(location: 0, length: body.length)) {
                let value = body.substring(with: attribute.range(at: 2))
                let decoded = try? JSONDecoder().decode(String.self, from: Data(("\"" + value + "\"").utf8))
                values[body.substring(with: attribute.range(at: 1))] = decoded ?? value
            }
            let directive = GitDirective(action: action, attributes: values)
            if let last = result.last, source.substring(with: NSRange(location: NSMaxRange(last.range), length: match.range.location - NSMaxRange(last.range)))
                .trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                result[result.count - 1] = Match(range: NSRange(location: last.range.location, length: NSMaxRange(match.range) - last.range.location), directives: last.directives + [directive])
            } else { result.append(Match(range: match.range, directives: [directive])) }
        }
        return result
    }

    /// Enrich only prose runs after Markdown parsing; code examples and links
    /// retain their original text and all block identities stay intact.
    static func enrich(_ document: AttributedString, replacement: ([GitDirective], AttributeContainer) -> AttributedString) -> AttributedString {
        var result = AttributedString()
        for run in document.runs {
            let fragment = AttributedString(document[run.range])
            let isCodeBlock = run.presentationIntent?.components.contains { if case .codeBlock = $0.kind { return true }; return false } == true
            guard !isCodeBlock, run.inlinePresentationIntent?.intersection([.code, .inlineHTML, .blockHTML]).isEmpty != false, run.link == nil else {
                result += fragment; continue
            }
            let text = String(fragment.characters)
            let source = text as NSString
            var cursor = 0
            for match in matches(in: text) {
                result += AttributedString(source.substring(with: NSRange(location: cursor, length: match.range.location - cursor)), attributes: run.attributes)
                result += replacement(match.directives, run.attributes)
                cursor = NSMaxRange(match.range)
            }
            result += AttributedString(source.substring(from: cursor), attributes: run.attributes)
        }
        return result
    }
}
