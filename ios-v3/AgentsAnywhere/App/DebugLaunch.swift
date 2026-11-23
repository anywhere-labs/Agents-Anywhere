#if DEBUG
import AAClientCore
import Foundation

/// Debug-only launch automation for Simulator runs and screenshots (never compiled into Release):
///
///     SIMCTL_CHILD_AA_DEBUG_CONTROL_URL=http://127.0.0.1:8790 \
///     SIMCTL_CHILD_AA_DEBUG_EMAIL=dev@aa.local SIMCTL_CHILD_AA_DEBUG_PASSWORD=… \
///     SIMCTL_CHILD_AA_DEBUG_ROUTE='new:pi:Say hello' xcrun simctl launch booted dev.agentsanywhere.v3
///
/// `AA_DEBUG_DEVICE` (id or part of the name) picks the device; otherwise the first online normal one.
/// `AA_DEBUG_ROUTE`: `device` (first online device), `terminal` (a new terminal on it), `settings`, `newsheet`
/// (the new-conversation sheet), `new:<agent>:<message>` (create a conversation, send the message, open it),
/// `conversation:<device id>:<session id>`, `pairsheet` (the pairing sheet), `pair:<aa-pair://v1/…>` (pair with
/// that encrypted device, then open it).
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

        // `pair:<aa-pair://v1/…>`: pair with an encrypted device (IKpsk2), then open it.
        if route.hasPrefix("pair:"), let services = model.services {
            let uri = String(route.dropFirst("pair:".count))
            for _ in 0..<40 where model.devices.isEmpty { try? await Task.sleep(for: .milliseconds(500)) }
            do {
                let status = try await services.tunnels.pair(uri: uri)
                model.trustChanged()
                print("[debug] paired \(status.deviceID) (\(status.deviceName)) mode \(status.mode)")
                model.selection = .device(status.deviceID)
            } catch {
                print("[debug] pairing failed: \(error)")
            }
            return
        }
        if route == "pairsheet" {
            model.pairingTarget = PairingTarget(deviceID: nil)
            return
        }

        // Wait for the live device list.
        var device: DeviceRecord?
        for _ in 0..<60 {
            let wanted = env["AA_DEBUG_DEVICE"]
            device = model.devices.first {
                guard $0.isOnline else { return false }
                guard let wanted, !wanted.isEmpty else { return !$0.isEncryptedHint }
                return $0.id == wanted || $0.name.localizedCaseInsensitiveContains(wanted)
            }
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
                model.createdTerminals.insert(terminal.id)
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
