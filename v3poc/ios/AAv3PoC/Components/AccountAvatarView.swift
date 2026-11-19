// Trimmed from ios/Agents Anywhere (v2 app) for the v3 PoC: initials only, no uploaded avatar.
import SwiftUI

struct AccountAvatarView: View {
    let displayName: String
    let source: Never?
    let size: CGFloat

    var body: some View {
        Text(displayName.first.map { String($0).uppercased() } ?? "?")
            .font(.system(size: max(size * 0.38, 14), weight: .semibold, design: .rounded))
            .foregroundStyle(.white)
            .frame(width: size, height: size)
            .background(Color(red: 0.12, green: 0.66, blue: 0.38))
            .clipShape(Circle())
    }
}
