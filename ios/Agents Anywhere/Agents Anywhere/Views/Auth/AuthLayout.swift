import SwiftUI

struct AuthScreen<Content: View>: View {
    let title: String
    let onCancel: () -> Void
    let subtitle: String?
    @ViewBuilder let content: Content

    @Environment(\.colorScheme) private var colorScheme

    init(
        title: String,
        subtitle: String? = nil,
        onCancel: @escaping () -> Void,
        @ViewBuilder content: () -> Content
    ) {
        self.title = title
        self.subtitle = subtitle
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
            ToolbarItem(placement: .cancellationAction) {
                Button("Cancel", action: onCancel)
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
        .padding(28)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(AppTheme.appBackground(colorScheme))
    }
}

struct AuthBrandLockup: View {
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        VStack(spacing: 16) {
            Image(colorScheme == .dark ? "login-logo-dark-mode" : "login-logo-light-mode")
                .resizable()
                .scaledToFit()
                .frame(width: 88, height: 88)
                .accessibilityHidden(true)

            VStack(spacing: 7) {
                Text(title)
                    .font(.system(size: 42, weight: .bold))
                    .foregroundStyle(AppTheme.primaryText(colorScheme))
                    .minimumScaleFactor(0.74)
                    .lineLimit(1)

                Text("Connect this iPhone to your self-hosted workspace.")
                    .font(.title3)
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
            HStack(spacing: 10) {
                if isLoading {
                    ProgressView()
                        .tint(AppTheme.primaryControlForeground(colorScheme))
                } else if let systemImage {
                    Image(systemName: systemImage)
                        .font(.title3.weight(.semibold))
                }
                Text(title)
                    .font(.title3.weight(.semibold))
            }
            .frame(maxWidth: .infinity, minHeight: 58)
            .padding(.horizontal, 22)
        }
        .buttonStyle(.glassProminent)
        .buttonBorderShape(.capsule)
        .controlSize(.large)
        .tint(AppTheme.primaryControlBackground(colorScheme))
        .foregroundStyle(AppTheme.primaryControlForeground(colorScheme))
        .shadow(color: AppTheme.controlShadow(colorScheme), radius: 18, x: 0, y: 10)
        .disabled(disabled || isLoading)
        .animation(.easeInOut(duration: 0.18), value: isLoading)
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
                        .font(.title3.weight(.semibold))
                }
                if let title {
                    Text(title)
                        .font(.title3.weight(.semibold))
                }
            }
            .frame(maxWidth: .infinity, minHeight: 58)
            .padding(.horizontal, 22)
        }
        .buttonStyle(.glass)
        .buttonBorderShape(.capsule)
        .controlSize(.large)
        .shadow(color: AppTheme.controlShadow(colorScheme), radius: 14, x: 0, y: 8)
    }

    @Environment(\.colorScheme) private var colorScheme
}
