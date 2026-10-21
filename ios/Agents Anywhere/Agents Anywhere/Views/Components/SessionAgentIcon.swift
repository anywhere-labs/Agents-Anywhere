import SwiftUI

/// Mirrors Web's SessionAgentIcon: the session's agent mark, or Lucide Bot for
/// runtimes without one. Paths come from the same SVGs as the Web sidebar.
struct SessionAgentIcon: View {
    let runtime: String
    let runtimeType: String?
    @ScaledMetric(relativeTo: .body) private var size: CGFloat = 18

    private var agent: (asset: String, label: String)? {
        let source = runtimeType?.trimmingCharacters(in: .whitespacesAndNewlines)
        let type = String((source?.isEmpty == false ? source! : runtime).lowercased()
            .filter { !$0.isWhitespace && $0 != "_" && $0 != "-" })
        switch type {
        case "codex": return ("aa-AgentCodex", "Codex")
        case "claude", "claudecode": return ("aa-AgentClaudeCode", "Claude Code")
        case "dsh", "deepseek", "deepseekharness": return ("aa-AgentDeepSeek", "DeepSeek Harness")
        default: return nil
        }
    }

    var body: some View {
        let agent = agent
        Image(agent?.asset ?? "aa-Bot").resizable().scaledToFit()
            .frame(width: size, height: size)
            .accessibilityLabel(Text(verbatim: agent?.label ?? runtime))
    }
}
