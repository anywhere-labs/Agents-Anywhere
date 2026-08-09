import Foundation

struct ChatSidebarDevice: Identifiable, Equatable {
    let id: V2ConnectorID
    let name: String
    let presence: V2ConnectorPresence

    init(connector: V2Connector) {
        id = connector.id
        name = connector.name
        presence = connector.status
    }
}

struct ChatSidebarSession: Identifiable, Equatable {
    let id: V2SessionID
    let title: String?
    let status: V2RuntimeStatus
    let unread: Bool
    let pinned: Bool

    init(session: V2SessionMeta) {
        id = session.id
        title = session.title
        status = session.status
        unread = session.unread
        pinned = session.pinned
    }
}

struct ChatSidebarAccount: Equatable {
    let userId: String
    let avatarURL: URL?

    init(me: AuthMe) {
        userId = me.userId
        avatarURL = me.avatar.flatMap(URL.init(string:))
    }

    var initials: String {
        String(userId.prefix(2)).uppercased()
    }
}

enum ChatShellSelection: Equatable {
    case newSession
    case device(V2ConnectorID)
    case session(V2SessionID)
}
