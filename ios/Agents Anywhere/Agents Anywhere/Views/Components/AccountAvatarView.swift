import SwiftUI
import UIKit

struct AccountAvatarView: View {
    let userId: String
    let source: AccountAvatarImageSource?
    let size: CGFloat

    var body: some View {
        avatarContent
            .frame(width: size, height: size)
            .background(Color.accentColor, in: Circle())
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
                AccountAvatarFallback(character: fallbackCharacter)
            }
        case let .remote(url):
            AsyncImage(url: url) { phase in
                if case let .success(image) = phase {
                    image
                        .resizable()
                        .scaledToFill()
                } else {
                    AccountAvatarFallback(character: fallbackCharacter)
                }
            }
        case nil:
            AccountAvatarFallback(character: fallbackCharacter)
        }
    }

    private var fallbackCharacter: String {
        guard let firstCharacter = userId.first else { return "?" }
        return String(firstCharacter).uppercased()
    }
}

private struct AccountAvatarFallback: View {
    let character: String

    var body: some View {
        Text(character)
            .font(.title3.weight(.semibold))
            .foregroundStyle(.white)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
