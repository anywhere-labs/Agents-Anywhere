import SwiftUI

struct SessionNoticesSheet: View {
    let model: SessionChatModel
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 16) {
                    ForEach(model.session.notices.notices.filter(\.isVisible)) { item in
                        SessionInteractionCard(item: item, chat: model)
                    }
                }.padding(16)
            }
            .navigationTitle("交互与通知")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } } }
        }
        .presentationDetents([.large])
    }
}
