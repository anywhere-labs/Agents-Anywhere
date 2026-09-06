import SwiftUI

struct SheetCloseButton: View {
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            AppSymbol("xmark")
                .font(.body.weight(.semibold))
        }
        .accessibilityLabel(String(localized: "Close"))
    }
}
