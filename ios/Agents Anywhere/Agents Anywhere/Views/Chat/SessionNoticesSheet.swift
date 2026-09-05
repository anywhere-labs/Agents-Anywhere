import SwiftUI

struct SessionNoticesSheet: View {
    let model: SessionChatModel
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            List {
                ForEach(model.session.runtime.notices.filter { ![.resolved, .closed, .expired, .cancelled].contains($0.status) }) { notice in
                    NoticeResponseSection(model: model, notice: notice).id("\(notice.id):\(notice.revision)")
                }
            }
            .navigationTitle("待处理事项")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } } }
        }
        .presentationDetents([.large])
    }
}

private struct NoticeResponseSection: View {
    let model: SessionChatModel
    let notice: V2RuntimeNotice
    @State private var choices: [String: Set<String>] = [:]
    @State private var custom: [String: String] = [:]
    @State private var error: String?

    private var form: NoticeInputForm? { NoticeInputForm(notice) }

    var body: some View {
        Section {
            Text(notice.title).font(.headline)
            if let message = notice.message { Text(message).font(.subheadline).foregroundStyle(.secondary) }
            if let form {
                ForEach(form.questions) { question in
                    VStack(alignment: .leading, spacing: 12) {
                        Text(question.prompt).font(.subheadline.weight(.medium))
                        ForEach(question.options) { option in
                            Button {
                                var selected = choices[question.id] ?? []
                                if selected.contains(option.id) { selected.remove(option.id) }
                                else if question.multiple { selected.insert(option.id) }
                                else { selected = [option.id] }
                                choices[question.id] = selected
                            } label: {
                                HStack(spacing: 12) {
                                    Image(systemName: choices[question.id]?.contains(option.id) == true ? "checkmark.circle.fill" : "circle")
                                    VStack(alignment: .leading, spacing: 4) {
                                        Text(option.label).foregroundStyle(.primary)
                                        if let detail = option.detail { Text(detail).font(.footnote).foregroundStyle(.secondary) }
                                    }
                                }.frame(minHeight: 44).contentShape(Rectangle())
                            }.buttonStyle(.plain)
                        }
                        if question.allowCustom {
                            TextField("补充你的回答", text: Binding(get: { custom[question.id] ?? "" }, set: { custom[question.id] = $0 }), axis: .vertical)
                                .lineLimit(1...6)
                        }
                    }
                    .padding(.vertical, 6)
                    .disabled(model.isWorking || notice.status != .open || !model.session.runtime.isFresh)
                }
            }
            ForEach(notice.actions) { action in
                let payload = form?.actionID == action.id ? form?.payload(choices: choices, custom: custom) : nil
                let needsUnsupportedInput = action.input.required && form?.actionID != action.id
                Button(action.label) {
                    Task { @MainActor in
                        if !(await model.respond(notice: notice, action: action, input: payload)) {
                            error = model.error ?? "操作未完成，请检查连接后重试。"
                        }
                    }
                }
                .disabled(model.isWorking || !model.session.runtime.isFresh || notice.status != .open
                    || needsUnsupportedInput || (form?.actionID == action.id && payload == nil))
                if needsUnsupportedInput {
                    Text("此交互需要的输入形式暂未支持，请在 Web 中处理。")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            }
            if notice.status != .open { Text("已提交回应，等待 Agent 确认").font(.footnote).foregroundStyle(.secondary) }
            if let error { Text(error).font(.footnote).foregroundStyle(.secondary) }
        }
    }
}
