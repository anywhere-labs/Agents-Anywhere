import SwiftUI

/// Compact-width "more" tab: account card, per-device entries and settings.
/// Settings and sign-out reuse AccountSettingsSheet, pairing reuses
/// PairDeviceSheet, so behavior matches the regular sidebar.
struct CompactMoreView: View {
    let appState: AppState
    let onOpenDevice: (V2ConnectorID) -> Void

    @State private var isShowingSettings = false
    @State private var isShowingPairing = false

    private var devices: [ChatSidebarDevice] {
        appState.connectors.map { ChatSidebarDevice(connector: $0) }
    }

    private var isLoadingDevices: Bool {
        appState.isDashboardLoading && !appState.hasLoadedConnectors
    }

    var body: some View {
        List {
            Section {
                Button {
                    isShowingSettings = true
                } label: {
                    HStack(spacing: 12) {
                        AccountAvatarView(displayName: displayName,
                            source: appState.accountAvatarSource, size: 44)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(displayName)
                                .font(.body.weight(.semibold))
                                .foregroundStyle(.primary)
                            if let host = appState.serverURL?.host {
                                Text(verbatim: host)
                                    .font(.footnote).foregroundStyle(.secondary)
                            }
                        }
                        Spacer(minLength: 0)
                        AppSymbol("chevron.right")
                            .foregroundStyle(.tertiary)
                    }
                    .padding(.vertical, 4)
                }
                .accessibilityLabel(String(localized: "Account"))
            }

            Section(String(localized: "设备")) {
                if isLoadingDevices {
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.small)
                        Text(String(localized: "Loading devices..."))
                            .font(.caption).foregroundStyle(.secondary)
                    }
                } else if devices.isEmpty {
                    Text(String(localized: "No devices"))
                        .font(.caption).foregroundStyle(.secondary)
                } else {
                    ForEach(devices) { device in
                        Button {
                            onOpenDevice(device.id)
                        } label: {
                            HStack(spacing: 10) {
                                Circle()
                                    .fill(device.presence == .online ? .green : .secondary.opacity(0.45))
                                    .frame(width: 7, height: 7)
                                Text(device.name)
                                    .font(.system(.body, design: .monospaced))
                                    .foregroundStyle(device.presence == .offline ? .secondary : .primary)
                                    .lineLimit(1)
                                Spacer(minLength: 0)
                                AppSymbol("chevron.right")
                                    .foregroundStyle(.tertiary)
                            }
                            .padding(.vertical, 2)
                        }
                        .contextMenu {
                            Button {
                                UIPasteboard.general.string = device.id
                            } label: {
                                Label(String(localized: "Copy device ID"), systemImage: "doc.on.doc")
                            }
                        }
                    }
                }
                Button {
                    appState.nativeChatServices?.agentSetup.pairingFormPresented = true
                    isShowingPairing = true
                } label: {
                    Label(String(localized: "Pair device"), systemImage: "plus")
                }
            }

            Section {
                Button {
                    isShowingSettings = true
                } label: {
                    Label(String(localized: "设置与账号"), systemImage: "gearshape")
                }
            }
        }
        .listStyle(.insetGrouped)
        .scrollEdgeEffectStyle(.soft, for: .bottom)
        .refreshable { await appState.refreshDashboard() }
        .sheet(isPresented: $isShowingSettings) {
            AccountSettingsSheet(appState: appState)
        }
        .sheet(isPresented: $isShowingPairing, onDismiss: {
            appState.nativeChatServices?.agentSetup.pairingFormPresented = false
        }) {
            PairDeviceSheet()
        }
    }
    /// The more tab renders before `me` loads; a neutral label keeps the
    /// layout stable instead of dropping the account section.
    private var displayName: String {
        appState.me?.accountLabel ?? String(localized: "Account")
    }
}
