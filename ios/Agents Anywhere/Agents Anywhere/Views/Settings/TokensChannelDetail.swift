import SwiftUI

/// The Tokens Anywhere channel: link an account first; once linked, its
/// account, models and connection, and the runtimes using it.
struct TokensChannelDetail<Apply: View, Runtimes: View>: View {
    let model: ModelConfigModel
    let tokens: V2TokensLinkStatus
    let linker: TokensLinkCoordinator
    let onExit: () -> Void
    let onRotate: (V2ModelProfile) -> Void
    @ViewBuilder let apply: () -> Apply
    @ViewBuilder let runtimes: (_ showsTitle: Bool) -> Runtimes

    private var linked: Bool { tokens.link?.isLinked == true && model.exitedLink != tokens.link }

    var body: some View {
        if linked {
            TokensAccountSections(model: model, tokens: tokens, onRotate: onRotate) {
                apply()
                if tokens.link?.relinkSoon == true {
                    Text(String(localized: "pages.settings.modelConfigs.relinkSoon")).font(.footnote).foregroundStyle(.orange)
                }
                if model.exitBusy {
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.small)
                        Text(String(localized: "pages.settings.modelConfigs.signingOut")).font(.footnote).foregroundStyle(.secondary)
                    }
                } else {
                    if model.exitPhase == .failed {
                        Text(String(localized: "Sign out failed. Retry Sign out to continue.")).font(.footnote).foregroundStyle(.red)
                    }
                    Button(role: .destructive, action: onExit) {
                        Label(String(localized: "pages.settings.modelConfigs.signOut"), appSymbol: "arrow.up.right.square")
                    }
                    .disabled(model.tokensBusy != nil || !model.canWrite)
                }
            } runtimes: {
                runtimes(false)
            }
        } else {
            let lapsed = tokens.link != nil && model.exitedLink != tokens.link
            Section {
                if lapsed {
                    Text(String(localized: "pages.settings.modelConfigs.tokensReauth"))
                        .font(.footnote).foregroundStyle(.orange)
                }
                Button {
                    link()
                } label: {
                    HStack(spacing: 8) {
                        if model.tokensBusy == .link || linker.isActive { ProgressView().controlSize(.small) }
                        Text(lapsed ? String(localized: "pages.settings.modelConfigs.relink") : String(localized: "pages.settings.modelConfigs.channel.link"))
                    }
                }
                .disabled(model.tokensBusy != nil || linker.isActive || !model.canWrite || !tokens.secretConfigured)
            } footer: {
                Text(String(localized: "pages.settings.modelConfigs.channel.description"))
            }
            // A lapsed link keeps the runtimes that still use it.
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
