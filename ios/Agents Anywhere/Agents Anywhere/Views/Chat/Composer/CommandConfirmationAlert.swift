import SwiftUI

/// Confirms a command that quits the app holding the session. The alert is
/// built from the device's facts; its buttons send the confirm, force or
/// cancel follow-up exactly once.
struct CommandConfirmationAlert: ViewModifier {
    let model: SessionChatModel

    func body(content: Content) -> some View {
        let pending = model.pendingCommandConfirmation
        content.alert(pending.map { String(localized: "退出 \($0.confirmation.appName)？") } ?? "", isPresented: Binding(
            get: { model.pendingCommandConfirmation != nil },
            set: { if !$0 { model.pendingCommandConfirmation = nil } }),
            presenting: pending) { pending in
                Button(String(localized: "退出 \(pending.confirmation.appName)"), role: .destructive) {
                    Task { await model.confirmCommand(pending, force: false) }
                }
                if pending.confirmation.offersForce {
                    Button(String(localized: "如果没有按时退出，强制结束"), role: .destructive) {
                        Task { await model.confirmCommand(pending, force: true) }
                    }
                }
                Button(String(localized: "取消"), role: .cancel) {
                    Task { await model.cancelCommand(pending) }
                }
            } message: { pending in
                let facts = pending.confirmation
                Text(String(localized: "这会结束 \(facts.appName)（\(facts.processCount) 个进程）。它正在使用的所有会话都会被释放，App 里未保存的输入和正在运行的回合会中断。会先请求正常退出，最多等待 \(facts.gracePeriodSeconds) 秒。")
                    + "\n\n" + String(localized: "退出后，发送下一条消息即可由 Agents Anywhere 接手这个会话。"))
            }
    }
}
