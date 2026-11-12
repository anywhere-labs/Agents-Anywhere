import SwiftUI

/// A runtime-channel change that needs the user's confirmation first: the
/// runtime keeps its connection in its own global settings.
struct PendingChannelOverride: Identifiable, Hashable {
    let row: ChannelRuntimeRow
    let channel: String?

    var id: String { row.id }
}

/// The runtimes that should use one channel, by device, with how far each got.
/// Each row ends in the channel it is on the way to; tapping it chooses
/// another, or goes back to following the applied one.
struct ChannelRuntimeSections: View {
    let model: ModelConfigModel
    let channelId: String
    /// Off under a tab that already says 「Runtime」.
    var showsTitle = true
    @Binding var confirmingOverride: PendingChannelOverride?

    var body: some View {
        let rows = model.channelRows(channelId)
        let progress = ChannelPresentation.progress(rows)
        let groups = model.channelGroups(for: channelId)
        Section {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Text(verbatim: statusText(empty: rows.isEmpty, progress))
                    .font(.subheadline)
                    .foregroundStyle(progress.phase == .attention ? AnyShapeStyle(.orange) : AnyShapeStyle(.secondary))
                    .frame(maxWidth: .infinity, alignment: .leading)
                if progress.phase == .attention {
                    Button {
                        Task { await model.retryChannel() }
                    } label: {
                        if model.channelBusyKey == ModelConfigModel.globalChannelKey { ProgressView().controlSize(.small) }
                        else { Label(String(localized: "Retry"), appSymbol: "arrow.clockwise") }
                    }
                    .buttonStyle(.borderless)
                    .disabled(model.channelBusyKey != nil || !model.canWrite)
                }
            }
            if progress.phase == .running {
                ProgressView(value: Double(progress.applied), total: Double(max(progress.total, 1)))
            }
        } header: {
            if showsTitle { Text(String(localized: "pages.settings.modelConfigs.runtimes.title")) }
        }
        ForEach(groups.devices) { group in
            Section {
                ForEach(group.rows) { row in runtimeRow(row, showsDevice: false) }
            } header: {
                HStack(spacing: 6) {
                    Circle()
                        .fill(group.online == true ? AnyShapeStyle(.green) : AnyShapeStyle(Color.secondary.opacity(0.5)))
                        .frame(width: 7, height: 7)
                    Text(verbatim: group.name)
                }
                .accessibilityElement(children: .combine)
                .accessibilityValue(group.online.map {
                    Text($0 ? String(localized: "pages.settings.modelConfigs.details.online") : String(localized: "pages.settings.modelConfigs.details.offline"))
                } ?? Text(verbatim: ""))
            }
        }
        if !groups.unsupported.isEmpty {
            Section {
                ForEach(groups.unsupported) { row in runtimeRow(row, showsDevice: true) }
            } header: {
                Text(String(localized: "\(groups.unsupported.count) runtimes not supported"))
            }
        }
    }

    private func statusText(empty: Bool, _ progress: ChannelProgress) -> String {
        if empty { return String(localized: "pages.settings.modelConfigs.status.none") }
        let headline = switch progress.phase {
        case .none: String(localized: "\(progress.unsupported) runtimes not supported")
        case .done: String(localized: "In effect on \(progress.total) runtimes")
        case .running: String(localized: "Switching \(progress.applied)/\(progress.total) runtimes")
        case .attention: String(localized: "\(progress.applied)/\(progress.total) in effect")
        }
        let waiting = progress.offlineDevices > 0
            ? String(localized: "\(progress.offlineDevices) devices offline, switch when back online") : nil
        let notes: [String?] = switch progress.phase {
        case .attention: [
            progress.restored > 0 ? String(localized: "\(progress.restored) failed and went back to the previous channel") : nil,
            progress.failed > 0 ? String(localized: "\(progress.failed) need attention") : nil,
            waiting,
        ]
        case .running: [waiting]
        default: []
        }
        return ([headline] + notes.compactMap { $0 }).joined(separator: " · ")
    }

    /// State, why it failed, what it uses meanwhile, and the runtime's own words when there is no hover to show them.
    private func statusLine(_ row: ChannelRuntimeRow) -> String {
        let entry = row.entry
        return [
            ChannelPresentation.stateLabel(entry),
            ChannelPresentation.reasonText(entry),
            entry.state != "applied" ? String(localized: "Using \(model.channelLabel(entry.actual))") : nil,
            row.canRetry ? entry.message : nil,
        ].compactMap { $0 }.joined(separator: " · ")
    }

    private func runtimeRow(_ row: ChannelRuntimeRow, showsDevice: Bool) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 10) {
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 6) {
                        Text(verbatim: showsDevice ? "\(row.runtimeName) · \(row.deviceName)" : row.runtimeName)
                            .font(.body.weight(.medium)).lineLimit(1)
                        RuntimeMaturityBadge(maturity: row.maturity)
                    }
                    HStack(alignment: .firstTextBaseline, spacing: 5) {
                        // A runtime waiting for its device to come online is not being worked on.
                        if ["pending", "switching", "restoring"].contains(row.entry.state) { ProgressView().controlSize(.mini) }
                        Text(verbatim: statusLine(row))
                            .font(.footnote)
                            .foregroundStyle(row.canRetry ? AnyShapeStyle(.orange) : AnyShapeStyle(.secondary))
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                Spacer(minLength: 0)
                channelChoice(row)
            }
            if row.canRetry {
                Button {
                    Task { await model.retryChannel(row) }
                } label: {
                    Label(String(localized: "Retry"), appSymbol: "arrow.clockwise")
                }
                .buttonStyle(.bordered).controlSize(.small)
                .disabled(model.channelBusyKey != nil || !model.canWrite)
            }
        }
        .padding(.vertical, 2)
    }

    @ViewBuilder private func channelChoice(_ row: ChannelRuntimeRow) -> some View {
        let label = HStack(spacing: 3) {
            if model.channelBusyKey == row.id { ProgressView().controlSize(.mini) }
            Text(verbatim: model.channelLabel(row.entry.desired)).lineLimit(1)
            if !row.isUnsupported { AppSymbol("chevron.down", size: 11) }
        }
        .font(.subheadline)
        .foregroundStyle(.secondary)
        if row.isUnsupported {
            label
        } else {
            Menu {
                Picker(String(localized: "Channel for \(row.runtimeName)"), selection: Binding<String?>(
                    get: { row.entry.override },
                    set: { choose(row, $0) })) {
                    Text(String(localized: "pages.settings.modelConfigs.details.follow")).tag(String?.none)
                    ForEach(model.channelOptions) { option in
                        Text(verbatim: option.label).tag(String?.some(option.id))
                    }
                }
                .pickerStyle(.inline)
            } label: {
                label.frame(minHeight: 44).contentShape(.rect)
            }
            .buttonStyle(.plain)
            .disabled(model.channelBusyKey != nil || !model.canWrite)
            .accessibilityLabel(Text(String(localized: "Channel for \(row.runtimeName)")))
        }
    }

    private func choose(_ row: ChannelRuntimeRow, _ channel: String?) {
        guard channel != row.entry.override else { return }
        if row.needsGlobalConfirmation(for: channel) {
            confirmingOverride = PendingChannelOverride(row: row, channel: channel)
        } else {
            Task { await model.setRuntimeChannel(row, channel: channel) }
        }
    }
}
