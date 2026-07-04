import SwiftUI

@MainActor
func finishLoginWithSheetDismissal(appState: AppState, dismiss: DismissAction) {
    dismiss()
    Task {
        try? await Task.sleep(for: .milliseconds(360))
        await appState.showSignedInRoute()
    }
}

@MainActor
func finishSignOutWithSheetDismissal(
    appState: AppState,
    dismiss: DismissAction,
    onDismiss: @escaping () -> Void
) {
    dismiss()
    onDismiss()
    Task {
        try? await Task.sleep(for: .milliseconds(360))
        appState.showSignedOutRoute()
    }
}

struct AuthScreen<Content: View>: View {
    let title: String
    let onCancel: () -> Void
    let subtitle: String?
    let showsCancel: Bool
    @ViewBuilder let content: Content

    @Environment(\.colorScheme) private var colorScheme

    init(
        title: String,
        subtitle: String? = nil,
        showsCancel: Bool = true,
        onCancel: @escaping () -> Void,
        @ViewBuilder content: () -> Content
    ) {
        self.title = title
        self.subtitle = subtitle
        self.showsCancel = showsCancel
        self.onCancel = onCancel
        self.content = content()
    }

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 28) {
                    VStack(alignment: .leading, spacing: 10) {
                        Text(title)
                            .font(.system(size: 40, weight: .bold))
                            .foregroundStyle(AppTheme.primaryText(colorScheme))
                            .fixedSize(horizontal: false, vertical: true)

                        if let subtitle {
                            Text(subtitle)
                                .font(.title3)
                                .foregroundStyle(AppTheme.secondaryText(colorScheme))
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }

                    content
                }
                .padding(.horizontal, 22)
                .padding(.top, 22)
                .padding(.bottom, 34)
            }
        }
        .background(AppTheme.appBackground(colorScheme))
        .toolbar {
            if showsCancel {
                ToolbarItem(placement: .cancellationAction) {
                    SheetCloseButton(action: onCancel)
                }
            }
        }
    }
}

struct AuthWelcomeLayout<Content: View>: View {
    @ViewBuilder let content: Content

    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        VStack(spacing: 28) {
            Spacer()
            content
            Spacer()
        }
        .padding(.horizontal, 28)
        .padding(.vertical, 24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(AppTheme.appBackground(colorScheme))
    }
}

struct AuthBrandLockup: View {
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        VStack(spacing: 14) {
            Image(colorScheme == .dark ? "login-logo-dark-mode" : "login-logo-light-mode")
                .resizable()
                .scaledToFit()
                .frame(width: 76, height: 76)
                .accessibilityHidden(true)

            VStack(spacing: 7) {
                Text(title)
                    .font(.system(size: 36, weight: .bold))
                    .foregroundStyle(AppTheme.primaryText(colorScheme))
                    .minimumScaleFactor(0.74)
                    .lineLimit(1)

                Text("Connect this iPhone to your self-hosted workspace.")
                    .font(.body)
                    .foregroundStyle(AppTheme.secondaryText(colorScheme))
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private var title: String { "Agents Anywhere" }
}

struct AuthPrimaryButton: View {
    let title: String
    let systemImage: String?
    let isLoading: Bool
    let disabled: Bool
    let action: () -> Void

    init(
        title: String,
        systemImage: String? = nil,
        isLoading: Bool = false,
        disabled: Bool = false,
        action: @escaping () -> Void
    ) {
        self.title = title
        self.systemImage = systemImage
        self.isLoading = isLoading
        self.disabled = disabled
        self.action = action
    }

    var body: some View {
        AppGlassButton(
            title,
            systemImage: systemImage,
            style: .prominent,
            isLoading: isLoading,
            disabled: disabled,
            action: action,
        )
    }
}

struct AuthGlassButton: View {
    let title: String?
    let systemImage: String?
    let role: ButtonRole?
    let action: () -> Void

    init(_ title: String, role: ButtonRole? = nil, action: @escaping () -> Void) {
        self.title = title
        self.systemImage = nil
        self.role = role
        self.action = action
    }

    init(_ title: String, systemImage: String, role: ButtonRole? = nil, action: @escaping () -> Void) {
        self.title = title
        self.systemImage = systemImage
        self.role = role
        self.action = action
    }

    init(systemImage: String, role: ButtonRole? = nil, action: @escaping () -> Void) {
        self.title = nil
        self.systemImage = systemImage
        self.role = role
        self.action = action
    }

    var body: some View {
        if let title {
            AppGlassButton(
                title,
                systemImage: systemImage,
                role: role,
                action: action,
            )
        } else if let systemImage {
            AppGlassButton(
                systemImage: systemImage,
                role: role,
                action: action,
            )
        }
    }

}

struct LoginSummaryView: View {
    let server: String
    let userId: String

    var body: some View {
        VStack(spacing: 12) {
            summaryRow("Server", server)
            Divider()
            summaryRow("User", userId)
        }
        .font(.body)
        .padding(.vertical, 4)
    }

    private func summaryRow(_ title: String, _ value: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 16) {
            Text(title)
                .foregroundStyle(.secondary)
            Spacer(minLength: 12)
            Text(value)
                .multilineTextAlignment(.trailing)
                .lineLimit(2)
        }
    }
}

struct AuthResultView: View {
    let title: String
    let message: String
    let buttonTitle: String
    let buttonSystemImage: String
    let symbolName: String
    let symbolColor: Color
    let action: () -> Void

    var body: some View {
        AuthWelcomeLayout {
            VStack(spacing: 26) {
                VStack(spacing: 16) {
                    Image(systemName: symbolName)
                        .font(.system(size: 56, weight: .semibold))
                        .foregroundStyle(symbolColor)

                    VStack(spacing: 8) {
                        Text(title)
                            .font(.system(size: 34, weight: .bold))
                            .multilineTextAlignment(.center)

                        Text(message)
                            .font(.body)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }

                AuthPrimaryButton(
                    title: buttonTitle,
                    systemImage: buttonSystemImage,
                    action: action,
                )
            }
        }
    }
}
