import SwiftUI

/// The listed sessions and the shell's navigation, handed to collaboration
/// labels. Equality ignores the action so only directory changes invalidate readers.
struct SessionCollaborationContext: Equatable {
    var directory: SessionCollaborationDirectory = .empty
    var open: (V2SessionID) -> Void = { _ in }

    static func == (lhs: Self, rhs: Self) -> Bool { lhs.directory == rhs.directory }

    /// Opens a listed session; returns false for one outside the list.
    @discardableResult
    func openIfListed(_ id: V2SessionID?) -> Bool {
        guard let id, directory.contains(id) else { return false }
        open(id)
        return true
    }
}

extension EnvironmentValues {
    @Entry var sessionCollaboration = SessionCollaborationContext()
}

/// 「由 X 创建」 / 「被 X 监督」 chips under the session page header.
struct SessionCollaborationBadges: View {
    let session: V2SessionMeta?
    @Environment(\.sessionCollaboration) private var collaboration

    var body: some View {
        let badges = session.map { SessionCollaborationPresentation.badges(for: $0, directory: collaboration.directory) } ?? []
        if !badges.isEmpty {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(badges) { badge in
                        Button { collaboration.openIfListed(badge.sessionId) } label: { chip(badge) }
                            .buttonStyle(.plain).disabled(!badge.canOpen)
                            .accessibilityHint(badge.canOpen ? String(localized: "打开会话") : "")
                    }
                }.padding(.horizontal, 16)
            }
            .frame(maxWidth: .infinity)
        }
    }

    private func chip(_ badge: SessionCollaborationBadge) -> some View {
        let inactive: Bool = if case let .supervisedBy(state) = badge.kind { state != .active } else { false }
        let symbol: String = if case .createdBy = badge.kind { "person.2" } else { "eye" }
        return HStack(spacing: 4) {
            AppSymbol(symbol, size: 12)
            Text(verbatim: badge.label).lineLimit(1)
            if badge.canOpen { AppSymbol("arrow.up.right", size: 10) }
        }
        .font(.caption.weight(.medium))
        .foregroundStyle(inactive ? Color.secondary : Color.accentColor)
        .padding(.horizontal, 10).padding(.vertical, 5)
        .background(.regularMaterial, in: .capsule)
        .overlay(Capsule().strokeBorder((inactive ? Color.secondary : Color.accentColor).opacity(0.25)))
    }
}

/// Marks on a session list row for Agent-created and supervised sessions.
struct SessionCollaborationListMarks: View {
    let indicator: SessionCollaborationPresentation.ListIndicator
    var body: some View {
        if !indicator.isEmpty {
            HStack(spacing: 3) {
                if indicator.agentCreated {
                    AppSymbol("person.2", size: 12).accessibilityLabel(String(localized: "由 Agent 创建"))
                }
                if indicator.supervised {
                    AppSymbol("eye", size: 12).accessibilityLabel(String(localized: "被监督中"))
                }
            }
            .foregroundStyle(.secondary)
            .accessibilityElement(children: .combine)
        }
    }
}

/// 「由 X 的 Agent 发送」 under a user message an Agent sent.
struct CollaborationAuthorLabel: View {
    let author: V2MessageAuthor
    @Environment(\.sessionCollaboration) private var collaboration

    var body: some View {
        if let label = SessionCollaborationPresentation.agentAuthorLabel(author, directory: collaboration.directory) {
            let canOpen = author.sessionId.map(collaboration.directory.contains) ?? false
            Button { collaboration.openIfListed(author.sessionId) } label: {
                HStack(spacing: 4) {
                    AppSymbol("person.2", size: 11)
                    Text(verbatim: label).lineLimit(1)
                }
                .font(.caption2).foregroundStyle(canOpen ? Color.accentColor : .secondary)
            }
            .buttonStyle(.plain).disabled(!canOpen)
        }
    }
}

/// 「打开会话」 for a collaboration tool row whose session is listed.
struct CollaborationOpenSessionButton: View {
    let sessionId: V2SessionID
    @Environment(\.sessionCollaboration) private var collaboration

    var body: some View {
        if collaboration.directory.contains(sessionId) {
            Button { collaboration.openIfListed(sessionId) } label: {
                HStack(spacing: 4) {
                    Text(String(localized: "打开会话"))
                    AppSymbol("arrow.up.right", size: 10)
                }
                .font(.caption.weight(.medium)).foregroundStyle(Color.accentColor)
            }
            .buttonStyle(.plain)
            .accessibilityHint(collaboration.directory.title(sessionId))
        }
    }
}

/// A supervision wake: a digest the device delivered to this supervisor session,
/// shown as a collapsible card instead of the person's own bubble.
struct SupervisionNoticeCard: View {
    let row: ChatTimelineRowModel
    let disclosures: TimelineDisclosureState
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        TimelineFold(id: row.id, title: String(localized: "监督通知"), symbol: "eye", status: row.value.status, disclosures: disclosures) {
            ChatMarkdownView(text: row.text, isStreaming: false, resolvesFileReferences: true)
                .environment(\.chatLayoutTraceOwner, row.id)
                .environment(\.chatMarkdownFont, .footnote)
                .padding(.leading, 18)
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(AppTheme.groupedFill(colorScheme), in: .rect(cornerRadius: 14))
    }
}

/// 「需要你决定」: an Agent hands a question to the person.
struct CollaborationEscalationCard: View {
    let escalation: V2CollabEscalation
    @Environment(\.sessionCollaboration) private var collaboration

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                AppSymbol("hand.raised", size: 14)
                Text(String(localized: "需要你决定")).font(.subheadline.weight(.semibold))
            }.foregroundStyle(.orange)
            if !escalation.question.isEmpty {
                ChatSelectableText(text: escalation.question).font(.body)
            }
            if let context = escalation.context {
                Text(verbatim: context).font(.footnote).foregroundStyle(.secondary)
            }
            if let from = escalation.fromSessionId {
                let canOpen = collaboration.directory.contains(from)
                Button { collaboration.openIfListed(from) } label: {
                    HStack(spacing: 4) {
                        Text(String(localized: "来自 \(collaboration.directory.title(from))")).lineLimit(1)
                        if canOpen { AppSymbol("arrow.up.right", size: 10) }
                    }
                    .font(.caption).foregroundStyle(canOpen ? Color.accentColor : .secondary)
                }
                .buttonStyle(.plain).disabled(!canOpen)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.orange.opacity(0.10), in: .rect(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(Color.orange.opacity(0.35)))
    }
}
