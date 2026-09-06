import Foundation

struct V2ClientScope: Hashable {
    let serverURL: URL
    let accountID: String

    init(serverURL: URL, accountID: String) {
        self.serverURL = serverURL.normalizedV2ServerURL()
        self.accountID = accountID
    }
}
