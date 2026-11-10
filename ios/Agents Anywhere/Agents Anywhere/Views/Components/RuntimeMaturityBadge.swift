import SwiftUI

/// Shown beside a runtime's status, never instead of it: "Pi Beta · Running".
/// Stable runtimes show nothing.
struct RuntimeMaturityBadge: View {
    let maturity: String?

    var body: some View {
        if let badge = ModelConfigPresentation.maturityBadge(maturity) {
            Text(ModelConfigPresentation.maturityLabel(badge))
                .font(.caption2.weight(.medium)).foregroundStyle(.secondary)
                .padding(.horizontal, 6).padding(.vertical, 2)
                .overlay(Capsule().strokeBorder(.secondary.opacity(0.5), lineWidth: 1))
                .fixedSize()
                .accessibilityLabel(Text(ModelConfigPresentation.maturityLabel(badge)))
                .accessibilityHint(Text(ModelConfigPresentation.maturityDescription(badge)))
                .help(ModelConfigPresentation.maturityDescription(badge))
        }
    }
}

/// A status word with the tone the model configuration page uses.
struct ModelStatusBadge: View {
    let title: String
    let tone: ModelStatusTone

    var body: some View {
        Text(title)
            .font(.caption2.weight(.medium)).foregroundStyle(color)
            .padding(.horizontal, 6).padding(.vertical, 2)
            .overlay(Capsule().strokeBorder(color.opacity(0.5), lineWidth: 1))
            .fixedSize()
    }

    private var color: Color {
        switch tone {
        case .ok: .green
        case .progress: .blue
        case .warning: .orange
        case .error: .red
        case .neutral: .secondary
        }
    }
}
