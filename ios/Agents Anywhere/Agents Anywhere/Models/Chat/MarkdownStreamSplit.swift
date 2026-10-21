import Foundation

/// Streamed Markdown grows at its tail. Text before a safe boundary cannot be
/// changed by anything appended later, so completed blocks are parsed once and
/// only the open tail is re-parsed per batch.
nonisolated enum MarkdownStreamSplit {
    /// The start of the last line that follows a blank line outside any fenced
    /// code block and cannot continue the block before it: a list item or
    /// indented line only qualifies when the previous block was not list-like.
    /// Returns nil when no such boundary exists (short text, an unterminated
    /// fence, or text that ends in blank lines whose successor is unknown).
    static func safeSplitIndex(in text: String) -> String.Index? {
        var candidate: String.Index?
        var fence: (marker: Character, length: Int)?
        var pendingBlank: String.Index?
        var previousWasListLike = false
        var position = text.startIndex
        while position < text.endIndex {
            let lineEnd = text[position...].firstIndex(of: "\n") ?? text.endIndex
            let line = text[position..<lineEnd]
            let next = lineEnd == text.endIndex ? text.endIndex : text.index(after: lineEnd)
            defer { position = next }
            let trimmed = line.drop { $0 == " " || $0 == "\t" }
            if let open = fence {
                if closesFence(trimmed, open) { fence = nil; previousWasListLike = false }
                pendingBlank = nil
                continue
            }
            if trimmed.isEmpty {
                // A run of blank lines ends at the same boundary; keep the latest.
                pendingBlank = next
                continue
            }
            let listLike = continuesPreviousBlock(line)
            if let blank = pendingBlank {
                pendingBlank = nil
                if blank == position, !(listLike && previousWasListLike) { candidate = position }
            }
            previousWasListLike = listLike
            if let open = opensFence(trimmed) { fence = open; previousWasListLike = false }
        }
        return fence == nil ? candidate : nil
    }

    /// Indented lines and list markers may continue a loose list or an
    /// indented code block across the blank line, so they cannot start a segment.
    private static func continuesPreviousBlock(_ line: Substring) -> Bool {
        guard let first = line.first else { return true }
        if first == " " || first == "\t" { return true }
        if "-+*".contains(first) {
            let rest = line.dropFirst()
            return rest.isEmpty || rest.first == " " || rest.first == "\t"
        }
        if first.isNumber {
            let digits = line.prefix { $0.isNumber }
            guard digits.count <= 9 else { return false }
            let rest = line.dropFirst(digits.count)
            guard let delimiter = rest.first, delimiter == "." || delimiter == ")" else { return false }
            let after = rest.dropFirst()
            return after.isEmpty || after.first == " " || after.first == "\t"
        }
        return false
    }

    private static func opensFence(_ trimmed: Substring) -> (marker: Character, length: Int)? {
        guard let marker = trimmed.first, marker == "`" || marker == "~" else { return nil }
        let length = trimmed.prefix { $0 == marker }.count
        guard length >= 3 else { return nil }
        // An info string may follow a backtick fence only if it has no backticks.
        if marker == "`", trimmed.dropFirst(length).contains("`") { return nil }
        return (marker, length)
    }

    private static func closesFence(_ trimmed: Substring, _ open: (marker: Character, length: Int)) -> Bool {
        let length = trimmed.prefix { $0 == open.marker }.count
        return length >= open.length && trimmed.dropFirst(length).allSatisfy { $0 == " " || $0 == "\t" }
    }
}

/// Blocks already parsed for a stable prefix of the streamed text, plus the
/// identifier the next block will receive. Identifiers are assigned in order of
/// appearance so completed blocks keep their identity across batches.
nonisolated struct MarkdownParseState: Sendable {
    var prefixText = ""
    var blocks: [MarkdownBlockSnapshot] = []
    var nextID = 0

    /// Whether `text` still starts with the prefix these blocks were parsed from.
    func covers(_ text: String) -> Bool {
        text.utf8.count >= prefixText.utf8.count && text.utf8.starts(with: prefixText.utf8)
    }

    var prefixEnd: (String) -> String.Index {
        { text in text.utf8.index(text.utf8.startIndex, offsetBy: prefixText.utf8.count) }
    }
}
