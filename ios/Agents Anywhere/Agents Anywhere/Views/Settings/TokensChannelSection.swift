import SwiftUI

/// The Anywhere channel: link the Tokens Anywhere account, make it the current
/// channel, and manage the linked account.
struct TokensChannelSection: View {
    let model: ModelConfigModel
    let tokens: V2TokensLinkStatus
    let linker: TokensLinkCoordinator

    private var linked: Bool { tokens.link?.isLinked == true }
    private var current: Bool { model.isCurrentChannel(V2ModelChannel.tokens) }

    var body: some View {
        if linked {
            TokensAccountSections(model: model, tokens: tokens) {
                devices
            } unlink: {
                if !current {
                    Button {
                        Task { await model.setChannel(V2ModelChannel.tokens) }
                    } label: {
                        Label(String(localized: "Set as current channel"), appSymbol: "checkmark.circle")
                    }
                    .disabled(model.channelBusyKey != nil || !model.canWrite)
                }
                Button(String(localized: "pages.settings.modelConfigs.switchAccount")) { link() }
                    .disabled(model.tokensBusy != nil || !model.canWrite)
            }
        } else {
            Section {
                if tokens.link?.status == "reauth_required" {
                    Text(String(localized: "The authorization expired. Link again."))
                        .font(.footnote).foregroundStyle(.orange)
                }
                Button {
                    link()
                } label: {
                    HStack(spacing: 8) {
                        if model.tokensBusy == .link || linker.isActive { ProgressView().controlSize(.small) }
                        Text(String(localized: "pages.settings.modelConfigs.channel.link"))
                    }
                }
                .disabled(model.tokensBusy != nil || linker.isActive || !model.canWrite || !tokens.secretConfigured)
            } header: {
                Text(String(localized: "pages.settings.modelConfigs.channel.title"))
            } footer: {
                Text(String(localized: "Link your Tokens Anywhere account to use its models as a channel."))
            }
        }
    }

    /// The account page's Devices tab: runtimes that want or use Anywhere.
    @ViewBuilder private var devices: some View {
        Section {
            let rows = model.tokensRuntimes
            if rows.isEmpty {
                Text(String(localized: "No runtimes use Anywhere yet."))
                    .font(.subheadline).foregroundStyle(.secondary)
            }
            ForEach(rows) { row in
                VStack(alignment: .leading, spacing: 2) {
                    Text(verbatim: "\(row.deviceName) · \(row.runtimeName)")
                    HStack(spacing: 6) {
                        ModelStatusBadge(title: ChannelPresentation.stateLabel(row.entry), tone: ChannelPresentation.tone(row.entry.state))
                        if let reason = ChannelPresentation.reasonText(row.entry) {
                            Text(reason).font(.footnote).foregroundStyle(.secondary).lineLimit(2)
                        }
                    }
                }
            }
        } footer: {
            Text(current
                ? String(localized: "Anywhere is the current channel. Runtimes that follow it switch automatically.")
                : String(localized: "Set Anywhere as the current channel, or choose it for single runtimes under Current channel."))
        }
    }

    private func link() {
        let current = tokens.link
        Task {
            guard let url = await model.beginTokensLink() else { return }
            _ = linker.start(url: url, current: current) {}
        }
    }
}
