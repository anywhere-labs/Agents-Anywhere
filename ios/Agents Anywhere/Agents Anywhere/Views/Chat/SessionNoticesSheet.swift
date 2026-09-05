import SwiftUI

struct SessionNoticesSheet: View {
    let model: SessionChatModel
    var initialNoticeID: String? = nil
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 16) {
                        ForEach(model.session.notices.notices.filter(\.isVisible)) { item in
                            SessionInteractionContent(item: item, chat: model).id(item.id)
                        }
                    }.padding(16)
                }
                .onAppear { if let initialNoticeID { proxy.scrollTo(initialNoticeID, anchor: .top) } }
            }
            .navigationTitle("交互与通知")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } } }
        }
        .presentationDetents([.large])
    }
}
