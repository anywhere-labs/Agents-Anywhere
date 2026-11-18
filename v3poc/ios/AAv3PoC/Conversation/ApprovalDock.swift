import SwiftUI

/// Native approval dock for `control.pending[0]`, styled like the real app's `SessionInteractionCard`.
/// The renderer only marks the waiting tool call; the buttons live here (`chrome.approvals = 'host'`).
struct ApprovalDock: View {
    let request: PendingRequest
    let agentLabel: String
    let count: Int
    var enabled = true
    let onAnswer: (String) -> Void
    @ScaledMetric(relativeTo: .subheadline) private var lineHeight: CGFloat = 20

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .center, spacing: 8) {
                AppSymbol("checkmark.shield", size: 18)
                Text("\(agentLabel) 请求执行命令").font(.subheadline.weight(.semibold))
                    .lineLimit(1).frame(maxWidth: .infinity, alignment: .leading)
                if count > 1 {
                    Text("1/\(count)").font(.caption).monospacedDigit().foregroundStyle(.secondary)
                }
            }
            .frame(minHeight: 28)

            Text(request.title)
                .font(.system(.subheadline, design: .monospaced))
                .foregroundStyle(.secondary)
                .lineLimit(2)
                .frame(maxWidth: .infinity, minHeight: lineHeight * 2, alignment: .topLeading)
                .textSelection(.enabled)

            ViewThatFits(in: .horizontal) {
                HStack(spacing: 8) { buttons(request.options) }
                HStack(spacing: 8) {
                    buttons(request.options.filter { $0.kind != "allow_always" })
                    let more = request.options.filter { $0.kind == "allow_always" }
                    if !more.isEmpty {
                        Menu {
                            ForEach(more) { option in Button(option.name) { onAnswer(option.id) } }
                        } label: { Label("更多", appSymbol: "ellipsis") }
                            .labelStyle(.iconOnly)
                            .buttonStyle(.glass).buttonBorderShape(.circle).controlSize(.large)
                    }
                }
            }
            .font(.subheadline)
            .disabled(!enabled)
        }
        .padding(.horizontal, 14).padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassEffect(.regular, in: .rect(cornerRadius: 24))
        .chromeRegion("dock")
        .padding(.horizontal, 24)
        .accessibilityElement(children: .contain)
    }

    @ViewBuilder private func buttons(_ options: [PendingRequest.Option]) -> some View {
        ForEach(options) { option in
            AppGlassButton(option.name, role: option.isReject ? .destructive : nil,
                           style: option.kind == "allow_once" ? .prominent : .regular, maxWidth: .infinity) {
                onAnswer(option.id)
            }
            .fixedSize(horizontal: option.kind == "allow_always", vertical: false)
        }
    }
}
