import SwiftUI

enum WorkspaceTool: String, Identifiable {
    case file, terminal
    var id: String { rawValue }
}

struct WorkspaceToolView: View {
    let client: MeshSessionsClient
    let root: String
    let kind: WorkspaceTool

    @Environment(\.dismiss) private var dismiss
    @State private var input = ""
    @State private var output = ""
    @State private var terminalID: String?
    @State private var busy = false
    @State private var ended = false
    @State private var failed = false

    private var terminal: Bool { kind == .terminal }

    var body: some View {
        NavigationStack {
            Form {
                TextField(terminal ? "connection.terminal_input" : "connection.file_path", text: $input)
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                Button(terminal ? "connection.terminal_send" : "connection.read_file", action: submit)
                    .disabled(input.isEmpty || busy || ended || (terminal && terminalID == nil))
                if busy || (terminal && terminalID == nil && !failed) { ProgressView() }
                if ended { Text("connection.terminal_ended") }
                if failed { Text("connection.tool_failed").foregroundStyle(.red) }
                if !output.isEmpty {
                    Text(output).font(.system(.footnote, design: .monospaced)).textSelection(.enabled)
                }
            }
            .navigationTitle(terminal ? "connection.terminal" : "connection.device_file")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { SheetCloseToolbar { dismiss() } }
        }
        .task {
            guard terminal else { return }
            do {
                let id = try await client.startTerminal(root: root)
                defer {
                    Task { _ = try? await client.closeTerminal(id: id) }
                }
                terminalID = id
                var seq = 0
                var bytes = Data()
                while !Task.isCancelled && !ended {
                    do {
                        try await client.terminalEvents(id: id, fromSeq: seq) { event in
                            let type = event["type"]?.string
                            if type == "exit" { ended = true; failed = false }
                            guard let data = event["data"]?.string.flatMap({ Data(base64Encoded: $0) }),
                                  let next = event["seq"]?.int, type == "replay" || next > seq else { return }
                            if type == "replay" { bytes = data } else { bytes.append(data) }
                            if bytes.count > 65_536 { bytes = Data(bytes.suffix(65_536)) }
                            seq = next
                            output = String(decoding: bytes, as: UTF8.self)
                            failed = false
                        }
                    } catch is CancellationError {
                        return
                    } catch {
                        failed = true
                    }
                    if !ended { try await Task.sleep(for: .seconds(1)) }
                }
            } catch is CancellationError {
                return
            } catch {
                failed = true
            }
        }
    }

    private func submit() {
        guard !busy else { return }
        busy = true
        failed = false
        let value = input
        Task {
            defer { busy = false }
            do {
                if let terminalID {
                    try await client.writeTerminal(id: terminalID, line: value)
                    if input == value { input = "" }
                } else {
                    output = try await client.readFile(root: root, path: value)
                }
            } catch {
                failed = true
            }
        }
    }
}
