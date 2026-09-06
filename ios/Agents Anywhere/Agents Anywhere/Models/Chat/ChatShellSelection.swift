import Foundation

enum ChatShellSelection: Codable, Equatable {
    case newSession
    case device(V2ConnectorID)
    case session(V2SessionID)
}
