import SwiftUI
import UIKit

struct AccountAvatarView: View {
    let displayName: String
    let source: AccountAvatarImageSource?
    let size: CGFloat

    var body: some View {
        avatarContent
            .frame(width: size, height: size)
            .clipShape(Circle())
    }

    @ViewBuilder
    private var avatarContent: some View {
        switch source {
        case let .data(data):
            if let image = AccountAvatarImageCache.image(for: data) {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
            } else {
                AccountAvatarFallback(character: fallbackCharacter, size: size)
            }
        case let .remote(url):
            AsyncImage(url: url) { phase in
                if case let .success(image) = phase {
                    image
                        .resizable()
                        .scaledToFill()
                } else {
                    AccountAvatarFallback(character: fallbackCharacter, size: size)
                }
            }
        case nil:
            AccountAvatarFallback(character: fallbackCharacter, size: size)
        }
    }

    private var fallbackCharacter: String {
        guard let firstCharacter = displayName.first else { return "?" }
        return String(firstCharacter).uppercased()
    }
}

private struct AccountAvatarFallback: View {
    let character: String
    let size: CGFloat

    var body: some View {
        Text(character)
            .font(.system(size: max(size * 0.38, 14), weight: .semibold, design: .rounded))
            .foregroundStyle(.white)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Color(red: 0.12, green: 0.66, blue: 0.38))
    }
}

/// The sidebar footer re-renders with the shell; decode the inline avatar once
/// per payload instead of on every body evaluation.
enum AccountAvatarImageCache {
    private static let cache = NSCache<NSData, UIImage>()
    static func image(for data: Data) -> UIImage? {
        let key = data as NSData
        if let cached = cache.object(forKey: key) { return cached }
        guard let image = UIImage(data: data) else { return nil }
        cache.setObject(image, forKey: key)
        return image
    }
}
