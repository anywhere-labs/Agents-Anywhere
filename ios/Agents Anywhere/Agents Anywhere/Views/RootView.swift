import SwiftUI

struct RootView: View {
    @EnvironmentObject private var appState: AppState
    @Environment(\.colorScheme) private var colorScheme
    @State private var showingManualLogin = false
    @State private var showingQRCodeLogin = false

    var body: some View {
        Group {
            switch appState.route {
            case .loading:
                Color(uiColor: .systemBackground)
            case .signedOut:
                ServiceEntryView(
                    onManualLogin: { showingManualLogin = true },
                    onQRCodeLogin: { showingQRCodeLogin = true },
                )
            case .signedIn:
                ChatShellView()
            }
        }
        .sheet(isPresented: $showingManualLogin) {
            ManualLoginView(appState: appState) {
                appState.activateSignedInRoute()
                showingManualLogin = false
            }
        }
        .sheet(isPresented: $showingQRCodeLogin) {
            QRCodeLoginView(appState: appState) {
                appState.activateSignedInRoute()
                showingQRCodeLogin = false
            }
        }
        .alert(
            String(localized: "发现新版本"),
            isPresented: Binding(
                get: { appState.appUpdateAvailable != nil },
                set: { if !$0 { appState.dismissAppUpdateOffer() } }
            )
        ) {
            if let offer = appState.appUpdateAvailable {
                Button(String(localized: "前往更新")) {
                    UIApplication.shared.open(offer.storeURL)
                }
            }
            Button(String(localized: "稍后再说"), role: .cancel, action: appState.dismissAppUpdateOffer)
        } message: {
            if let offer = appState.appUpdateAvailable {
                Text(String(
                    format: String(localized: "服务器运行版本 %@，比当前应用新。请在 App Store / TestFlight 更新后继续使用最新功能。", comment: "In-app update offer pointing to the store"),
                    offer.version
                ))
            }
        }
        .announcementGate(
            server: appState.serverURL,
            route: appState.route,
            blocked: showingManualLogin || showingQRCodeLogin
        )
        .overlay(alignment: .top) {
            if appState.route == .signedIn, let error = appState.restoreConnectionError {
                HStack(spacing: 12) {
                    AppSymbol("wifi.exclamationmark")
                    VStack(alignment: .leading, spacing: 2) {
                        Text(String(localized: "暂时无法连接，正在显示本地内容")).font(.footnote.weight(.medium))
                        Text(error).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                    }
                    Menu {
                        Button(String(localized: "立即重试"), action: retryServerConnection)
                        Button(String(localized: "返回登录"), action: appState.returnToLogin)
                    } label: { AppSymbol("ellipsis").frame(width: 36, height: 36) }
                }
                .padding(14).glassEffect(.regular, in: .rect(cornerRadius: 20))
                .padding(.horizontal, 22).padding(.top, 70).frame(maxWidth: 540)
            }
        }
        .tint(AppTheme.primaryText(colorScheme))
        .background(AppTheme.appBackground(colorScheme))
    }

    private func retryServerConnection() {
        Task {
            await appState.retryServerConnection()
        }
    }
}

#Preview {
    RootView()
        .environmentObject(AppState())
}
