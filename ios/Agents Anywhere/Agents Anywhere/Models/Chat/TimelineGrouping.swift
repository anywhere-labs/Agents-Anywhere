import Foundation
import Observation

struct ChatTimelineGroup: Identifiable {
    enum Kind: Equatable { case single, tools, reconnect, agents(String) }
    let kind: Kind
    let rows: [ChatTimelineRowModel]
    // The first row owns the group, even as the second tool arrives. A group
    // growing during a stream does not replace the scroll target or its state.
    var id: String { rows[0].id }
    var status: V2TimelineItemStatus {
        if rows.contains(where: { $0.value.status.isActive }) { return .running }
        return rows.first(where: { $0.value.status.isFailure })?.value.status ?? .done
    }
    var title: String {
        switch kind {
        case .single: return ""
        case .agents: return "\(rows.count) 次子 Agent 调用"
        case .reconnect:
            let attempts = rows.compactMap { TimelineGrouping.reconnectMessage($0.value) }
                .compactMap { message in message.range(of: "\\d+\\s*/\\s*\\d+", options: .regularExpression).map { String(message[$0]) } }
            // The full retry messages remain available in the expanded rows.
            return "连接重试 · \(rows.count) 次" + (attempts.last.map { "（\($0)）" } ?? "")
        case .tools:
            let reasoning = rows.filter { $0.value.isReasoning }.count
            let tools = rows.count - reasoning
            return [reasoning > 0 ? "\(reasoning) 段思考" : nil, tools > 0 ? "\(tools) 次工具调用" : nil].compactMap { $0 }.joined(separator: " · ")
        }
    }
}

enum TimelineGrouping {
    static func groups(_ rows: [ChatTimelineRowModel], interactionTargets: Set<String>) -> [ChatTimelineGroup] {
        var groups: [ChatTimelineGroup] = []
        var pending: [ChatTimelineRowModel] = []
        var pendingKind = ChatTimelineGroup.Kind.single
        func flush() {
            guard !pending.isEmpty else { return }
            groups.append(ChatTimelineGroup(kind: pending.count > 1 ? pendingKind : .single, rows: pending))
            pending = []
        }
        for row in rows {
            let item = row.value
            let kind: ChatTimelineGroup.Kind
            if interactionTargets.contains(item.id) { kind = .single }
            else if item.type == .tool, item.raw["content"]?["kind"] == .string("agent_call"),
                    let parent = TimelineText.first(item.raw["content"]?["parentItemId"]) { kind = .agents(parent) }
            else if reconnectMessage(item) != nil { kind = .reconnect }
            else if item.isReasoning || [.tool, .fileChange, .artifact].contains(item.type) { kind = .tools }
            else { kind = .single }
            if kind == .single { flush(); groups.append(ChatTimelineGroup(kind: .single, rows: [row])); continue }
            if pendingKind != kind { flush() }
            pendingKind = kind; pending.append(row)
        }
        flush()
        return groups
    }

    static func reconnectMessage(_ item: V2TimelineItem) -> String? {
        guard item.type == .system, item.status == .failed else { return nil }
        let raw = item.raw["content"]
        let message = TimelineText.first(raw?["details"]?["error"]?["message"], raw?["details"]?["message"], raw?["message"], raw?["text"])
        return message?.hasPrefix("Reconnecting...") == true ? message : nil
    }
}

@MainActor @Observable final class TimelineDisclosureState {
    private var expanded: Set<String> = []
    func isExpanded(_ id: String) -> Bool { expanded.contains(id) }
    func toggle(_ id: String) { if !expanded.insert(id).inserted { expanded.remove(id) } }
}
