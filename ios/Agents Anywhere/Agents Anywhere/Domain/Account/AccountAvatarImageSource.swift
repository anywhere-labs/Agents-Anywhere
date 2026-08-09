import Foundation

enum AccountAvatarImageSource: Hashable {
    case data(Data)
    case remote(URL)

    static func parse(_ value: String?) -> AccountAvatarImageSource? {
        guard let value, !value.isEmpty else { return nil }
        if value.hasPrefix("data:") {
            guard
                let commaIndex = value.firstIndex(of: ","),
                value[..<commaIndex].contains(";base64"),
                let data = Data(base64Encoded: String(value[value.index(after: commaIndex)...]))
            else {
                return nil
            }
            return .data(data)
        }
        guard let url = URL(string: value) else { return nil }
        return .remote(url)
    }
}
