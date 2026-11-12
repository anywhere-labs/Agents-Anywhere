import Foundation

/// A Tokens Anywhere model once, across the protocols the profile offers it on.
nonisolated struct TokensModel: Hashable, Identifiable {
    let id: String
    /// The name Tokens Anywhere gives it, or its ID.
    let originalName: String
    let vendor: String?
    let contextWindow: Int?
    let maxOutputTokens: Int?
    let image: Bool
}

/// Models by maker; `label` is nil for models with no maker.
nonisolated struct TokensVendorGroup: Hashable, Identifiable {
    let key: String
    let label: String?
    var models: [TokensModel]

    var id: String { key }
}

nonisolated struct TokensUsageSummary: Hashable {
    struct Day: Hashable, Identifiable {
        let date: String
        /// Ten-thousandths of a yuan.
        let cost: Int
        var id: String { date }
    }

    struct Model: Hashable, Identifiable {
        /// Empty when Tokens Anywhere did not say which model it was.
        let model: String
        var requests: Int
        var tokens: Int
        var cost: Int
        var id: String { model }
    }

    /// Ten-thousandths of a yuan.
    let cost: Int
    let requests: Int
    let tokens: Int
    let daily: [Day]
    let models: [Model]
}

/// The Anywhere account page, ported from the Web presentation.
nonisolated enum TokensAccountPresentation {
    /// Each model once, across the protocols the profile offers it on.
    static func models(_ profile: V2ModelProfile) -> [TokensModel] {
        var order: [String] = []
        var byID: [String: TokensModel] = [:]
        for offer in profile.offers {
            for spec in offer.models {
                let known = byID[spec.id]
                let knownName = known.flatMap { $0.originalName != $0.id ? $0.originalName : nil }
                if known == nil { order.append(spec.id) }
                let specName = spec.name.flatMap { $0.isEmpty ? nil : $0 }
                byID[spec.id] = TokensModel(
                    id: spec.id,
                    originalName: knownName ?? specName ?? spec.id,
                    vendor: known?.vendor ?? spec.vendor,
                    contextWindow: known?.contextWindow ?? spec.contextWindow,
                    maxOutputTokens: known?.maxOutputTokens ?? spec.maxOutputTokens,
                    image: (known?.image ?? false) || (spec.input?.contains("image") ?? false))
            }
        }
        return order.compactMap { byID[$0] }
    }

    /// Known makers, in the order their groups show.
    private static let vendorLabels: [(key: String, label: String)] = [
        ("anthropic", "Anthropic"), ("openai", "OpenAI"), ("google", "Google"), ("gemini", "Google"),
        ("deepseek", "DeepSeek"), ("moonshot", "Moonshot"), ("moonshotai", "Moonshot"), ("qwen", "Qwen"),
        ("alibaba", "Qwen"), ("zhipu", "Zhipu"), ("z-ai", "Zhipu"), ("xai", "xAI"), ("minimax", "MiniMax"),
        ("mistral", "Mistral"),
    ]

    static func vendorLabel(_ vendor: String?) -> String? {
        guard let vendor, !vendor.isEmpty else { return nil }
        let key = vendor.lowercased()
        return vendorLabels.first { $0.key == key }?.label ?? vendor
    }

    /// Models by maker, the best known first; models with no maker come last.
    static func vendorGroups(_ models: [TokensModel]) -> [TokensVendorGroup] {
        var order: [String] = []
        var groups: [String: TokensVendorGroup] = [:]
        for model in models {
            let label = vendorLabel(model.vendor)
            let key = label ?? ""
            if groups[key] == nil {
                order.append(key)
                groups[key] = TokensVendorGroup(key: key, label: label, models: [])
            }
            groups[key]?.models.append(model)
        }
        let known = vendorLabels.map(\.label)
        func rank(_ label: String?) -> Int {
            guard let label else { return .max }
            return known.firstIndex(of: label) ?? known.count
        }
        return order.compactMap { groups[$0] }.sorted { a, b in
            let left = rank(a.label), right = rank(b.label)
            if left != right { return left < right }
            return (a.label ?? "").localizedCompare(b.label ?? "") == .orderedAscending
        }
    }

    /// A token count the way model sizes are said: 200K, 1M, 1.5M.
    static func formatTokenWindow(_ value: Int) -> String {
        func short(_ scaled: Double, _ unit: String) -> String {
            let rounded = (scaled * 10).rounded() / 10
            let text = rounded == rounded.rounded() ? String(Int(rounded)) : String(format: "%.1f", rounded)
            return text + unit
        }
        if value >= 1_000_000 { return short(Double(value) / 1_000_000, "M") }
        if value >= 1_000 { return short(Double(value) / 1_000, "K") }
        return String(value)
    }

    private static func sameSet(_ a: [String], _ b: [String]) -> Bool {
        a.count == b.count && Set(a + b).count == a.count
    }

    private static func trimmed(_ value: String) -> String { value.trimmingCharacters(in: .whitespacesAndNewlines) }

    static func samePreferences(_ a: V2ModelPreferences, _ b: V2ModelPreferences) -> Bool {
        let left = a.names.filter { !trimmed($0.value).isEmpty }
        let right = b.names.filter { !trimmed($0.value).isEmpty }
        return sameSet(a.disabled, b.disabled)
            && left.count == right.count
            && left.allSatisfy { id, name in b.names[id].map(trimmed) == trimmed(name) }
    }

    /// Preferences as saved: only names that differ from the model's own, only models still offered.
    static func cleanPreferences(_ preferences: V2ModelPreferences, models: [TokensModel]) -> V2ModelPreferences {
        let byID = Dictionary(models.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        var names: [String: String] = [:]
        for (id, raw) in preferences.names {
            let name = trimmed(raw)
            guard !name.isEmpty, let model = byID[id], name != model.originalName else { continue }
            names[id] = name
        }
        return V2ModelPreferences(disabled: preferences.disabled.filter { byID[$0] != nil }, names: names)
    }

    /// Models whose switch or name differs between the two.
    static func changeCount(_ before: V2ModelPreferences, _ after: V2ModelPreferences) -> Int {
        let ids = Set(before.disabled + after.disabled + Array(before.names.keys) + Array(after.names.keys))
        let off = (before: Set(before.disabled), after: Set(after.disabled))
        return ids.filter { id in
            off.before.contains(id) != off.after.contains(id) || (before.names[id] ?? "") != (after.names[id] ?? "")
        }.count
    }

    /// Amounts in ten-thousandths of a yuan. Tokens Anywhere sends decimal
    /// strings with four places; adding them as integers keeps sums exact.
    static func amountUnits(_ value: String?) -> Int {
        var text = Substring(trimmed(value ?? ""))
        let negative = text.hasPrefix("-")
        if negative { text = text.dropFirst() }
        let parts = text.split(separator: ".", maxSplits: 1, omittingEmptySubsequences: false)
        let digits = CharacterSet(charactersIn: "0123456789")
        func isDigits(_ part: Substring) -> Bool { !part.isEmpty && part.unicodeScalars.allSatisfy(digits.contains) }
        guard let whole = parts.first, isDigits(whole), let wholeValue = Int(whole) else { return 0 }
        var fraction = 0
        if parts.count == 2 {
            let part = parts[1]
            guard isDigits(part), part.count <= 4 else { return 0 }
            fraction = Int(part.padding(toLength: 4, withPad: "0", startingAt: 0)) ?? 0
        }
        let (scaled, overflow) = wholeValue.multipliedReportingOverflow(by: 10_000)
        guard !overflow else { return 0 }
        let units = scaled + fraction
        return negative ? -units : units
    }

    /// Yuan with two places, or four when two would show a small cost as nothing.
    static func formatYuan(_ units: Int) -> String {
        let magnitude = units.magnitude
        let fourPlaces = units != 0 && magnitude < 100
        let scale: UInt = fourPlaces ? 1 : 100
        // Half away from zero, as the Web formats it.
        let rounded = fourPlaces ? magnitude : (magnitude + 50) / scale
        let places = fourPlaces ? 4 : 2
        let divisor: UInt = fourPlaces ? 10_000 : 100
        let whole = rounded / divisor
        let fraction = String(rounded % divisor)
        let padded = String(repeating: "0", count: places - fraction.count) + fraction
        return "¥" + (units < 0 ? "-" : "") + grouped(whole) + "." + padded
    }

    private static func grouped(_ value: UInt) -> String {
        let digits = Array(String(value))
        var result = ""
        for (index, digit) in digits.enumerated() {
            if index > 0 && (digits.count - index) % 3 == 0 { result.append(",") }
            result.append(digit)
        }
        return result
    }

    private static let dayFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "UTC")
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }()

    /// Every date from `from` to `to`, both included, at most 400.
    static func datesBetween(_ from: String, _ to: String) -> [String] {
        guard let start = dayFormatter.date(from: from), let end = dayFormatter.date(from: to) else { return [] }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        var dates: [String] = []
        var day = start
        while day <= end && dates.count < 400 {
            dates.append(dayFormatter.string(from: day))
            guard let next = calendar.date(byAdding: .day, value: 1, to: day) else { break }
            day = next
        }
        return dates
    }

    /// Totals, cost per day (every day, quiet ones as zero) and per model, most spent first.
    static func summarizeUsage(_ usage: V2TokensUsage, model: String?) -> TokensUsageSummary {
        let rows = usage.items.filter { model == nil || $0.model == model }
        var dayOrder = datesBetween(usage.from, usage.to)
        var perDay = Dictionary(dayOrder.map { ($0, 0) }, uniquingKeysWith: { first, _ in first })
        var modelOrder: [String] = []
        var perModel: [String: TokensUsageSummary.Model] = [:]
        var cost = 0, requests = 0, tokens = 0
        for row in rows {
            let units = amountUnits(row.amountCharged)
            cost += units
            requests += row.requests
            tokens += row.tokens
            if perDay[row.date] == nil { dayOrder.append(row.date) }
            perDay[row.date, default: 0] += units
            let key = row.model ?? ""
            if perModel[key] == nil {
                modelOrder.append(key)
                perModel[key] = .init(model: key, requests: 0, tokens: 0, cost: 0)
            }
            perModel[key]?.requests += row.requests
            perModel[key]?.tokens += row.tokens
            perModel[key]?.cost += units
        }
        let models = modelOrder.enumerated().compactMap { index, key in perModel[key].map { (index, $0) } }
            .sorted { a, b in
                if a.1.cost != b.1.cost { return a.1.cost > b.1.cost }
                if a.1.requests != b.1.requests { return a.1.requests > b.1.requests }
                return a.0 < b.0
            }
            .map(\.1)
        return TokensUsageSummary(cost: cost, requests: requests, tokens: tokens,
            daily: dayOrder.map { .init(date: $0, cost: perDay[$0] ?? 0) }, models: models)
    }

    /// The model IDs a usage report names, for the model filter.
    static func usageModelIDs(_ usage: V2TokensUsage) -> [String] {
        Set(usage.items.compactMap { $0.model.flatMap { $0.isEmpty ? nil : $0 } }).sorted()
    }

    /// `MM-dd` for a `yyyy-MM-dd` date; anything else as it is.
    static func shortDate(_ value: String) -> String {
        let parts = value.split(separator: "-")
        guard value.count == 10, parts.count == 3, parts[0].count == 4 else { return value }
        return String(value.dropFirst(5))
    }
}
