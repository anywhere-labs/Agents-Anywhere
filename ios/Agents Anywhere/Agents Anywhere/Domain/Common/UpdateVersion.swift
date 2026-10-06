import Foundation

/// Mirrors the Android client's `compareUpdateVersions` so every end reads the
/// same four-numeric-segment release naming, including prerelease ordering.
nonisolated func compareUpdateVersions(_ left: String, _ right: String) -> Int? {
    guard let a = parseUpdateVersion(left), let b = parseUpdateVersion(right) else { return nil }
    for index in 0..<max(a.release.count, b.release.count) {
        let x = index < a.release.count ? a.release[index] : 0
        let y = index < b.release.count ? b.release[index] : 0
        if x != y { return x < y ? -1 : 1 }
    }
    if a.pre.isEmpty || b.pre.isEmpty {
        if !a.pre.isEmpty { return -1 }
        if !b.pre.isEmpty { return 1 }
        return 0
    }
    for index in 0..<max(a.pre.count, b.pre.count) {
        guard index < a.pre.count else { return -1 }
        guard index < b.pre.count else { return 1 }
        let x = a.pre[index]
        let y = b.pre[index]
        if x == y { continue }
        let xn = x.allSatisfy(\.isWholeNumber) && !x.isEmpty
        let yn = y.allSatisfy(\.isWholeNumber) && !y.isEmpty
        var compared: Int
        switch (xn, yn) {
        case (true, true):
            // Decimal strings of arbitrary length; compare numerically by first
            // removing leading zeros, falling back to lexicographic on tie.
            let xs = stripLeadingZeros(x)
            let ys = stripLeadingZeros(y)
            if xs.count != ys.count { compared = xs.count < ys.count ? -1 : 1 }
            else if xs != ys { compared = xs < ys ? -1 : 1 }
            else { compared = 0 }
        case (true, false): compared = -1
        case (false, true): compared = 1
        case (false, false): compared = x == y ? 0 : (x < y ? -1 : 1)
        }
        if compared != 0 { return compared }
    }
    return 0
}

private struct UpdateVersion {
    let release: [Int]
    let pre: [String]
}

private func stripLeadingZeros(_ value: String) -> String {
    let trimmed = value.drop(while: { $0 == "0" })
    return trimmed.isEmpty ? "0" : String(trimmed)
}

private func parseUpdateVersion(_ value: String) -> UpdateVersion? {
    let text = value.trimmingCharacters(in: .whitespacesAndNewlines)
    guard text.count <= 128 else { return nil }
    guard let match = text.wholeMatch(
        of: #/^v?(\d+(?:\.\d+)*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)|((?:a|b|rc|dev)\d+))?(?:\+[0-9A-Za-z.-]+)?$/#
    ) else { return nil }
    // Release segments stay within Int range for every real client version.
    guard let release = match.1.components(separatedBy: ".").map(Int.init).compactMap({ $0 }) as [Int]? else { return nil }
    var suffix = match.2?.stringValue ?? ""
    if suffix.isEmpty, let alternate = match.3?.stringValue {
        // a2 -> a.2 so numeric suffixes compare numerically like Android does.
        if let separator = alternate.lastIndex(where: { !$0.isWholeNumber }) {
            let after = alternate[alternate.index(after: separator)...]
            suffix = String(alternate[...separator]) + "." + String(after)
        } else {
            suffix = alternate
        }
    }
    let pre = suffix.isEmpty ? [] : suffix.components(separatedBy: ".")
    return UpdateVersion(release: release, pre: pre)
}
