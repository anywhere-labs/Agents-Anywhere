import SwiftUI

struct RootView: View {
    @EnvironmentObject private var appState: AppState
    @Environment(\.colorScheme) private var colorScheme
    @State private var showingEnterServer = false
    @State private var showingQRCodeLogin = false

    var body: some View {
        Group {
            switch appState.route {
            case .loading:
                Color(uiColor: .systemBackground)
            case .signedOut:
                ServiceEntryView(
                    onEnterServer: { showingEnterServer = true },
                    onQRCodeLogin: { showingQRCodeLogin = true },
                )
            case .signedIn:
                ChatShellView()
            }
        }
        .sheet(isPresented: $showingEnterServer) {
            EnterServerView {
                appState.activateSignedInRoute()
                showingEnterServer = false
            }
        }
        .sheet(isPresented: $showingQRCodeLogin) {
            QRCodeLoginView {
                appState.activateSignedInRoute()
                showingQRCodeLogin = false
            }
        }
        .overlay(alignment: .top) {
            if appState.route == .signedIn, let error = appState.restoreConnectionError {
                HStack(spacing: 12) {
                    Image(systemName: "wifi.exclamationmark")
                    VStack(alignment: .leading, spacing: 2) {
                        Text("暂时无法连接，正在显示本地内容").font(.footnote.weight(.medium))
                        Text(error).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                    }
                    Menu {
                        Button("立即重试", action: retryServerConnection)
                        Button("返回登录", action: appState.returnToLogin)
                    } label: { Image(systemName: "ellipsis").frame(width: 36, height: 36) }
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
