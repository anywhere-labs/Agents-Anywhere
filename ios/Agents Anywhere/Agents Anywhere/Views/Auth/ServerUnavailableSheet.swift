import SwiftUI

struct ServerUnavailableSheet: View {
    let isRetrying: Bool
    let onReturnToLogin: () -> Void
    let onRetry: () -> Void

    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        VStack(spacing: 28) {
            Spacer(minLength: 0)

            VStack(spacing: 16) {
                Image(systemName: "network.slash")
                    .font(.system(size: 44, weight: .semibold))
                    .foregroundStyle(AppTheme.primaryText(colorScheme))

                VStack(spacing: 8) {
                    Text("Unable to connect to server")
                        .font(.title2.bold())
                        .multilineTextAlignment(.center)

                    Text("Check that the server is running and reachable, then try again.")
                        .font(.body)
                        .foregroundStyle(AppTheme.secondaryText(colorScheme))
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            VStack(spacing: 12) {
                AppGlassButton(
                    "Return to login",
                    systemImage: "arrow.backward",
                    style: .prominent,
                    disabled: isRetrying,
                    action: onReturnToLogin,
                )

                AppGlassButton(
                    "Retry",
                    systemImage: "arrow.clockwise",
                    isLoading: isRetrying,
                    disabled: isRetrying,
                    action: onRetry,
                )
            }

            Spacer(minLength: 0)
        }
        .padding(.horizontal, 24)
        .padding(.vertical, 28)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(AppTheme.appBackground(colorScheme))
        .interactiveDismissDisabled()
    }
}

#Preview {
    ServerUnavailableSheet(
        isRetrying: false,
        onReturnToLogin: {},
        onRetry: {},
    )
}
