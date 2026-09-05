import SwiftUI

/// Both the header pill and the options sheet explain the same takeover action.
struct SessionTakeoverConfirmation: ViewModifier {
    @Binding var pending: Bool?
    let onConfirm: (Bool) async -> Void

    func body(content: Content) -> some View {
        content.alert(pending == true ? "开启接管？" : "关闭接管？", isPresented: Binding(
            get: { pending != nil }, set: { if !$0 { pending = nil } }),
            presenting: pending) { enabled in
                Button(enabled ? "开启接管" : "关闭接管") { Task { await onConfirm(enabled) } }
                Button("取消", role: .cancel) {}
            } message: { enabled in
                Text(enabled
                    ? "开启后可在 Agents Anywhere 中操作。记录可能需要重启 Agent 客户端才能同步；请避免同时在两个客户端操作此会话。"
                    : "关闭后会话回到只读模式。这里产生的记录可能需要重启 Agent 客户端才能同步。")
            }
    }
}
