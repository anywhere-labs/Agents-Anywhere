import SwiftUI

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
                    Button("Cancel", action: onCancel)
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

    @Environment(\.colorScheme) private var colorScheme

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
        Button(action: action) {
            ZStack {
                normalLabel
                    .opacity(isLoading ? 0 : 1)

                if isLoading {
                    ProgressView()
                        .tint(AppTheme.primaryControlForeground(colorScheme))
                }
            }
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(.glassProminent)
        .buttonBorderShape(.capsule)
        .controlSize(.large)
        .tint(AppTheme.primaryControlBackground(colorScheme))
        .foregroundStyle(AppTheme.primaryControlForeground(colorScheme))
        .disabled(disabled || isLoading)
        .animation(.easeInOut(duration: 0.18), value: isLoading)
    }

    private var normalLabel: some View {
        HStack(spacing: 10) {
            if let systemImage {
                Image(systemName: systemImage)
            }
            Text(title)
        }
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
        Button(role: role, action: action) {
            HStack(spacing: 10) {
                if let systemImage {
                    Image(systemName: systemImage)
                }
                if let title {
                    Text(title)
                }
            }
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(.glass)
        .buttonBorderShape(.capsule)
        .controlSize(.large)
    }

    @Environment(\.colorScheme) private var colorScheme
}
