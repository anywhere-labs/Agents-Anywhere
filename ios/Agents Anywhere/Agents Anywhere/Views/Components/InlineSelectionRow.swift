import SwiftUI

/// Models/reasoning and devices/Agents share the same inline hierarchy while
/// List and DisclosureGroup retain their system backgrounds and interaction.
struct InlineSelectionButton: View {
    let title: String
    var detail: String? = nil
    var isSelected = false
    var isWorking = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            InlineSelectionLabel(title: title, detail: detail, isSelected: isSelected, isWorking: isWorking)
        }
    }
}

struct InlineSelectionGroup<Content: View>: View {
    let title: String
    var detail: String? = nil
    var isSelected = false
    @Binding var isExpanded: Bool
    @ViewBuilder let content: () -> Content

    var body: some View {
        DisclosureGroup(isExpanded: $isExpanded, content: content) {
            InlineSelectionLabel(title: title, detail: detail, isSelected: isSelected)
        }
    }
}

private struct InlineSelectionLabel: View {
    let title: String
    let detail: String?
    let isSelected: Bool
    var isWorking = false

    var body: some View {
        HStack(spacing: 12) {
            ZStack {
                AppSymbol("checkmark", size: 18).opacity(isSelected && !isWorking ? 1 : 0)
                if isWorking { ProgressView().controlSize(.small) }
            }.frame(width: 20, height: 20).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(.body.weight(.medium)).foregroundStyle(.primary)
                if let detail, !detail.isEmpty {
                    Text(detail).font(.footnote).foregroundStyle(.secondary)
                }
            }
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.vertical, 6)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }
}
