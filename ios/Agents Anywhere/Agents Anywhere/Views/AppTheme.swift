import SwiftUI

enum AppTheme {
    static func appBackground(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? Color.black : Color.white
    }

    static func primaryText(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? Color.white : Color.black
    }

    static func secondaryText(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? Color.white.opacity(0.66) : Color.black.opacity(0.58)
    }

    static func primaryControlBackground(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? Color.white : Color.black
    }

    static func primaryControlForeground(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? Color.black : Color.white
    }

    static func primaryControlHighlight(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? Color.white.opacity(0.52) : Color.white.opacity(0.34)
    }

    static func secondaryControlStroke(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? Color.white.opacity(0.22) : Color.black.opacity(0.14)
    }

    static func glassScrim(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? Color.black.opacity(0.55) : Color.black.opacity(0.42)
    }

    static func controlShadow(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? Color.clear : Color.black.opacity(0.08)
    }

    static func groupedFill(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? Color.white.opacity(0.06) : Color.black.opacity(0.04)
    }
}
