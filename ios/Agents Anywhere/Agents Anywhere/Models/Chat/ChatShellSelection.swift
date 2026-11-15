import Foundation

enum ChatShellSelection: Codable, Equatable {
    case newSession
    case device(V2ConnectorID)
    case session(V2SessionID)
    /// SpecRune 任务看板，绑定到某台设备（数据来自该设备的项目）。
    case specRune(V2ConnectorID)
}
