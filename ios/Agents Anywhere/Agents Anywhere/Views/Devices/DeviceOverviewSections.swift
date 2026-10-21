import SwiftUI

/// The device page follows Web and Android: small uppercase section titles
/// with their actions on the right, and rows that sit directly on the page
/// separated by hairlines instead of nested cards.
struct DeviceSection<Actions: View, Content: View>: View {
    let title: String
    @ViewBuilder var actions: () -> Actions
    @ViewBuilder var content: () -> Content

    init(_ title: String, @ViewBuilder actions: @escaping () -> Actions = { EmptyView() },
         @ViewBuilder content: @escaping () -> Content) {
        self.title = title
        self.actions = actions
        self.content = content
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Text(title)
                    .font(.footnote.weight(.semibold)).textCase(.uppercase).tracking(0.6)
                    .foregroundStyle(.secondary).lineLimit(1)
                    .accessibilityAddTraits(.isHeader)
                Spacer(minLength: 8)
                actions()
            }
            .frame(minHeight: 36)
            content()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Rows separated by hairlines; the first row has none above it.
struct DeviceRows<Content: View>: View {
    @ViewBuilder var content: () -> Content

    var body: some View {
        Group(subviews: content()) { rows in
            VStack(alignment: .leading, spacing: 0) {
                ForEach(rows) { row in
                    if row.id != rows.first?.id { DeviceRowDivider() }
                    row.frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
    }
}

struct DeviceRowDivider: View {
    var body: some View { Divider().padding(.leading, 26) }
}

/// Muted text used for loading and empty lists, as on Web and Android.
struct DeviceEmptyText: View {
    let text: String
    var body: some View {
        Text(text).font(.subheadline).foregroundStyle(.secondary)
            .padding(.vertical, 14).frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Compact capsule button for section header actions ("Select", "Archive all").
struct DevicePillButton: View {
    let title: String
    var isLoading = false
    let action: () -> Void
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        Button(action: action) {
            Text(title).font(.footnote.weight(.semibold)).lineLimit(1)
                .opacity(isLoading ? 0 : 1)
                .overlay { if isLoading { ProgressView().controlSize(.mini) } }
                .padding(.horizontal, 12).frame(minHeight: 30)
                .background(AppTheme.sidebarSelectionFill(colorScheme), in: .capsule)
                .opacity(isEnabled ? 1 : 0.45)
                .contentShape(.capsule)
        }
        .buttonStyle(.plain)
    }
}

/// Single-select tags (Active / Archived / All). Selected tags are filled.
struct DeviceFilterTags<Value: Hashable & Identifiable>: View {
    let values: [Value]
    @Binding var selection: Value
    let title: (Value) -> String
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        HStack(spacing: 6) {
            ForEach(values) { value in
                let selected = value == selection
                Button { selection = value } label: {
                    Text(title(value))
                        .font(.subheadline.weight(selected ? .semibold : .regular))
                        .foregroundStyle(selected ? .primary : .secondary)
                        .padding(.horizontal, 14).frame(minHeight: 34)
                        .background(selected ? AppTheme.sidebarSelectionFill(colorScheme) : .clear, in: .capsule)
                        .contentShape(.capsule)
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(selected ? .isSelected : [])
            }
        }
    }
}

enum DeviceStatusTone {
    case ok, progress, warning, error, neutral

    var color: Color {
        switch self {
        case .ok: .green
        case .progress: .blue
        case .warning: .orange
        case .error: .red
        case .neutral: .secondary.opacity(0.4)
        }
    }
}

struct DeviceStatusDot: View {
    let tone: DeviceStatusTone
    var isLoading = false

    var body: some View {
        ZStack {
            if isLoading { ProgressView().controlSize(.mini) }
            else { Circle().fill(tone.color).frame(width: 8, height: 8) }
        }
        .frame(width: 14, height: 14)
        .accessibilityHidden(true)
    }
}
