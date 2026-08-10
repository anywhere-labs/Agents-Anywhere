import SwiftUI
import UIKit

struct AccountAvatarView: View {
    let userId: String
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
            if let image = UIImage(data: data) {
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
        guard let firstCharacter = userId.first else { return "?" }
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
