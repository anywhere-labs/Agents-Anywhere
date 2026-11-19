import SwiftUI

struct CreateSessionView: View {
    let controller: SessionController
    let runtimes: [RuntimeChoice]
    let onOpen: (String) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var runtimeID = ""
    @State private var cwd = ""
    @State private var prompt = ""
    @State private var operationID = UUID().uuidString
    @State private var busy = false
    @State private var failed = false

    private var selectedRuntime: RuntimeChoice? { runtimes.first { $0.id == runtimeID } ?? runtimes.first }

    var body: some View {
        NavigationStack {
            Form {
                if runtimes.isEmpty {
                    Text("connection.no_runtimes")
                } else {
                    Picker("connection.runtime", selection: $runtimeID) {
                        ForEach(runtimes) { entry in Text(entry.name).tag(entry.id) }
                    }
                }
                TextField("connection.workspace", text: $cwd)
                    .autocorrectionDisabled().textInputAutocapitalization(.never)
                TextField("connection.first_message", text: $prompt, axis: .vertical).lineLimit(2...6)
                Button("connection.create", action: create).disabled(
                    busy || selectedRuntime == nil || cwd.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ||
                    prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                )
                if busy { ProgressView() }
                if failed { Text("connection.create_failed").foregroundStyle(.red) }
            }
            .disabled(busy)
            .navigationTitle("connection.create")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("connection.cancel") { dismiss() } }
            }
            .onAppear {
                runtimeID = runtimes.first?.id ?? ""
                cwd = controller.selectedSummary?.cwd.nonEmpty ?? controller.workspace.projects.first?.cwd ?? ""
            }
            .onChange(of: runtimeID) { operationID = UUID().uuidString }
            .onChange(of: cwd) { operationID = UUID().uuidString }
            .onChange(of: prompt) { operationID = UUID().uuidString }
        }
        .interactiveDismissDisabled(busy)
    }

    private func create() {
        guard let runtime = selectedRuntime, !busy else { return }
        busy = true
        failed = false
        Task {
            defer { busy = false }
            do {
                let session = try await controller.create(
                    runtime: runtime, cwd: cwd.trimmingCharacters(in: .whitespacesAndNewlines),
                    text: prompt.trimmingCharacters(in: .whitespacesAndNewlines), operationID: operationID
                )
                dismiss()
                onOpen(session)
            } catch {
                failed = true
            }
        }
    }
}

private extension String {
    var nonEmpty: String? { isEmpty ? nil : self }
}
