import Foundation

/// Remembers the server-issued `publishedAt` of the last acknowledged
/// announcement per server, matching Web's `aa.announcement.read.v1`.
struct AnnouncementReadStore {
    private let defaults: UserDefaults
    private let key = "agentsAnywhere.announcementRead.v1"

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    func isUnread(_ announcement: PublicAnnouncement, server: URL) -> Bool {
        guard let published = announcement.publishedDate else { return false }
        guard let read = PublicAnnouncement.parse(entries[Self.scope(server)]) else { return true }
        return published > read
    }

    func markRead(_ announcement: PublicAnnouncement, server: URL) {
        guard isUnread(announcement, server: server) else { return }
        var next = entries
        next[Self.scope(server)] = announcement.publishedAt
        defaults.set(next, forKey: key)
    }

    private var entries: [String: String] {
        defaults.dictionary(forKey: key) as? [String: String] ?? [:]
    }

    private static func scope(_ server: URL) -> String {
        server.normalizedServerURL().absoluteString
    }
}
