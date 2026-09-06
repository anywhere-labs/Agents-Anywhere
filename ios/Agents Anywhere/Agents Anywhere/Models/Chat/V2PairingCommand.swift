import Foundation

enum V2PairingCommand {
    static func start(server: URL, credential: V2ConnectorCreateResponse) -> String {
        "uvx anywhere-cli start --server-url \(quote(server.absoluteString)) --connector-id \(quote(credential.connector.id)) --connector-token \(quote(credential.connectorToken))"
    }
    static func pair(server: URL) -> String { "uvx anywhere-cli pair \(quote(server.absoluteString))" }
    private static func quote(_ value: String) -> String { "'" + value.replacingOccurrences(of: "'", with: "'\"'\"'") + "'" }
}
