import Foundation

/// Port preview failures (preview 1.0). Codes come from the Server, which also
/// forwards the device's `port_*` / `preview_*` codes.
nonisolated enum PortPreviewErrorText {
    /// No preview domain on this instance: the API answers 404 or
    /// `preview_disabled` (runtime-errors 1.1 calls it `preview_domain_not_configured`).
    static func disablesPreview(_ error: Error) -> Bool {
        if (error as? HTTPError)?.statusCode == 404 { return true }
        return ["preview_disabled", "preview_domain_not_configured"].contains(code(error) ?? "")
    }

    static func message(_ error: Error) -> String { text(code: code(error)) }

    static func text(code: String?) -> String {
        switch code {
        case "port_not_listening": String(localized: "这个端口已经没有在监听了。")
        case "port_not_local", "preview_port_not_allowed": String(localized: "只能预览本机地址上的端口。")
        case "preview_limit", "preview_limit_reached": String(localized: "同时打开的预览已达上限，请先停止其他预览。")
        case "preview_unavailable": String(localized: "设备上的预览通道暂时不可用，请稍后重试。")
        case "preview_disabled", "preview_domain_not_configured": String(localized: "这个服务器没有开启端口预览。")
        case "connector_offline": String(localized: "设备离线，上线后才能预览。")
        default: String(localized: "无法建立预览，请稍后重试。")
        }
    }

    static func code(_ error: Error) -> String? {
        (error as? HTTPError)?.serverCode ?? (error as? V2ClientFailure)?.code
    }
}
