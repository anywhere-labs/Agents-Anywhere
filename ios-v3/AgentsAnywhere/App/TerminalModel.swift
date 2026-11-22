import AAClientCore
import Foundation
import Observation
import SwiftUI

/// A terminal screen: the page draws it and handles typing; this relays `aa.v3.Terminals/attach` both ways.
@MainActor
@Observable
final class TerminalModel {
    let deviceID: String
    let terminalID: String
    let bridge = RenderBridge()
    var errorMessage: String?
    private(set) var attached = false
    private weak var app: AppModel?
    private var theme: RenderTheme?
    private var activeCall: DuplexCall<JSONValue, JSONValue>?
    private var readTask: Task<Void, Never>?

    init(app: AppModel, deviceID: String, terminalID: String) {
        self.app = app
        self.deviceID = deviceID
        self.terminalID = terminalID
        bridge.onMessage = { [weak self] message in self?.handle(message) }
    }

    func updateTheme(_ theme: RenderTheme) {
        guard theme != self.theme else { return }
        self.theme = theme
        bridge.send(theme.message)
    }

    func stop() {
        detach()
    }

    private func handle(_ message: BridgeIn) {
        switch message {
        case .ready:
            detach()
            Task { await sendView() }
        case .terminal(let type, let fields):
            guard (fields["terminal_id"]?.stringValue ?? terminalID) == terminalID else { return }
            switch type {
            case "attach": attach(fields)
            case "detach": detach()
            case "input", "resize", "claim", "release":
                // Same as the attach input frames (`generation` included); only `terminal_id` is bridge-only.
                var frame = fields
                frame.removeValue(forKey: "terminal_id")
                frame["type"] = .string(type)
                sendFrame(.object(frame))
            default: break
            }
        case .openLink(let url):
            UIApplication.shared.open(url)
        case .copy(let text):
            UIPasteboard.general.string = text
        case .haptic(let kind):
            Haptics.play(kind)
        default:
            break
        }
    }

    /// theme, locale, then `view.terminal` with what this client knows about the terminal.
    private func sendView() async {
        let info = try? await app?.services?.tunnels.listTerminals(deviceID).first { $0.id == terminalID }
        let justCreated = app?.createdTerminals.contains(terminalID) ?? false
        var messages: [JSONValue] = []
        if let theme { messages.append(theme.message) }
        messages.append(BridgeOut.locale(Locale.preferredLanguages.first ?? "zh-CN"))
        messages.append(BridgeOut.viewTerminal(
            deviceID: deviceID, terminalID: terminalID, controllerLabel: UIDevice.current.name,
            attachMode: justCreated ? "control" : nil, info: info))
        bridge.send(messages)
    }

    private func attach(_ fields: [String: JSONValue]) {
        guard let services = app?.services else { return }
        detach()
        var options = fields
        if options["label"] == nil { options["label"] = .string(UIDevice.current.name) }
        readTask = Task { [weak self] in
            guard let self else { return }
            var fatal = false
            do {
                let stream = try await services.tunnels.attachTerminal(deviceID, terminalID: terminalID, options: options)
                activeCall = stream
                attached = true
                #if DEBUG
                injectDebugKeys()
                #endif
                for try await frame in stream {
                    if frame["type"]?.stringValue == "exit" { fatal = true }
                    bridge.send(BridgeOut.terminalFrame(terminalID: terminalID, frame: frame))
                }
            } catch {
                if Task.isCancelled { return }
                #if DEBUG
                print("[terminal] attach ended: \(error)")
                #endif
                let code = (error as? MeshCallError)?.code.rawValue
                fatal = code == "invalid_argument" || code == "not_found" || error is PairingError
                if fatal { errorMessage = "终端连接断开：\(AppModel.describe(error))" }
            }
            attached = false
            activeCall = nil
            readTask = nil
            // The page reconnects (with `resume_seq`) unless the terminal is gone.
            bridge.send(BridgeOut.terminalClosed(terminalID: terminalID, fatal: fatal))
        }
    }

    private func detach() {
        readTask?.cancel()
        readTask = nil
        if let stream = activeCall {
            Task { await stream.cancel() }
        }
        activeCall = nil
        attached = false
    }

    private func sendFrame(_ frame: JSONValue) {
        guard let stream = activeCall else { return }
        #if DEBUG
        if ProcessInfo.processInfo.environment["AA_DEBUG_BRIDGE"] != nil { print("[terminal] ← \(frame)") }
        #endif
        Task {
            do { try await stream.send(frame) } catch { errorMessage = AppModel.describe(error) }
        }
    }

    #if DEBUG
    /// `AA_DEBUG_TERM_KEYS`: characters sent as extra-key presses after attaching (`\n` = enter), to exercise the
    /// key → page → `term.input` → device path in the Simulator.
    private func injectDebugKeys() {
        guard let text = ProcessInfo.processInfo.environment["AA_DEBUG_TERM_KEYS"], !text.isEmpty else { return }
        Task {
            try? await Task.sleep(for: .seconds(1.5))
            for character in text {
                key(character == "\n" ? "enter" : String(character))
                try? await Task.sleep(for: .milliseconds(40))
            }
        }
    }
    #endif

    /// A key of the extra-keys bar (names from the render bundle's `protocol.ts`).
    func key(_ key: String, ctrl: Bool = false) {
        bridge.send(BridgeOut.terminalKey(key, ctrl: ctrl))
    }

    /// Ctrl for the next character typed on the keyboard (the page latches it).
    func latchCtrl() {
        bridge.send(BridgeOut.terminalKey("ctrl"))
        Haptics.play("light")
    }
}

struct TerminalView: View {
    let deviceID: String
    let terminalID: String
    @Environment(AppModel.self) private var app
    @State private var model: TerminalModel?

    var body: some View {
        Group {
            if let model {
                TerminalScreen(model: model)
            } else {
                Color.black
            }
        }
        .navigationTitle("终端")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear {
            if model == nil { model = TerminalModel(app: app, deviceID: deviceID, terminalID: terminalID) }
        }
        .onDisappear { model?.stop() }
    }
}

struct TerminalScreen: View {
    @Bindable var model: TerminalModel
    @State private var controlsHeight: CGFloat = 0

    var body: some View {
        RenderSurface(bridge: model.bridge, extraBottom: controlsHeight) { model.updateTheme($0) }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            ExtraKeysBar(model: model)
                .onGeometryChange(for: CGFloat.self, of: { $0.size.height }) { controlsHeight = $0 }
        }
        .errorToast($model.errorMessage)
    }
}

/// Esc, Ctrl, Tab, arrows, PgUp/PgDn, Home/End: keys a phone keyboard lacks. Sent as `term.key`; the page maps them
/// to the same byte sequences as the Web terminal.
struct ExtraKeysBar: View {
    @Bindable var model: TerminalModel

    private let keys: [(label: String, key: String, symbol: String?)] = [
        ("Esc", "escape", nil), ("Tab", "tab", nil), ("", "up", "arrow.up"), ("", "down", "arrow.down"),
        ("", "left", "arrow.left"), ("", "right", "arrow.right"), ("PgUp", "page_up", nil), ("PgDn", "page_down", nil),
        ("Home", "home", nil), ("End", "end", nil),
    ]

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                Button { model.latchCtrl() } label: { keyLabel("Ctrl", symbol: nil) }
                    .buttonStyle(.bordered)
                    .accessibilityHint("下一个键入的字符按 Ctrl 组合发送")
                Button { model.key("c", ctrl: true) } label: { keyLabel("^C", symbol: nil) }
                    .buttonStyle(.bordered)
                    .accessibilityLabel("Control C")
                ForEach(keys, id: \.key) { item in
                    Button { model.key(item.key) } label: { keyLabel(item.label, symbol: item.symbol) }
                        .buttonStyle(.bordered)
                        .accessibilityLabel(item.label.isEmpty ? item.key : item.label)
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
        }
        .floatingSurface(cornerRadius: 22)
        .padding(.horizontal, 8)
        .padding(.bottom, 4)
    }

    private func keyLabel(_ text: String, symbol: String?) -> some View {
        Group {
            if let symbol { Image(systemName: symbol) } else { Text(text) }
        }
        .font(.footnote.monospaced().weight(.medium))
        .frame(minWidth: 28)
    }
}
