import SwiftUI

/// One native field preserves selection, paste, accessibility and OTP AutoFill.
/// Its Form row supplies the system background and corner shape.
struct OneTimeCodeField: View {
    @Binding var code: String
    let title: String
    var length = 6

    private var digits: Binding<String> {
        Binding(get: { code }, set: { value in
            code = String(value.filter { $0.isASCII && $0.isNumber }.prefix(length))
        })
    }

    var body: some View {
        TextField(String(repeating: "0", count: length), text: digits)
            .textFieldStyle(.plain)
            .font(.system(.largeTitle, design: .monospaced).weight(.medium))
            .tracking(8)
            .multilineTextAlignment(.center)
            .keyboardType(.numberPad).textContentType(.oneTimeCode)
            .textInputAutocapitalization(.never).autocorrectionDisabled()
            .padding(.vertical, 10)
            .accessibilityLabel(title)
    }
}
