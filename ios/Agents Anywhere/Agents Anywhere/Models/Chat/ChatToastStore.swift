import Foundation
import Observation

struct ChatToast: Identifiable, Equatable {
    let id: String
    let title: String
    let message: String
    let canRetry: Bool
}

/// One current issue per source. Dismissing an issue does not change connection
/// facts or enable writes, and repeated identical observations do not reopen it.
@MainActor @Observable final class ChatToastStore {
    private(set) var items: [ChatToast] = []
    private var latest: [String: V2ClientFailure] = [:]

    func update(source: String, failure: V2ClientFailure?, title: String? = nil, canRetry: Bool = false) {
        guard latest[source] != failure else { return }
        latest[source] = failure
        items.removeAll { $0.id == source }
        guard let failure, failure.kind != .cancelled else { return }
        let heading: String
        switch failure.kind {
        case .invalidResponse: heading = "会话数据格式不兼容"
        case .authentication: heading = "登录状态需要验证"
        case .offline: heading = "网络已断开"
        default: heading = "操作未完成"
        }
        items.append(ChatToast(id: source, title: title ?? heading, message: failure.message, canRetry: canRetry))
    }
    func dismiss(_ id: String) { items.removeAll { $0.id == id } }
}
