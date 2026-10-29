import SwiftUI

struct RuntimeWorkflowView: View {
    let operation: V2RuntimeWorkflow
    let pending: Bool
    let onRespond: (V2WorkflowInteraction, String, JSONValue?) -> Void
    let onCancel: () -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(operation.state.interactions.filter { $0.status == "open" }) { request in
                RuntimeWorkflowInput(request: request, pending: pending) { action, value in onRespond(request, action, value) }
            }
            if operation.state.interactions.contains(where: { $0.status == "open" }) && (operation.state.canCancel == true || operation.state.canCancelInitialization == true) {
                Button("取消", role: .cancel, action: onCancel).disabled(pending)
            }
        }
    }
}

struct RuntimeWorkflowInput: View {
    let request: V2WorkflowInteraction
    let pending: Bool
    let respond: (String, JSONValue?) -> Void
    @State private var text = ""
    @State private var selected = ""
    @State private var confirmed = false
    @State private var formValues: [String: JSONValue] = [:]
    private var options: [JSONValue] { if case let .array(values) = request.metadata["options"] { return values }; return [] }
    private var answer: JSONValue? {
        switch request.kind {
        case "form": .object(["kind": .string("form"), "values": .object(formValues)])
        case "confirm": .object(["kind": .string("confirm"), "status": .string("submitted"), "value": .bool(confirmed)])
        case "select": .object(["kind": .string("select"), "status": .string("submitted"), "optionId": .string(selected)])
        case "input", "editor": .object(["kind": .string(request.kind), "status": .string("submitted"), "text": .string(text)])
        default: nil
        }
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(request.title).font(.subheadline.weight(.medium))
            if let message = request.message { Text(message).font(.caption).textSelection(.enabled) }
            switch request.kind {
            case "form": StructuredAgentFields(schema: request.metadata["formSchema"] ?? .object([:]), values: $formValues, disabled: pending)
            case "confirm": Toggle("确认", isOn: $confirmed)
            case "select": Picker("请选择", selection: $selected) {
                Text("请选择").tag("")
                ForEach(options, id: \.self) { option in Text(option["label"]?.stringValue ?? "").tag(option["id"]?.stringValue ?? "") }
            }
            case "editor": TextEditor(text: $text).frame(minHeight: 100)
            case "input": TextField(request.title, text: $text)
            default: EmptyView()
            }
            ForEach(request.actions) { action in
                Button(action.label) { respond(action.id, action.id == "submit" || action.id == "accept" ? answer : nil) }
                    .disabled(pending || (request.kind == "select" && action.id == "submit" && selected.isEmpty) || (request.kind == "form" && action.id == "accept" && !AgentForm.valid(request.metadata["formSchema"] ?? .object([:]), formValues)))
            }
        }
        .task(id: request.id) { text = request.metadata["initialValue"]?.stringValue ?? ""; formValues = AgentForm.defaults(request.metadata["formSchema"] ?? .object([:])) }
    }
}
