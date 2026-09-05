import SwiftUI

struct SessionInteractionCard: View {
    let item: SessionNoticeModel
    let chat: SessionChatModel
    @State private var confirmsRetry = false
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { timeline in
            VStack(alignment: .leading, spacing: 14) {
                Label(item.notice.title, systemImage: icon).font(.subheadline.weight(.semibold))
                    .foregroundStyle(item.notice.severity == "error" ? Color.red : Color.primary)
                if let message = item.notice.message { Text(message).font(.subheadline).foregroundStyle(.secondary) }
                if item.notice.context != .object([:]) {
                    DisclosureGroup("操作详情") {
                        Text(item.notice.context.readableText)
                            .font(.system(.footnote, design: .monospaced)).textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading).padding(.top, 6)
                    }.font(.footnote)
                }
                if let form = item.form {
                    ForEach(form.questions) { question in
                        questionFields(question)
                    }
                }
                ForEach(item.notice.actions.filter { $0.id != item.form?.actionID && $0.input.schema != nil }) { action in
                    if let schema = action.input.schema,
                       let form = NoticeActionForm(schema: schema, uiSchema: action.input.uiSchema) {
                        if !form.fields.isEmpty {
                            DisclosureGroup(action.label) {
                                NoticeActionFields(item: item, action: action, form: form).padding(.top, 10)
                                    .disabled(chat.isWorking || !chat.session.runtime.isFresh
                                        || ![.open, .failed].contains(item.notice.status) || item.submission != .idle)
                            }.font(.subheadline)
                        }
                    } else if action.input.required {
                        Text("此操作的表单版本暂未支持，请在 Web 中处理。")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                }
                if item.notice.type == "interaction" {
                    ViewThatFits(in: .horizontal) {
                        HStack(spacing: 8) { actions }.fixedSize(horizontal: true, vertical: false)
                        VStack(alignment: .leading, spacing: 8) { actions }
                    }
                    .disabled(chat.isWorking || !item.canRespond(fresh: chat.session.runtime.isFresh, at: timeline.date))
                }
                submissionStatus(at: timeline.date)
                if let error = item.error { Text(error).font(.footnote).foregroundStyle(.secondary) }
            }
            .padding(16)
            .background(Color(uiColor: .secondarySystemBackground), in: .rect(cornerRadius: 22))
        }
        .confirmationDialog("回应结果尚未确认。再次回应前，请确认 Agent 仍在等待此操作。", isPresented: $confirmsRetry, titleVisibility: .visible) {
            Button("已检查，允许再次回应") { item.acknowledgeUncertain() }
            Button("取消", role: .cancel) {}
        }
    }

    private var icon: String {
        switch item.notice.interactionType {
        case "approval": "checkmark.shield"
        case "input_request": "text.bubble"
        case "execution_error": "exclamationmark.triangle"
        case "confirmation": "questionmark.circle"
        default: item.notice.severity == "error" ? "exclamationmark.circle" : "info.circle"
        }
    }

    @ViewBuilder private var actions: some View {
        ForEach(item.notice.actions) { action in
            Button(role: action.style == "danger" ? .destructive : nil) {
                Task { await chat.respond(notice: item, action: action) }
            } label: {
                Text(action.label).font(.subheadline.weight(.medium))
                    .padding(.horizontal, 14).frame(minHeight: 44)
                    .foregroundStyle(action.style == "primary" ? AppTheme.primaryControlForeground(colorScheme)
                        : action.style == "danger" ? Color.red : Color.primary)
                    .background(action.style == "primary" ? AppTheme.primaryControlBackground(colorScheme)
                        : AppTheme.groupedFill(colorScheme), in: .capsule)
            }
            .buttonStyle(.plain)
            .disabled(!item.hasValidInput(for: action))
        }
    }

    private func questionFields(_ question: NoticeInputQuestion) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            if let header = question.header { Text(header).font(.caption).foregroundStyle(.secondary) }
            Text(question.prompt).font(.subheadline.weight(.medium))
            ForEach(question.options) { option in
                Button { item.select(option.id, question: question) } label: {
                    HStack(spacing: 10) {
                        Image(systemName: item.choices[question.id]?.contains(option.id) == true
                            ? (question.multiple ? "checkmark.square.fill" : "checkmark.circle.fill")
                            : (question.multiple ? "square" : "circle"))
                        VStack(alignment: .leading, spacing: 4) {
                            Text(option.label).font(.subheadline)
                            if let detail = option.detail { Text(detail).font(.footnote).foregroundStyle(.secondary) }
                        }
                        Spacer(minLength: 0)
                    }.frame(minHeight: 44).contentShape(Rectangle())
                }.buttonStyle(.plain)
            }
            if question.allowCustom {
                NoticeTextInput(value: item.custom[question.id] ?? "", placeholder: "填写其他回答",
                    onChange: { text, marked, editorID in
                        item.setCustom(text, question: question)
                        setComposing(marked, id: editorID)
                    })
            }
        }
        // Do not disable the editor merely because its IME has marked text.
        .disabled(chat.isWorking || !chat.session.runtime.isFresh || ![.open, .failed].contains(item.notice.status) || item.submission != .idle)
    }
    private func setComposing(_ marked: Bool, id: String) {
        if marked { item.composingFields.insert(id) } else { item.composingFields.remove(id) }
    }

    @ViewBuilder private func submissionStatus(at now: Date) -> some View {
        if item.isExpired(at: now) {
            Text("此交互已过期，等待 Agent 更新状态。")
                .font(.footnote).foregroundStyle(.secondary)
        } else if !chat.session.runtime.isFresh {
            Text("连接恢复后才能回应；已填写的内容会保留。")
                .font(.footnote).foregroundStyle(.secondary)
        } else {
            switch item.submission {
            case .sending: Text("正在提交回应…").font(.footnote).foregroundStyle(.secondary)
            case .accepted: Text("回应已提交，等待 Agent 确认").font(.footnote).foregroundStyle(.secondary)
            case .uncertain:
                Text("回应结果未确认，不会自动重试。")
                    .font(.footnote).foregroundStyle(.secondary)
                Button("重新检查状态") { Task { await chat.session.refresh() } }.font(.footnote)
                Button("处理未确认的回应") { confirmsRetry = true }.font(.footnote)
            case .idle:
                if [.responding, .responseAccepted, .resolving].contains(item.notice.status) {
                    Text("Agent 正在处理回应…").font(.footnote).foregroundStyle(.secondary)
                }
                if item.notice.status == .failed {
                    Text("上次回应未完成，请检查后重新选择。")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            case .unavailable: EmptyView()
            }
        }
    }
}

private struct NoticeTextInput: View {
    let value: String
    let placeholder: String
    let onChange: (String, Bool, String) -> Void
    @State private var editorID = UUID().uuidString
    @State private var draft = ComposerDraft()
    @State private var editor = ComposerEditorController()

    var body: some View {
        ZStack(alignment: .topLeading) {
            if draft.text.isEmpty { Text(placeholder).foregroundStyle(.secondary).allowsHitTesting(false) }
            NativeComposerEditor(draft: draft, controller: editor, maximumHeight: 120,
                onCommandSend: {}, onTextChange: { text, marked in onChange(text, marked, editorID) })
                .frame(minHeight: 44)
                .fixedSize(horizontal: false, vertical: true)
        }
        .font(.body).padding(10).background(.quaternary.opacity(0.5), in: .rect(cornerRadius: 12))
        .onChange(of: value, initial: true) { _, text in
            if !draft.isComposing, draft.text != text { draft.text = text }
        }
        .onDisappear { editor.finishEditing(); onChange(draft.text, false, editorID) }
    }
}

private struct NoticeActionFields: View {
    let item: SessionNoticeModel
    let action: V2RuntimeNoticeAction
    let form: NoticeActionForm

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            ForEach(form.fields) { field in
                VStack(alignment: .leading, spacing: 6) {
                    Text(field.title).font(.subheadline)
                    if let detail = field.detail { Text(detail).font(.footnote).foregroundStyle(.secondary) }
                    input(field)
                }
            }
        }
    }
    private func value(_ field: NoticeActionForm.Field) -> JSONValue? {
        item.fields[action.id]?[field.id] ?? field.defaultValue
    }
    private func set(_ value: JSONValue?, field: NoticeActionForm.Field) { item.fields[action.id, default: [:]][field.id] = value }
    @ViewBuilder private func input(_ field: NoticeActionForm.Field) -> some View {
        switch field.kind {
        case let .text(secure):
            if secure {
                SecureField(field.title, text: Binding(get: { value(field)?.stringValue ?? "" }, set: { set(.string($0), field: field) }))
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
            } else {
                NoticeTextInput(value: value(field)?.stringValue ?? "", placeholder: field.title, onChange: { text, marked, editorID in
                    set(text.isEmpty ? nil : .string(text), field: field)
                    if marked { item.composingFields.insert(editorID) } else { item.composingFields.remove(editorID) }
                })
            }
        case .number:
            TextField(field.title, text: Binding(get: { value(field)?.displayString ?? "" }, set: { set($0.isEmpty ? nil : .string($0), field: field) }))
                .keyboardType(.numbersAndPunctuation)
        case .boolean:
            Toggle(field.title, isOn: Binding(get: { value(field)?.boolValue ?? false }, set: { set(.bool($0), field: field) }))
        case let .choice(options):
            ForEach(Array(options.enumerated()), id: \.offset) { _, option in
                Button { set(option, field: field) } label: {
                    Label(option.displayString, systemImage: value(field) == option ? "checkmark.circle.fill" : "circle")
                        .frame(minHeight: 44)
                }.buttonStyle(.plain)
            }
        case let .choices(options):
            ForEach(Array(options.enumerated()), id: \.offset) { _, option in
                let selected = value(field)?.arrayValue ?? []
                Button {
                    set(.array(selected.contains(option) ? selected.filter { $0 != option } : selected + [option]), field: field)
                } label: {
                    Label(option.displayString, systemImage: selected.contains(option) ? "checkmark.square.fill" : "square")
                        .frame(minHeight: 44)
                }.buttonStyle(.plain)
            }
        }
    }
}

struct SessionInteractionDock: View {
    let chat: SessionChatModel
    let maximumHeight: CGFloat
    let onShowAll: () -> Void
    @State private var contentHeight: CGFloat = 0

    private var items: [SessionNoticeModel] { chat.session.notices.notices.filter { $0.blocks(chat.session.id) } }

    var body: some View {
        if let first = items.first {
            VStack(spacing: 6) {
                HStack {
                    Text(items.count > 1 ? "\(items.count) 项待回应" : "需要你的回应").font(.caption.weight(.medium)).foregroundStyle(.secondary)
                    Spacer()
                    Button("展开", action: onShowAll).font(.caption)
                }
                .padding(.horizontal, 6)
                ScrollView {
                    SessionInteractionCard(item: first, chat: chat)
                        .onGeometryChange(for: CGFloat.self, of: { $0.size.height }) { contentHeight = $0 }
                }
                .frame(height: min(maximumHeight, contentHeight > 0 ? contentHeight : maximumHeight))
                .scrollBounceBehavior(.basedOnSize)
                .clipShape(.rect(cornerRadius: 22))
            }
            .padding(.horizontal, 16).padding(.top, 6)
        }
    }
}
