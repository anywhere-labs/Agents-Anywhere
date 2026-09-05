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
    let displayName: String
    let avatarSource: AccountAvatarImageSource?

    init(me: AuthMe, avatarSource: AccountAvatarImageSource?) {
        displayName = me.accountLabel
        self.avatarSource = avatarSource
    }
}

enum ChatShellSelection: Equatable {
    case newSession
    case device(V2ConnectorID)
    case session(V2SessionID)
}
