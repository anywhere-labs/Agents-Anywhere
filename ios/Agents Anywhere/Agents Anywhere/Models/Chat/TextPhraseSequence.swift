import Foundation

/// Keep localized words intact, including Chinese word boundaries. Each chunk
/// carries its original punctuation and spacing, so concatenation is lossless.
nonisolated enum TextPhraseSequence {
    static func chunks(in text: String) -> [String] {
        var result: [String] = []
        var start = text.startIndex
        var wordCount = 0
        text.enumerateSubstrings(in: text.startIndex..<text.endIndex, options: [.byWords, .localized]) { _, range, _, _ in
            wordCount += 1
            let phrase = text[start..<range.upperBound]
            if wordCount >= 2 || phrase.count >= 8 {
                result.append(String(phrase))
                start = range.upperBound
                wordCount = 0
            }
        }
        if start < text.endIndex {
            let remainder = String(text[start...])
            if !result.isEmpty && remainder.allSatisfy({ $0.isWhitespace || $0.isPunctuation }) {
                result[result.count - 1] += remainder
            } else {
                result.append(remainder)
            }
        }
        return result
    }
}
