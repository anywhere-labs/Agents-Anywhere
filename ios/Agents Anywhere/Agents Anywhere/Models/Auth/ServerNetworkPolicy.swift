import Foundation

nonisolated enum ServerNetworkPolicy {
    static func needsLocalAccess(_ url: URL) -> Bool {
        guard let host = url.host?.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "[].")) else { return false }
        if host == "localhost" || host == "::1" || host.hasPrefix("127.") { return false }
        if host.hasSuffix(".local") || !host.contains(".") && !host.contains(":") { return true }
        if host.hasPrefix("fc") || host.hasPrefix("fd") || host.hasPrefix("fe80:") { return host.contains(":") }
        let numbers = host.split(separator: ".").compactMap { Int($0) }
        guard numbers.count == 4, numbers.allSatisfy({ (0...255).contains($0) }) else { return false }
        return numbers[0] == 10 || numbers[0] == 192 && numbers[1] == 168
            || numbers[0] == 172 && (16...31).contains(numbers[1]) || numbers[0] == 169 && numbers[1] == 254
    }
}
