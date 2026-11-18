// Copied from ios/Agents Anywhere (v2 app) for the v3 PoC. Changes: the bar itself is a UIKit UINavigationBar
// (ConversationViewController); SwiftUI only draws the leading title. ChatHeaderStatus is the v3 status from `control`.
import SwiftUI

/// The navigation bar's leading title: title, then subtitle and status, like the real app's `.principal` item.
struct ConversationTitle: View {
    let controller: SessionController

    var body: some View {
        let header = ConversationHeader(controller: controller)
        VStack(alignment: .leading, spacing: 1) {
            Text(header.title).font(.headline).lineLimit(1)
                .accessibilityAddTraits(.isHeader)
            if !header.subtitle.isEmpty || header.status != nil {
                ChatToolbarSubtitle(subtitle: header.subtitle, status: header.status)
            }
        }
        .multilineTextAlignment(.leading)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// What the conversation header shows for the selected session.
struct ConversationHeader {
    let controller: SessionController

    var summary: Workspace.Session? { controller.selectedSummary }
    var device: Workspace.Device? { summary.flatMap { s in controller.workspace.devices.first { $0.id == s.device_id } } }
    var deviceOnline: Bool { device?.isOnline ?? true }
    var title: String { controller.session?["title"]?.string ?? summary?.title ?? "会话" }
    var subtitle: String {
        [summary?.agentLabel, controller.session?["device"]?["name"]?.string ?? device?.name].compactMap { $0 }.joined(separator: " · ")
    }
    var status: ChatHeaderStatus? {
        ChatHeaderStatus(activity: controller.activity, error: controller.errorMessage, deviceOnline: deviceOnline)
    }
}

private struct ChatToolbarSubtitle: View {
    let subtitle: String?
    let status: ChatHeaderStatus?
    @ScaledMetric(relativeTo: .caption) private var lineHeight: CGFloat = 16

    private var text: String {
        [subtitle, status?.title].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
    }
    var body: some View {
        HStack(spacing: 4) {
            if let status {
                Group {
                    if status.isProgress { ProgressView().controlSize(.mini) }
                    else { AppSymbol(status.symbol, size: 12) }
                }.frame(width: lineHeight, height: lineHeight)
            }
            Text(verbatim: text).lineLimit(1)
        }
        .font(.caption).foregroundStyle(.secondary)
        .frame(height: lineHeight)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel([subtitle, status?.detail].compactMap { $0 }.joined(separator: " · "))
    }
}

/// The toolbar's status line, from the v3 `control` (the real app derives it from runtime state and notices).
enum ChatHeaderStatus: Equatable {
    case working, waitingForResponse, failed(String), deviceOffline

    init?(activity: SessionActivity, error: String?, deviceOnline: Bool) {
        if !deviceOnline { self = .deviceOffline; return }
        switch activity {
        case .running: self = .working
        case .waiting: self = .waitingForResponse
        case .error, .disconnected: self = .failed(error ?? "连接已断开")
        case .idle: return nil
        }
    }

    var title: String {
        switch self {
        case .working: "正在处理任务"
        case .waitingForResponse: "等待回应"
        case let .failed(message): message
        case .deviceOffline: "设备离线"
        }
    }
    var detail: String { title }
    var symbol: String {
        switch self {
        case .deviceOffline: "desktopcomputer"
        case .waitingForResponse: "hand.raised"
        case .failed: "exclamationmark.circle"
        case .working: "info.circle"
        }
    }
    var isProgress: Bool { self == .working }
}
