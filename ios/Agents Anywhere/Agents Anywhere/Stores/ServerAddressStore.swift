import Foundation

/// One entry in the ordered server address list. Every entry has been verified
/// at add time to belong to the same AA instance (the account userId returned
/// by /auth/me matches the signed-in one), so the stored access token is valid
/// against all of them.
/// NOTE: A true server fingerprint would require a stable install id exposed by
/// the server (a contracts change). Until that exists, the /auth/me userId
/// comparison in AddServerAddressSheet is the same-instance check.
nonisolated struct ServerAddress: Codable, Identifiable, Equatable, Hashable, Sendable {
    let id: UUID
    let url: URL
    let addedAt: Date

    init(url: URL) {
        self.id = UUID()
        self.url = url.normalizedV2ServerURL()
        self.addedAt = .now
    }
}

/// The result of one user-initiated reachability/latency probe of an address.
nonisolated struct ServerAddressProbe: Equatable, Sendable {
    let reachable: Bool
    let latencyMS: Int?
}

/// Ordered, persisted server address list. Index 0 is the highest priority:
/// the app prefers the first reachable address, falls forward on repeated
/// transport failures, and switches back once a higher-priority address answers.
@MainActor
final class ServerAddressStore {
    static let defaultsKey = "agentsAnywhere.serverAddresses"

    private(set) var addresses: [ServerAddress] = []

    func load() {
        guard let data = UserDefaults.standard.data(forKey: Self.defaultsKey),
              let decoded = try? JSONDecoder().decode([ServerAddress].self, from: data) else {
            addresses = []
            return
        }
        addresses = decoded
    }

    /// First run after an older single-server install: adopt the saved server as
    /// the top-priority address so existing behaviour is unchanged.
    func seedLegacyServerIfNeeded(serverValue: String?) {
        guard addresses.isEmpty, let serverValue, let url = URL(string: serverValue) else { return }
        add(url)
    }

    func contains(_ url: URL) -> Bool {
        let target = url.normalizedV2ServerURL()
        return addresses.contains { $0.url == target }
    }

    @discardableResult
    func add(_ url: URL) -> ServerAddress {
        let target = url.normalizedV2ServerURL()
        if let existing = addresses.first(where: { $0.url == target }) { return existing }
        let address = ServerAddress(url: target)
        addresses.append(address)
        persist()
        return address
    }

    /// Signing in to an address that is not in the list means a different
    /// instance: the previous list belongs to the old one and is replaced.
    func reset(to url: URL) {
        addresses = [ServerAddress(url: url)]
        persist()
    }

    @discardableResult
    func remove(id: UUID) -> ServerAddress? {
        guard let index = addresses.firstIndex(where: { $0.id == id }) else { return nil }
        let removed = addresses.remove(at: index)
        persist()
        return removed
    }

    func move(from source: IndexSet, to destination: Int) {
        addresses.move(fromOffsets: source, toOffset: destination)
        persist()
    }

    private func persist() {
        if let data = try? JSONEncoder().encode(addresses) {
            UserDefaults.standard.set(data, forKey: Self.defaultsKey)
        }
    }
}
