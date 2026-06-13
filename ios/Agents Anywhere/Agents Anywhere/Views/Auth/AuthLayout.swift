import SwiftUI

struct AuthScreen<Content: View>: View {
    let title: String
    let showsBack: Bool
    let onBack: (() -> Void)?
    let onCancel: () -> Void
    @ViewBuilder let content: Content

    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                HStack {
                    if showsBack {
                        AuthGlassButton(systemImage: "chevron.left") {
                            onBack?()
                        }
                        .accessibilityLabel("Back")
                    }

                    Spacer()

                    AuthGlassButton("Cancel") {
                        onCancel()
                    }
                }

                Text(title)
                    .font(.system(size: 44, weight: .bold))
                    .foregroundStyle(AppTheme.primaryText(colorScheme))
                    .fixedSize(horizontal: false, vertical: true)

                content
            }
            .padding(.horizontal, 28)
            .padding(.top, 22)
            .padding(.bottom, 34)
        }
        .background(AppTheme.appBackground(colorScheme))
        .navigationBarBackButtonHidden(true)
        .toolbar(.hidden, for: .navigationBar)
    }
}

struct AuthPrimaryButton: View {
    let title: String
    let disabled: Bool
    let action: () -> Void

    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.headline)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 14)
        }
        .buttonStyle(.plain)
        .foregroundStyle(AppTheme.primaryControlForeground(colorScheme))
        .background(
            AppTheme.primaryControlBackground(colorScheme).opacity(disabled ? 0.36 : 1),
            in: Capsule(),
        )
        .disabled(disabled)
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

    init(systemImage: String, role: ButtonRole? = nil, action: @escaping () -> Void) {
        self.title = nil
        self.systemImage = systemImage
        self.role = role
        self.action = action
    }

    var body: some View {
        Button(role: role, action: action) {
            Group {
                if let systemImage {
                    Image(systemName: systemImage)
                        .font(.headline.weight(.semibold))
                        .frame(width: 22, height: 22)
                } else if let title {
                    Text(title)
                        .font(.headline)
                        .padding(.horizontal, 4)
                }
            }
            .padding(.horizontal, systemImage == nil ? 16 : 10)
            .padding(.vertical, 11)
        }
        .buttonStyle(.bordered)
        .controlSize(.large)
        .buttonBorderShape(.capsule)
        .foregroundStyle(role == .destructive ? .red : .primary)
    }
}

struct AuthTextFieldStyle: ViewModifier {
    @Environment(\.colorScheme) private var colorScheme

    func body(content: Content) -> some View {
        content
            .font(.title3)
            .padding(.horizontal, 18)
            .padding(.vertical, 16)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 24, style: .continuous)
                    .stroke(AppTheme.secondaryControlStroke(colorScheme), lineWidth: 1),
            )
    }
}

extension View {
    func authTextFieldStyle() -> some View {
        modifier(AuthTextFieldStyle())
    }
}
