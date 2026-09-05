import SwiftUI

struct SessionInteractionDetailsSheet: View {
    let item: SessionNoticeModel
    let chat: SessionChatModel
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                SessionInteractionContent(item: item, chat: chat, showsContext: true).padding(16)
            }
            .navigationTitle("操作详情").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } } }
        }.presentationDetents([.large])
    }
}
