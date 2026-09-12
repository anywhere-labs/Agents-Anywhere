import Foundation

/// Match the Web workspace picker's inventory order, independently of cache order
/// and the sidebar's visibility and empty-project rules.
enum WorkspaceSelectionOrder {
    static func projects(_ values: [V2Project], connectorID: String) -> [V2Project] {
        values.filter { $0.connectorId == connectorID }.map { project in
            let raw = [project.pinnedAt, project.lastActivityAt, project.updatedAt]
                .compactMap { $0 }.first { !$0.isEmpty }
            return (project: project, time: timestamp(raw))
        }.sorted { left, right in
            if left.project.pinned != right.project.pinned { return left.project.pinned }
            if left.time != right.time { return left.time > right.time }
            let names = left.project.name.localizedCompare(right.project.name)
            if names != .orderedSame { return names == .orderedAscending }
            return left.project.id.localizedCompare(right.project.id) == .orderedAscending
        }.map(\.project)
    }

    static func sessions(_ values: [V2SessionMeta], connectorID: String) -> [V2SessionMeta] {
        // Parse each timestamp once, before sorting. Pinned and archived sessions
        // still contribute directories, just as they do in the Web picker.
        values.filter { $0.connectorId == connectorID }
            .map { (session: $0, order: SessionSidebarPresentation($0)) }
            .sorted { left, right in
                left.order.precedes(right.order, id: left.session.id, otherID: right.session.id)
            }.map(\.session)
    }

    private static func timestamp(_ value: String?) -> TimeInterval {
        guard let value else { return 0 }
        return ((try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(value))
            ?? (try? Date.ISO8601FormatStyle().parse(value)))?.timeIntervalSince1970 ?? 0
    }
}
