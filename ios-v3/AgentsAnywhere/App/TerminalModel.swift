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
    var ctrlLatched = false
    var errorMessage: String?
    private(set) var attached = false
    private weak var app: AppModel?
    private var theme: RenderTheme?
    private var call: DuplexCall<JSONValue, JSONValue>?
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
            var messages: [JSONValue] = []
            if let theme { messages.append(theme.message) }
            messages.append(BridgeOut.locale(Locale.preferredLanguages.first ?? "zh-CN"))
            messages.append(BridgeOut.viewTerminal(deviceID: deviceID, terminalID: terminalID))
            bridge.send(messages)
        case .terminal(let type, let fields):
            guard (fields["terminal_id"]?.stringValue ?? terminalID) == terminalID else { return }
            switch type {
            case "attach": attach(fields)
            case "detach": detach()
            case "input", "resize", "claim", "release":
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

    private func attach(_ fields: [String: JSONValue]) {
        guard let services = app?.services, readTask == nil else { return }
        let mode = fields["mode"]?.stringValue
        let size: JSONValue? = if let cols = fields["cols"]?.intValue, let rows = fields["rows"]?.intValue {
            ["type": "resize", "cols": .int(cols), "rows": .int(rows)]
        } else { nil }
        readTask = Task { [weak self] in
            guard let self else { return }
            do {
                let call = try await services.tunnels.attachTerminal(deviceID, terminalID: terminalID, mode: mode)
                self.call = call
                attached = true
                if let size { try? await call.send(size) }
                for try await frame in call {
                    bridge.send(BridgeOut.terminalFrame(terminalID: terminalID, frame: frame))
                }
                bridge.send(BridgeOut.terminalFrame(terminalID: terminalID, frame: ["type": "closed"]))
            } catch {
                if !Task.isCancelled { errorMessage = "终端连接断开：\(AppModel.describe(error))" }
            }
            attached = false
            self.call = nil
            readTask = nil
        }
    }

    private func detach() {
        readTask?.cancel()
        readTask = nil
        if let call {
            Task { await call.cancel() }
        }
        call = nil
        attached = false
    }

    private func sendFrame(_ frame: JSONValue) {
        guard let call else { return }
        Task {
            do { try await call.send(frame) } catch { errorMessage = AppModel.describe(error) }
        }
    }

    /// A key of the extra-keys bar. Ctrl latches for one key.
    func key(_ key: String, ctrl: Bool = false) {
        let useCtrl = ctrl || ctrlLatched
        ctrlLatched = false
        bridge.send(BridgeOut.terminalKey(key, ctrl: useCtrl))
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
        ("Esc", "Escape", nil), ("Tab", "Tab", nil), ("", "ArrowUp", "arrow.up"), ("", "ArrowDown", "arrow.down"),
        ("", "ArrowLeft", "arrow.left"), ("", "ArrowRight", "arrow.right"), ("PgUp", "PageUp", nil), ("PgDn", "PageDown", nil),
        ("Home", "Home", nil), ("End", "End", nil),
    ]

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                Button { model.ctrlLatched.toggle() } label: { keyLabel("Ctrl", symbol: nil) }
                    .buttonStyle(.bordered)
                    .tint(model.ctrlLatched ? .accentColor : nil)
                    .accessibilityAddTraits(model.ctrlLatched ? .isSelected : [])
                Button { model.key("c", ctrl: true) } label: { keyLabel("^C", symbol: nil) }
                    .buttonStyle(.bordered)
                    .accessibilityLabel("Control C")
                ForEach(keys, id: \.key) { item in
                    Button { model.key(item.key) } label: { keyLabel(item.label, symbol: item.symbol) }
                        .buttonStyle(.bordered)
                        .accessibilityLabel(item.key)
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
