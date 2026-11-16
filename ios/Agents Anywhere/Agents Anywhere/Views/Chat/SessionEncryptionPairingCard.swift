import SwiftUI

/// 会话所在设备要求加密、但还没配对（或设备身份变了）时，在输入框上方给出配对入口。
/// 这时任何内容请求都不会以明文发出。
struct SessionEncryptionPairingCard: View {
    let message: String
    let onPair: () -> Void

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            AppSymbol("exclamationmark.shield", size: 20).foregroundStyle(.orange)
            VStack(alignment: .leading, spacing: 2) {
                Text(String(localized: "e2ee.session.pairTitle")).font(.subheadline.weight(.semibold))
                Text(message).font(.footnote).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 8)
            AppGlassButton(String(localized: "e2ee.device.pair"), systemImage: "qrcode.viewfinder", style: .prominent,
                           maxWidth: nil, action: onPair)
        }
        .padding(.horizontal, 16).padding(.vertical, 10)
        .accessibilityElement(children: .contain)
    }
}
