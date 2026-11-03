import Charts
import SwiftUI

/// The linked Tokens Anywhere account: who it is, its balance, which of its
/// models runtimes get and under which names, what it has spent, and the
/// runtimes using it. Ported from the Web account page.
struct TokensAccountSections<Devices: View, Unlink: View>: View {
    let model: ModelConfigModel
    let tokens: V2TokensLinkStatus
    @ViewBuilder let devices: () -> Devices
    @ViewBuilder let unlink: () -> Unlink
    @Environment(\.openURL) private var openURL

    private var account: TokensAccountModel { model.account }

    var body: some View {
        accountSection
        Section {
            Picker(String(localized: "Anywhere account"), selection: Binding(
                get: { account.tab ?? .models },
                set: { account.tab = $0 })) {
                Text(String(localized: "pages.settings.modelConfigs.account.tabModels")).tag(TokensAccountTab.models)
                Text(String(localized: "pages.settings.modelConfigs.account.tabUsage")).tag(TokensAccountTab.usage)
                Text(String(localized: "pages.settings.modelConfigs.account.tabDevices")).tag(TokensAccountTab.devices)
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .listRowInsets(EdgeInsets())
            .listRowBackground(Color.clear)
        }
        switch account.tab ?? .models {
        case .models: TokensModelsTab(model: model)
        case .usage: TokensUsageTab(account: account)
        case .devices: devices()
        }
    }

    // MARK: Account and balance

    private var accountSection: some View {
        let info = account.info
        let person = info?.account ?? tokens.link?.account
        let name = person.map { $0.displayName ?? $0.email ?? $0.id } ?? ""
        return Section {
            HStack(spacing: 12) {
                Text(verbatim: name.first.map { String($0).uppercased() } ?? "?")
                    .font(.subheadline.weight(.medium))
                    .frame(width: 40, height: 40)
                    .background(.quaternary, in: Circle())
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(verbatim: name).font(.body.weight(.medium)).lineLimit(1).truncationMode(.middle)
                    if let email = person?.email, email != name {
                        Text(verbatim: email).font(.footnote).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                    }
                    if let info {
                        Button {
                            open(info.links.console)
                        } label: {
                            HStack(spacing: 3) {
                                Text(String(localized: "More account details"))
                                AppSymbol("arrow.up.right.square", size: 12)
                            }
                            .font(.footnote)
                        }
                        .buttonStyle(.borderless)
                    }
                }
                Spacer(minLength: 0)
            }
            balanceRow(info)
            unlink()
        } header: {
            HStack(spacing: 6) {
                Text(String(localized: "Anywhere account"))
                RuntimeMaturityBadge(maturity: V2RuntimeMaturity.beta.rawValue)
            }
        } footer: {
            if model.tokensSwitching {
                HStack(spacing: 6) {
                    ProgressView().controlSize(.mini)
                    Text(String(localized: "Applying changes to runtimes…"))
                }
            }
        }
    }

    private func balanceRow(_ info: V2TokensAccountInfo?) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text(String(localized: "pages.settings.modelConfigs.account.balance")).font(.footnote).foregroundStyle(.secondary)
                if let info {
                    Text(verbatim: TokensAccountPresentation.formatYuan(TokensAccountPresentation.amountUnits(info.balance.balance)))
                        .font(.title2.weight(.semibold)).monospacedDigit()
                    Text(String(localized: "Available \(TokensAccountPresentation.formatYuan(TokensAccountPresentation.amountUnits(info.balance.available))) · Bonus \(TokensAccountPresentation.formatYuan(TokensAccountPresentation.amountUnits(info.balance.bonus)))"))
                        .font(.footnote).foregroundStyle(.secondary).monospacedDigit()
                } else if account.infoFailed {
                    HStack {
                        Text(String(localized: "Couldn't read the Tokens Anywhere account right now."))
                            .font(.subheadline).foregroundStyle(.secondary)
                        Spacer(minLength: 8)
                        Button {
                            Task { await account.loadInfo() }
                        } label: {
                            Label(String(localized: "Retry"), appSymbol: "arrow.clockwise")
                        }
                        .buttonStyle(.borderless)
                    }
                } else {
                    ProgressView().padding(.vertical, 6)
                }
            }
            HStack(spacing: 10) {
                Button(String(localized: "View usage")) { account.tab = .usage }
                    .buttonStyle(.bordered)
                Button {
                    if let info { open(info.links.billing) }
                } label: {
                    HStack(spacing: 4) {
                        Text(String(localized: "Top up"))
                        AppSymbol("arrow.up.right.square", size: 14)
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(info == nil)
            }
            .controlSize(.small)
        }
        .padding(.vertical, 2)
    }

    private func open(_ address: String) {
        guard let url = URL(string: address), ["http", "https"].contains(url.scheme?.lowercased() ?? "") else { return }
        openURL(url)
    }
}

// MARK: - Models

private struct TokensModelsTab: View {
    let model: ModelConfigModel

    private var account: TokensAccountModel { model.account }
    private var locked: Bool { account.isSaving || !model.canWrite }

    var body: some View {
        if account.models.isEmpty {
            Section {
                HStack {
                    Text(String(localized: "No models synced yet. Click Refresh to read them."))
                        .font(.subheadline).foregroundStyle(.secondary)
                    Spacer(minLength: 8)
                    refreshButton
                }
            }
        } else {
            Section {
                VStack(alignment: .leading, spacing: 10) {
                    Text(String(localized: "Set up by Tokens Anywhere: \(account.models.count) models, \(account.enabledCount) turned on."))
                        .font(.subheadline)
                    HStack(spacing: 16) {
                        Button {
                            Task { await account.restoreDefaults() }
                        } label: {
                            Label(String(localized: "Restore defaults"), appSymbol: "arrow.counterclockwise")
                        }
                        .disabled(locked || account.isDefault)
                        refreshButton
                    }
                    .buttonStyle(.borderless).font(.subheadline)
                }
            } footer: {
                Text(String(localized: "Turning models off or renaming them only affects Agents Anywhere, and applies to every runtime using Tokens Anywhere."))
            }
            Section {
                ForEach(account.groups) { group in
                    groupRow(group)
                    if account.expandedGroups.contains(group.key) {
                        ForEach(group.models) { item in TokensModelRow(account: account, item: item) }
                    }
                }
            }
        }
    }

    private var refreshButton: some View {
        Button {
            Task { await model.syncTokens() }
        } label: {
            HStack(spacing: 6) {
                if model.tokensBusy == .sync { ProgressView().controlSize(.small) }
                else { AppSymbol("arrow.clockwise", size: 16) }
                Text(String(localized: "pages.settings.modelConfigs.account.refresh"))
            }
        }
        .buttonStyle(.borderless)
        .disabled(model.tokensBusy != nil || !model.canWrite)
    }

    private func groupRow(_ group: TokensVendorGroup) -> some View {
        let label = group.label ?? String(localized: "pages.settings.modelConfigs.account.otherVendor")
        let on = group.models.filter { account.isEnabled($0.id) }.count
        let open = account.expandedGroups.contains(group.key)
        return HStack(spacing: 8) {
            Button {
                withAnimation(.snappy) { account.setGroup(group.key, open: !open) }
            } label: {
                HStack(spacing: 8) {
                    AppSymbol(open ? "chevron.down" : "chevron.right", size: 14).foregroundStyle(.secondary)
                    Text(verbatim: label).font(.body.weight(.medium)).lineLimit(1)
                    Text(verbatim: "\(on)/\(group.models.count)").font(.footnote).foregroundStyle(.secondary).monospacedDigit()
                    Spacer(minLength: 0)
                }
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityAddTraits(.isHeader)
            Toggle(isOn: Binding(get: { on == group.models.count }, set: { account.setEnabled(group.models.map(\.id), $0) })) {
                Text(String(localized: "Turn on all \(label) models"))
            }
            .labelsHidden().tint(.green)
            .disabled(account.isSaving)
        }
    }
}

private struct TokensModelRow: View {
    let account: TokensAccountModel
    let item: TokensModel
    @State private var renaming = false
    @State private var text = ""

    var body: some View {
        let name = account.draft.names[item.id]
        let shown = name ?? item.originalName
        let enabled = account.isEnabled(item.id)
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 4) {
                    Text(verbatim: shown).font(.subheadline).lineLimit(1).truncationMode(.middle)
                    Button {
                        text = name ?? item.originalName
                        renaming = true
                    } label: {
                        AppSymbol("pencil", size: 14).foregroundStyle(.secondary).frame(width: 28, height: 28).contentShape(.rect)
                    }
                    .buttonStyle(.borderless)
                    .accessibilityLabel(String(localized: "pages.settings.modelConfigs.account.rename"))
                }
                let meta = details(shown: shown)
                if !meta.isEmpty {
                    Text(verbatim: meta).font(.caption).foregroundStyle(.secondary)
                }
                // The ID is already in the line above when the original name is the ID.
                if name != nil && item.originalName != item.id {
                    Text(String(localized: "Originally \(item.originalName)")).font(.caption).foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 0)
            Toggle(isOn: Binding(get: { enabled }, set: { account.setEnabled([item.id], $0) })) {
                Text(String(localized: "Turn on \(shown)"))
            }
            .labelsHidden().tint(.green)
            .disabled(account.isSaving)
        }
        .padding(.leading, 22)
        .foregroundStyle(enabled ? AnyShapeStyle(.primary) : AnyShapeStyle(.secondary))
        .alert(String(localized: "pages.settings.modelConfigs.account.rename"), isPresented: $renaming) {
            TextField(String(localized: "Leave empty for the original name"), text: $text)
                .textInputAutocapitalization(.never).autocorrectionDisabled()
            Button(String(localized: "Cancel"), role: .cancel) {}
            Button(String(localized: "Save")) { account.rename(item, to: text) }
        } message: {
            Text(verbatim: item.id)
        }
    }

    private func details(shown: String) -> String {
        [
            item.id != shown ? item.id : nil,
            item.contextWindow.map { String(localized: "\(TokensAccountPresentation.formatTokenWindow($0)) context") },
            item.maxOutputTokens.map { String(localized: "\(TokensAccountPresentation.formatTokenWindow($0)) output") },
            item.image ? String(localized: "pages.settings.modelConfigs.account.image") : nil,
        ].compactMap { $0 }.joined(separator: " · ")
    }
}

/// Unsaved model choices, kept above the bottom edge while the list scrolls.
struct TokensPendingBar: View {
    let model: ModelConfigModel

    private var account: TokensAccountModel { model.account }

    var body: some View {
        let none = account.enabledCount == 0
        HStack(spacing: 12) {
            Text(none ? String(localized: "Keep at least one model.") : String(localized: "\(account.changes) unsaved changes"))
                .font(.subheadline)
                .foregroundStyle(none ? AnyShapeStyle(.red) : AnyShapeStyle(.primary))
                .frame(maxWidth: .infinity, alignment: .leading)
            Button(String(localized: "pages.settings.modelConfigs.account.discard")) { account.discard() }
                .buttonStyle(.borderless)
                .disabled(account.isSaving)
            Button {
                Task { await account.saveDraft() }
            } label: {
                HStack(spacing: 6) {
                    if account.isSaving { ProgressView().controlSize(.small) }
                    Text(String(localized: "Save and apply"))
                }
            }
            .buttonStyle(.borderedProminent)
            .disabled(account.isSaving || none || !model.canWrite)
        }
        .controlSize(.small)
        .padding(.horizontal, 16).padding(.vertical, 10)
        .background(.regularMaterial, in: .rect(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(.separator, lineWidth: 0.5))
        .padding(.horizontal, 16).padding(.bottom, 8)
    }
}

// MARK: - Usage

private struct TokensUsageTab: View {
    let account: TokensAccountModel
    @Environment(\.openURL) private var openURL

    var body: some View {
        Section {
            Picker(String(localized: "Last 7 days"), selection: Binding(get: { account.usageDays }, set: { account.usageDays = $0 })) {
                Text(String(localized: "Last 7 days")).tag(7)
                Text(String(localized: "Last 30 days")).tag(30)
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            Picker(String(localized: "pages.settings.modelConfigs.account.model"), selection: Binding(
                get: { account.usageModel }, set: { account.usageModel = $0 })) {
                Text(String(localized: "All models")).tag(String?.none)
                ForEach(account.usageModelIDs, id: \.self) { id in Text(verbatim: id).tag(Optional(id)) }
            }
            .pickerStyle(.menu)
        }
        Section {
            if account.usageFailed {
                HStack {
                    Text(String(localized: "Couldn't read usage right now.")).font(.subheadline).foregroundStyle(.secondary)
                    Spacer(minLength: 8)
                    Button {
                        Task { await account.loadUsage() }
                    } label: {
                        Label(String(localized: "Retry"), appSymbol: "arrow.clockwise")
                    }
                    .buttonStyle(.borderless)
                }
            } else if let summary = account.usageSummary {
                HStack(spacing: 8) {
                    stat(String(localized: "pages.settings.modelConfigs.account.cost"), TokensAccountPresentation.formatYuan(summary.cost))
                    stat(String(localized: "pages.settings.modelConfigs.account.requests"), summary.requests.formatted())
                    stat(String(localized: "pages.settings.modelConfigs.account.tokens"), Self.compact(summary.tokens))
                }
                VStack(alignment: .leading, spacing: 8) {
                    Text(String(localized: "Daily cost")).font(.footnote).foregroundStyle(.secondary)
                    if summary.cost == 0 {
                        Text(String(localized: "No usage in this period."))
                            .font(.subheadline).foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity, minHeight: 140)
                            .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(.separator, style: StrokeStyle(lineWidth: 1, dash: [4])))
                    } else {
                        chart(summary)
                    }
                }
                .padding(.vertical, 4)
                if !summary.models.isEmpty { modelTable(summary) }
            } else {
                HStack { Spacer(); ProgressView(); Spacer() }.padding(.vertical, 24)
            }
        } footer: {
            VStack(alignment: .leading, spacing: 6) {
                if let address = account.info?.links.usage, let url = URL(string: address),
                   ["http", "https"].contains(url.scheme?.lowercased() ?? "") {
                    Button {
                        openURL(url)
                    } label: {
                        HStack(spacing: 3) {
                            Text(String(localized: "See details in Tokens Anywhere"))
                            AppSymbol("arrow.up.right.square", size: 12)
                        }
                    }
                    .buttonStyle(.borderless).font(.footnote)
                }
            }
        }
    }

    private func stat(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).font(.caption).foregroundStyle(.secondary).lineLimit(1)
            Text(verbatim: value).font(.headline).monospacedDigit().lineLimit(1).minimumScaleFactor(0.6)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 10).padding(.vertical, 8)
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(.separator, lineWidth: 1))
        .accessibilityElement(children: .combine)
    }

    private func chart(_ summary: TokensUsageSummary) -> some View {
        let costLabel = String(localized: "pages.settings.modelConfigs.account.cost")
        let step = max(1, Int((Double(summary.daily.count) / 6).rounded(.up)))
        let ticks = summary.daily.enumerated().filter { $0.offset % step == 0 }.map(\.element.date)
        let dateLabel: String = String(localized: "Daily cost")
        return Chart(summary.daily) { day in
            BarMark(x: .value(dateLabel, day.date), y: .value(costLabel, Double(day.cost) / 10_000))
                .foregroundStyle(Color.accentColor)
                .clipShape(UnevenRoundedRectangle(topLeadingRadius: 3, topTrailingRadius: 3))
                .accessibilityLabel(Text(verbatim: day.date))
                .accessibilityValue(Text(verbatim: TokensAccountPresentation.formatYuan(day.cost)))
        }
        .chartXAxis {
            AxisMarks(values: ticks) { value in
                AxisValueLabel {
                    if let date = value.as(String.self) { Text(verbatim: TokensAccountPresentation.shortDate(date)) }
                }
            }
        }
        .chartYAxis {
            AxisMarks { value in
                AxisGridLine()
                AxisValueLabel {
                    if let yuan = value.as(Double.self) { Text(verbatim: "¥" + Self.compact(yuan)) }
                }
            }
        }
        .frame(height: 180)
    }

    private func modelTable(_ summary: TokensUsageSummary) -> some View {
        Grid(alignment: .leading, horizontalSpacing: 10, verticalSpacing: 8) {
            GridRow {
                Text(String(localized: "pages.settings.modelConfigs.account.model"))
                Text(String(localized: "pages.settings.modelConfigs.account.requests")).gridColumnAlignment(.trailing)
                Text(String(localized: "pages.settings.modelConfigs.account.tokens")).gridColumnAlignment(.trailing)
                Text(String(localized: "pages.settings.modelConfigs.account.cost")).gridColumnAlignment(.trailing)
            }
            .font(.caption).foregroundStyle(.secondary)
            Divider()
            ForEach(summary.models) { row in
                GridRow {
                    Text(verbatim: row.model.isEmpty ? String(localized: "Unknown model") : row.model)
                        .lineLimit(1).truncationMode(.middle)
                    Text(verbatim: row.requests.formatted())
                    Text(verbatim: Self.compact(row.tokens))
                    Text(verbatim: TokensAccountPresentation.formatYuan(row.cost))
                }
                .font(.footnote).monospacedDigit()
            }
        }
        .padding(.vertical, 4)
    }

    private static func compact(_ value: Int) -> String {
        if abs(value) < 1000 { return value.formatted() }
        return value.formatted(.number.notation(.compactName).precision(.fractionLength(0...1)))
    }

    private static func compact(_ value: Double) -> String {
        if abs(value) < 1000 { return value.formatted(.number.precision(.fractionLength(0...2))) }
        return value.formatted(.number.notation(.compactName).precision(.fractionLength(0...1)))
    }
}
