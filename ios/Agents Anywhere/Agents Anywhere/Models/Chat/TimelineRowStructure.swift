import Foundation

/// The list observes this small projection, not each row's changing token text
/// or tool output. A streaming append updates its row without regrouping history.
struct TimelineRowStructure: Equatable {
    let type: V2TimelineItemType
    let role: V2MessageRole?
    let status: V2TimelineItemStatus
    let isReasoning: Bool
    let isStreamingText: Bool
    let groupKind: ChatTimelineGroup.Kind
    let reconnectAttempt: String?

    init(_ item: V2TimelineItem) {
        type = item.type; role = item.role; status = item.status
        isReasoning = item.isReasoning; isStreamingText = item.isStreamingText
        if item.type == .tool, item.raw["content"]?["kind"] == .string("agent_call"),
           let parent = TimelineText.first(item.raw["content"]?["parentItemId"]) { groupKind = .agents(parent) }
        else if TimelineGrouping.reconnectMessage(item) != nil { groupKind = .reconnect }
        else if item.isReasoning || [.tool, .fileChange, .artifact].contains(item.type) { groupKind = .tools }
        else { groupKind = .single }
        reconnectAttempt = TimelineGrouping.reconnectMessage(item).flatMap { message in
            message.range(of: "\\d+\\s*/\\s*\\d+", options: .regularExpression).map { String(message[$0]) }
        }
    }
}
