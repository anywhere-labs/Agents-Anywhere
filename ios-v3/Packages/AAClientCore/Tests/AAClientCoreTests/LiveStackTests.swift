import Foundation
import Testing

@testable import AAClientCore

/// End-to-end against a running AA v3 stack. Skipped unless `AA_LIVE_CONTROL_URL` is set:
///
///     AA_LIVE_CONTROL_URL=http://127.0.0.1:8790 AA_LIVE_EMAIL=dev@aa.local AA_LIVE_PASSWORD=aa-dev-password \
///     AA_LIVE_AGENT=pi swift test --filter Live
///
/// Signs in, lists devices over `aa.v3.Control`, opens a tunnel to the first online device, creates a conversation
/// with `AA_LIVE_AGENT` (default `pi`), sends a message and waits for the agent's reply on `watch`.
@Suite("Live stack", .enabled(if: ProcessInfo.processInfo.environment["AA_LIVE_CONTROL_URL"] != nil))
struct LiveStackTests {
    let env = ProcessInfo.processInfo.environment

    @Test(.timeLimit(.minutes(3))) func conversationRoundTrip() async throws {
        let store = MemorySecretStore()
        let auth = try await AuthSession.signIn(
            controlURL: env["AA_LIVE_CONTROL_URL"]!, email: env["AA_LIVE_EMAIL"] ?? "dev@aa.local",
            password: env["AA_LIVE_PASSWORD"] ?? "aa-dev-password", store: store)
        let control = ControlPlaneClient(auth: auth)

        // watch_devices: the first event is a snapshot.
        var devices: [DeviceRecord] = []
        for try await event in control.watchDevices() {
            devices = event.apply(to: devices)
            break
        }
        let device = try #require(devices.first { $0.isOnline && !$0.isEncryptedHint }, "no online normal device")

        let pool = DeviceTunnelPool(
            issuer: control, trust: TrustStore(store: store, accountID: await auth.current.user.id), identity: ClientIdentityStore(store: store))
        await pool.updateDevices(devices)
        let status = try await pool.status(device.id)
        let agent = env["AA_LIVE_AGENT"] ?? "pi"
        #expect(status.runtimes.contains { $0.id == agent }, "device has no \(agent) runtime: \(status.runtimes.map(\.id))")

        // Aggregated list through the control plane.
        var sawDevice = false
        for try await result in control.listSessions(deviceIDs: [device.id]) where result.deviceID == device.id {
            sawDevice = true
            #expect(["ok", "timeout", "error"].contains(result.status))
        }
        #expect(sawDevice)

        let session = try await pool.createSession(device.id, agent: agent, cwd: nil, title: "iOS core live test")

        var state = ConversationState()
        let clientMsgID = UUID().uuidString
        var sent = false
        var reply = ""
        watching: for try await update in pool.watch(device.id, sessionID: session.id) {
            state.apply(update)
            if !sent, case .snapshot = update.event {
                let response = try await pool.send(device.id, sessionID: session.id, clientMsgID: clientMsgID, content: "Reply with exactly: pong")
                #expect(["started", "queued"].contains(response.delivered))
                sent = true
            }
            let typed = state.typedMessages
            guard sent, let userMessage = typed.first(where: { $0.clientMsgID == clientMsgID }) else { continue }
            let assistantText = typed.filter { $0.role == .assistant && $0.turnID == userMessage.id }.map(\.text).joined()
            if !state.control.isRunning, !assistantText.isEmpty {
                reply = assistantText
                break watching
            }
            if state.control.state == "error" {
                Issue.record("agent error: \(state.control.error ?? "")")
                break watching
            }
        }
        #expect(!reply.isEmpty)
        print("live reply from \(agent): \(reply.prefix(200))")
        let page = try await pool.listMessages(device.id, sessionID: session.id, beforeSeq: nil, limit: 10)
        #expect(!page.messages.isEmpty)
        try? await pool.deleteSession(device.id, sessionID: session.id)
        await pool.closeAll()
        await control.close()
    }

    /// Create a terminal, attach in control mode, type a command and read its output back.
    @Test(.timeLimit(.minutes(1))) func terminalRoundTrip() async throws {
        let store = MemorySecretStore()
        let auth = try await AuthSession.signIn(
            controlURL: env["AA_LIVE_CONTROL_URL"]!, email: env["AA_LIVE_EMAIL"] ?? "dev@aa.local",
            password: env["AA_LIVE_PASSWORD"] ?? "aa-dev-password", store: store)
        let control = ControlPlaneClient(auth: auth)
        let devices = try await control.listDevices()
        let device = try #require(devices.first { $0.isOnline && !$0.isEncryptedHint })
        let pool = DeviceTunnelPool(
            issuer: control, trust: TrustStore(store: store, accountID: await auth.current.user.id), identity: ClientIdentityStore(store: store))
        let terminal = try await pool.createTerminal(device.id)
        let call = try await pool.attachTerminal(
            device.id, terminalID: terminal.id, options: ["mode": "control", "cols": 80, "rows": 24, "label": "ios-test"])
        var output = ""
        var sent = false
        for try await frame in call {
            let type = frame["type"]?.stringValue
            if type == "control", !sent {
                let generation = frame["generation"] ?? 0
                if frame["you"]?.boolValue != true { try await call.send(["type": "claim", "cols": 80, "rows": 24]) }
                let command = Data("echo ios-$((40+2))\r".utf8).base64EncodedString()
                try await call.send(["type": "input", "data": .string(command), "generation": generation])
                sent = true
            }
            if let data = frame["data"]?.stringValue, let bytes = Data(base64Encoded: data) {
                output += String(decoding: bytes, as: UTF8.self)
                if output.contains("ios-42") { break }
            }
        }
        #expect(output.contains("ios-42"))
        await call.cancel()
        try? await pool.closeTerminal(device.id, terminalID: terminal.id)
        await pool.closeAll()
        await control.close()
    }
}
