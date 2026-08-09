import SwiftUI

struct AAWordmark: View {
    let fontSize: CGFloat

    var body: some View {
        Text(verbatim: "Agents Anywhere")
            .font(.custom("Caveat", fixedSize: fontSize).weight(.medium))
            .tracking(0)
            .lineLimit(1)
            .fixedSize(horizontal: true, vertical: true)
            .frame(height: fontSize)
    }
}
