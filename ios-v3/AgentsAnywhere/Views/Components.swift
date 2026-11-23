import AAClientCore
import SwiftUI

/// System Liquid Glass where it actually floats over content (iOS 26+), a system material before that, and an
/// opaque surface when Reduce Transparency is on. Never tinted: the system decides the glass.
struct FloatingSurface: ViewModifier {
    var cornerRadius: CGFloat = 26
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.colorSchemeContrast) private var contrast

    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        Group {
            if reduceTransparency {
                content.background(Color(.secondarySystemBackground), in: shape)
            } else if #available(iOS 26.0, *) {
                content.glassEffect(.regular, in: shape)
            } else {
                content.background(.regularMaterial, in: shape)
            }
        }
        .overlay {
            if contrast == .increased { shape.strokeBorder(Color.primary.opacity(0.35), lineWidth: 1) }
        }
    }
}

extension View {
    func floatingSurface(cornerRadius: CGFloat = 26) -> some View {
        modifier(FloatingSurface(cornerRadius: cornerRadius))
    }

    /// A round glass button background (iOS 26), or a plain material circle.
    @ViewBuilder
    func glassCircle() -> some View {
        if #available(iOS 26.0, *) {
            self.buttonStyle(.glass).buttonBorderShape(.circle)
        } else {
            self.buttonStyle(.bordered).buttonBorderShape(.circle)
        }
    }

    @ViewBuilder
    func prominentGlassCircle() -> some View {
        if #available(iOS 26.0, *) {
            self.buttonStyle(.glassProminent).buttonBorderShape(.circle)
        } else {
            self.buttonStyle(.borderedProminent).buttonBorderShape(.circle)
        }
    }
}

struct PresenceDot: View {
    let online: Bool
    var body: some View {
        Circle()
            .fill(online ? Color.green : Color.secondary.opacity(0.5))
            .frame(width: 8, height: 8)
            .accessibilityLabel(online ? "在线" : "离线")
    }
}

struct LockView: View {
    let badge: LockBadge
    var body: some View {
        switch badge {
        case .none:
            EmptyView()
        case .green:
            Image(systemName: "lock.fill")
                .foregroundStyle(.green)
                .imageScale(.small)
                .accessibilityLabel("端到端加密，已配对")
        case .unpaired:
            Image(systemName: "lock.slash")
                .foregroundStyle(.secondary)
                .imageScale(.small)
                .accessibilityLabel("加密设备，未配对")
        }
    }
}

nonisolated enum AgentStyle {
    static func symbol(_ agent: String) -> String {
        switch agent.lowercased() {
        case let name where name.contains("claude"): "sparkle"
        case let name where name.contains("codex"): "chevron.left.forwardslash.chevron.right"
        case let name where name.contains("gemini"): "diamond"
        case let name where name.contains("antigravity"): "arrow.up.circle"
        case let name where name.hasPrefix("pi"): "p.circle"
        case let name where name.contains("dsh"): "terminal"
        default: "cpu"
        }
    }

    static func name(_ agent: String) -> String {
        switch agent.lowercased() {
        case "claude", "claude-code": "Claude Code"
        case "codex": "Codex"
        case "gemini": "Gemini"
        case "antigravity": "Antigravity"
        case "pi": "Pi"
        case "dsh": "DSH"
        default: agent.prefix(1).uppercased() + agent.dropFirst()
        }
    }
}

struct AgentIcon: View {
    let agent: String
    var body: some View {
        Image(systemName: AgentStyle.symbol(agent))
            .foregroundStyle(.secondary)
            .frame(width: 22)
            .accessibilityHidden(true)
    }
}

nonisolated enum DeviceStyle {
    static func symbol(_ platform: String) -> String {
        switch platform {
        case "macos": "laptopcomputer"
        case "windows": "pc"
        default: "server.rack"
        }
    }
}

struct SessionStateIcon: View {
    let state: String
    var body: some View {
        switch state {
        case "running":
            ProgressView().controlSize(.mini).accessibilityLabel("运行中")
        case "waiting":
            Image(systemName: "hand.raised.fill").foregroundStyle(.orange).imageScale(.small).accessibilityLabel("等待审批")
        case "error":
            Image(systemName: "exclamationmark.circle.fill").foregroundStyle(.red).imageScale(.small).accessibilityLabel("出错")
        default:
            EmptyView()
        }
    }
}

nonisolated enum RelativeTime {
    static func text(_ iso: String) -> String {
        guard let date = ISO8601.parse(iso) else { return "" }
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .short
        return formatter.localizedString(for: date, relativeTo: Date())
    }
}

struct SessionRow: View {
    let session: SessionSummary
    var deviceName: String?
    /// Inside a device page grouped by agent and project: only the time.
    var compact = false

    var body: some View {
        HStack(spacing: 10) {
            AgentIcon(agent: session.agent)
            VStack(alignment: .leading, spacing: 2) {
                Text(session.title.isEmpty ? "新对话" : session.title)
                    .lineLimit(1)
                    .fontWeight(session.unread ? .semibold : .regular)
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 4)
            SessionStateIcon(state: session.state)
            if session.pinned { Image(systemName: "pin.fill").imageScale(.small).foregroundStyle(.secondary) }
        }
        .accessibilityElement(children: .combine)
    }

    private var subtitle: String {
        if compact { return RelativeTime.text(session.updatedAt) }
        var parts: [String] = []
        if let deviceName { parts.append(deviceName) }
        parts.append(AgentStyle.name(session.agent))
        parts.append(session.projectName)
        parts.append(RelativeTime.text(session.updatedAt))
        return parts.filter { !$0.isEmpty }.joined(separator: " · ")
    }
}

/// A small error banner that floats at the top and clears itself.
struct ErrorToast: ViewModifier {
    @Binding var message: String?

    func body(content: Content) -> some View {
        content.overlay(alignment: .top) {
            if let message {
                Text(message)
                    .font(.footnote)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .floatingSurface(cornerRadius: 18)
                    .padding(.horizontal)
                    .padding(.top, 8)
                    .transition(.move(edge: .top).combined(with: .opacity))
                    .task(id: message) {
                        try? await Task.sleep(for: .seconds(4))
                        withAnimation { self.message = nil }
                    }
                    .onTapGesture { withAnimation { self.message = nil } }
                    .accessibilityAddTraits(.isStaticText)
            }
        }
        .animation(.default, value: message)
    }
}

extension View {
    func errorToast(_ message: Binding<String?>) -> some View {
        modifier(ErrorToast(message: message))
    }
}
