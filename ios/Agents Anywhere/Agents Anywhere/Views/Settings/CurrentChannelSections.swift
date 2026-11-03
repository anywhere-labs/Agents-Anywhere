import SwiftUI

/// A runtime-channel change that needs the user's confirmation first: the
/// runtime keeps its connection in its own global settings.
struct PendingChannelOverride: Identifiable, Hashable {
    let row: ChannelRuntimeRow
    let channel: String?

    var id: String { row.id }
}

/// 「当前渠道」: the channel every runtime follows, how far the switch got, and
/// each device's runtimes with their own state and actions. Rows render from
/// the channel state and declared capabilities only.
struct CurrentChannelSections: View {
    let model: ModelConfigModel
    let state: V2ModelChannelState
    @Binding var confirmingOverride: PendingChannelOverride?

    var body: some View {
        let groups = model.channelGroups
        Section {
            Picker(String(localized: "Current channel"), selection: Binding(
                get: { state.channel },
                set: { channel in Task { await model.setChannel(channel) } })) {
                ForEach(model.channelOptions) { option in
                    Text(verbatim: option.label).tag(option.id)
                }
            }
            .pickerStyle(.menu)
            .disabled(model.channelBusyKey != nil || !model.canWrite)
            if let summary = model.channelSummary { statusRow(summary) }
        } header: {
            Text(String(localized: "Current channel"))
        } footer: {
            Text(String(localized: "Each runtime uses one channel at a time. Runtimes follow the current channel unless you choose one for them; runtimes with running tasks switch once the tasks end."))
        }
        if groups.devices.isEmpty && groups.unsupported.isEmpty {
            Section {
                Text(String(localized: "No runtimes on your devices yet.")).font(.subheadline).foregroundStyle(.secondary)
            }
        }
        ForEach(groups.devices) { group in
            Section {
                ForEach(group.rows) { row in runtimeRow(row) }
            } header: {
                Text(verbatim: group.name)
            }
        }
        if !groups.unsupported.isEmpty {
            Section {
                DisclosureGroup(String(localized: "Not supported (\(groups.unsupported.count))")) {
                    ForEach(groups.unsupported) { row in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(verbatim: row.runtimeName)
                            Text(verbatim: [row.deviceName, ChannelPresentation.reasonText(row.entry)].compactMap { $0 }.joined(separator: " · "))
                                .font(.footnote).foregroundStyle(.secondary)
                        }
                    }
                }
            } footer: {
                Text(String(localized: "These runtimes take no model connection and keep their own configuration."))
            }
        }
    }

    // MARK: Switch status

    @ViewBuilder private func statusRow(_ summary: ChannelSummary) -> some View {
        switch summary.phase {
        case .running:
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                ProgressView().controlSize(.small)
                VStack(alignment: .leading, spacing: 2) {
                    Text(String(localized: "Switching \(summary.finished)/\(summary.total) runtimes"))
                    if let waiting = waitingText(summary) {
                        Text(waiting).font(.footnote).foregroundStyle(.secondary)
                    }
                }
            }
        case .done:
            Label {
                Text(String(localized: "In effect on \(summary.applied) runtimes"))
            } icon: {
                AppSymbol("checkmark.circle", size: 16).foregroundStyle(.green)
            }
        case .attention:
            HStack(spacing: 10) {
                AppSymbol("exclamationmark.triangle", size: 16).foregroundStyle(.orange)
                VStack(alignment: .leading, spacing: 2) {
                    if summary.restored > 0 {
                        Text(String(localized: "\(summary.restored) failed to switch and went back to their previous channel"))
                    }
                    if summary.failed > 0 {
                        Text(String(localized: "\(summary.failed) need attention")).foregroundStyle(.red)
                    }
                    if let waiting = waitingText(summary) {
                        Text(waiting).font(.footnote).foregroundStyle(.secondary)
                    }
                }
                Spacer(minLength: 8)
                Button {
                    Task { await model.retryChannel() }
                } label: {
                    if model.channelBusyKey == ModelConfigModel.globalChannelKey { ProgressView().controlSize(.small) }
                    else { Label(String(localized: "Retry"), appSymbol: "arrow.clockwise") }
                }
                .buttonStyle(.borderless)
                .disabled(model.channelBusyKey != nil || !model.canWrite)
            }
        case .idle:
            EmptyView()
        }
    }

    private func waitingText(_ summary: ChannelSummary) -> String? {
        let parts = [
            summary.waitingOnline > 0 ? String(localized: "\(summary.waitingOnline) waiting for the device to come online") : nil,
        ].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    // MARK: Runtimes

    private func runtimeRow(_ row: ChannelRuntimeRow) -> some View {
        let entry = row.entry
        let busy = model.channelBusyKey == row.id
        return HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Text(verbatim: row.runtimeName).font(.body.weight(.semibold)).lineLimit(1)
                    RuntimeMaturityBadge(maturity: row.maturity)
                    if entry.override != nil {
                        ModelStatusBadge(title: String(localized: "Chosen separately"), tone: .neutral)
                    }
                }
                Text(verbatim: channelLine(entry)).font(.footnote).foregroundStyle(.secondary).lineLimit(2)
                HStack(spacing: 6) {
                    if entry.state == "switching" || entry.state == "restoring" { ProgressView().controlSize(.mini) }
                    ModelStatusBadge(title: ChannelPresentation.stateLabel(entry), tone: ChannelPresentation.tone(entry.state))
                }
                if let reason = ChannelPresentation.reasonText(entry) {
                    Text(reason).font(.footnote).foregroundStyle(.secondary).lineLimit(3)
                }
            }
            Spacer(minLength: 0)
            if busy { ProgressView() }
            Menu {
                actions(row)
            } label: {
                AppSymbol("ellipsis", size: 18).foregroundStyle(.secondary)
                    .frame(width: 36, height: 44).contentShape(.rect)
            }
            .buttonStyle(.plain)
            .disabled(model.channelBusyKey != nil || !model.canWrite)
            .accessibilityLabel(Text(verbatim: row.runtimeName))
        }
        .padding(.vertical, 2)
        .swipeActions(edge: .trailing) {
            if row.canRetry {
                Button(String(localized: "Retry")) { Task { await model.retryChannel(row) } }.tint(.accentColor)
            }
        }
    }

    @ViewBuilder private func actions(_ row: ChannelRuntimeRow) -> some View {
        if row.canRetry {
            Button(String(localized: "Retry"), systemImage: "arrow.clockwise") { Task { await model.retryChannel(row) } }
        }
        Section(String(localized: "Channel for this runtime")) {
            Picker(String(localized: "Channel for this runtime"), selection: Binding<String?>(
                get: { row.entry.override },
                set: { choose(row, $0) })) {
                Text(String(localized: "Follow the current channel (\(model.channelLabel(state.channel)))")).tag(String?.none)
                ForEach(model.channelOptions) { option in
                    Text(verbatim: option.label).tag(String?.some(option.id))
                }
            }
            .pickerStyle(.inline)
        }
    }

    /// The channel it uses, and the one it is switching to when they differ.
    private func channelLine(_ entry: V2ChannelRuntime) -> String {
        let actual = model.channelLabel(entry.actual)
        guard entry.desired != entry.actual, entry.state != "unsupported" else { return actual }
        return "\(actual) → \(model.channelLabel(entry.desired))"
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
