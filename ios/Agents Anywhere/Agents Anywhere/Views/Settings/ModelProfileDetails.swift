import SwiftUI

/// A model profile's details: each one labelled, and wrapping instead of
/// being cut off. Models and per-protocol addresses open on request, so they
/// do not need hover or a wide screen.
struct ModelProfileDetails: View {
    let profile: V2ModelProfile
    let usedBy: Int
    @State private var expanded: Bool

    init(profile: V2ModelProfile, usedBy: Int, expanded: Bool = false) {
        self.profile = profile
        self.usedBy = usedBy
        _expanded = State(initialValue: expanded)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: 12, verticalSpacing: 4) {
                row(String(localized: "Address")) { Text(profile.originHost) }
                if let hint = profile.keyHint, !hint.isEmpty {
                    row(String(localized: "API key")) { Text(hint).monospaced() }
                }
                row(String(localized: "Usage")) {
                    Text(usedBy > 0 ? String(localized: "Used by \(usedBy)") : String(localized: "Not in use"))
                }
                row(String(localized: "Protocols")) {
                    ChipFlow {
                        ForEach(profile.offers, id: \.format) { offer in
                            Chip(text: ModelConfigPresentation.offerSummary(offer))
                        }
                    }
                }
            }
            Button {
                withAnimation(.snappy) { expanded.toggle() }
            } label: {
                Label(expanded ? String(localized: "Hide") : String(localized: "Show models and addresses"),
                      systemImage: expanded ? "chevron.down" : "chevron.right")
            }
            .buttonStyle(.borderless)
            .foregroundStyle(.secondary)
            if expanded {
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(profile.offers, id: \.format) { offer in offerDetails(offer) }
                }
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(.quaternary.opacity(0.4), in: .rect(cornerRadius: 10))
            }
        }
        .font(.footnote)
    }

    private func offerDetails(_ offer: V2ModelOffer) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(ModelConfigPresentation.protocolLabel(offer.format)).fontWeight(.semibold)
            Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: 12, verticalSpacing: 4) {
                row(String(localized: "Address")) { Text(offer.baseUrl) }
                row(String(localized: "Models")) {
                    if offer.models.isEmpty {
                        Text(String(localized: "No models listed; the runtime reads them from this address."))
                            .foregroundStyle(.secondary)
                    } else {
                        ChipFlow {
                            ForEach(offer.models, id: \.id) { model in
                                Chip(text: model.name.flatMap { $0 == model.id ? nil : "\($0)  \(model.id)" } ?? model.id)
                            }
                        }
                    }
                }
            }
        }
    }

    private func row<Value: View>(_ label: String, @ViewBuilder value: () -> Value) -> some View {
        GridRow {
            Text(label).foregroundStyle(.secondary)
            value()
                .frame(maxWidth: .infinity, alignment: .leading)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

private struct Chip: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.caption)
            .padding(.horizontal, 7).padding(.vertical, 2)
            .overlay(Capsule().strokeBorder(.secondary.opacity(0.5), lineWidth: 1))
    }
}

/// Lays chips out left to right and wraps them onto further lines.
private struct ChipFlow: Layout {
    var spacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let rows = arrange(width: proposal.width ?? .infinity, subviews: subviews)
        let width = rows.map { $0.width }.max() ?? 0
        let height = rows.reduce(0) { $0 + $1.height } + spacing * CGFloat(max(rows.count - 1, 0))
        return CGSize(width: proposal.width ?? width, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var y = bounds.minY
        for row in arrange(width: bounds.width, subviews: subviews) {
            var x = bounds.minX
            for index in row.indices {
                let size = subviews[index].sizeThatFits(.init(width: bounds.width, height: nil))
                subviews[index].place(at: CGPoint(x: x, y: y), proposal: .init(width: min(size.width, bounds.width), height: size.height))
                x += size.width + spacing
            }
            y += row.height + spacing
        }
    }

    private struct Row { var indices: [Int] = []; var width: CGFloat = 0; var height: CGFloat = 0 }

    private func arrange(width: CGFloat, subviews: Subviews) -> [Row] {
        var rows: [Row] = [Row()]
        for index in subviews.indices {
            let size = subviews[index].sizeThatFits(.init(width: width, height: nil))
            let needed = rows[rows.count - 1].indices.isEmpty ? size.width : rows[rows.count - 1].width + spacing + size.width
            if needed > width, !rows[rows.count - 1].indices.isEmpty { rows.append(Row()) }
            let last = rows.count - 1
            rows[last].width += (rows[last].indices.isEmpty ? 0 : spacing) + min(size.width, width)
            rows[last].height = max(rows[last].height, size.height)
            rows[last].indices.append(index)
        }
        return rows.filter { !$0.indices.isEmpty }
    }
}
