// Copied from ios/Agents Anywhere (v2 app) for the v3 PoC.
import SwiftUI

struct AAWordmark: View {
    let fontSize: CGFloat

    var body: some View {
        Text(verbatim: "Agents Anywhere\u{2009}")
            .font(.custom("Caveat", fixedSize: fontSize).weight(.medium))
            .tracking(0)
            .lineLimit(1)
            .fixedSize(horizontal: true, vertical: true)
            .frame(height: fontSize)
    }
}
