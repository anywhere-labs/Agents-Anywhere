#if DEBUG
import AAClientCore
import Foundation

/// Debug-only launch automation for Simulator runs and screenshots (never compiled into Release):
///
///     SIMCTL_CHILD_AA_DEBUG_CONTROL_URL=http://127.0.0.1:8790 \
///     SIMCTL_CHILD_AA_DEBUG_EMAIL=dev@aa.local SIMCTL_CHILD_AA_DEBUG_PASSWORD=… \
///     SIMCTL_CHILD_AA_DEBUG_ROUTE='new:pi:Say hello' xcrun simctl launch booted dev.agentsanywhere.v3
///
/// `AA_DEBUG_ROUTE`: `device` (first online device), `terminal` (a new terminal on it), `settings`, `newsheet`
/// (the new-conversation sheet), `new:<agent>:<message>` (create a conversation, send the message, open it),
/// `conversation:<device id>:<session id>`.
enum DebugLaunch {
    @MainActor
    static func run(_ model: AppModel) async {
        let env = ProcessInfo.processInfo.environment
        if model.phase == .signedOut, let url = env["AA_DEBUG_CONTROL_URL"], let email = env["AA_DEBUG_EMAIL"],
           let password = env["AA_DEBUG_PASSWORD"]
        {
            do {
                try await model.signIn(controlURL: url, email: email, password: password)
            } catch {
                print("[debug] sign-in failed: \(error)")
                return
            }
        }
        guard model.phase == .signedIn, let route = env["AA_DEBUG_ROUTE"], !route.isEmpty else { return }

        // Wait for the live device list.
        var device: DeviceRecord?
        for _ in 0..<60 {
            device = model.devices.first { $0.isOnline && !$0.isEncryptedHint }
            if device != nil { break }
            try? await Task.sleep(for: .milliseconds(500))
        }
        guard let device, let services = model.services else {
            print("[debug] no online device")
            return
        }

        let parts = route.split(separator: ":", maxSplits: 2).map(String.init)
        switch parts.first {
        case "device":
            model.selection = .device(device.id)
        case "settings":
            model.showingSettings = true
        case "newsheet":
            model.showingNewConversation = true
        case "terminal":
            model.selection = .device(device.id)
            do {
                let terminal = try await services.tunnels.createTerminal(device.id)
                try? await Task.sleep(for: .milliseconds(600))
                model.open(.terminal(deviceID: device.id, terminalID: terminal.id))
            } catch {
                print("[debug] terminal failed: \(error)")
            }
        case "conversation" where parts.count == 3:
            model.selection = .conversation(deviceID: parts[1], sessionID: parts[2])
        case "new" where parts.count >= 2:
            let agent = parts[1]
            let message = parts.count == 3 ? parts[2] : "Hello"
            do {
                let session = try await services.tunnels.createSession(device.id, agent: agent, cwd: nil, title: "iOS v3 \(agent)")
                model.selection = .conversation(deviceID: device.id, sessionID: session.id)
                try? await Task.sleep(for: .seconds(1.5))
                _ = try await services.tunnels.send(device.id, sessionID: session.id, clientMsgID: UUID().uuidString.lowercased(), content: message)
                print("[debug] conversation \(session.id) on \(device.id)")
            } catch {
                print("[debug] new conversation failed: \(error)")
            }
        default:
            print("[debug] unknown route \(route)")
        }
    }
}
#endif
