// Native side of the WebView render bridge `aa.render/2` (docs/v3/mobile-bridge.md).
//
// web → native: `window.webkit.messageHandlers.aa.postMessage(obj)`
// native → web: `webView.evaluateJavaScript("window.aa.receive(<json>)")`
//
// Every message is `{ v: 2, type, ... }` with snake_case fields and base64 bytes. Nothing is sent before the page
// says `ready` (messages queue); messages of one frame (~16 ms) are sent as one `batch { messages }`.
// This file is UI-free so it is covered by `swift test`; `RenderWebView` in the app does the WebKit part.

import Foundation

public enum BridgeVersion {
    public static let protocolVersion: Int64 = 2
    public static let name = "aa.render/2"
}

/// Messages the native layer sends to the page.
public enum BridgeOut {
    static func message(_ type: String, _ fields: [String: JSONValue] = [:]) -> JSONValue {
        var object = fields
        object["v"] = .int(BridgeVersion.protocolVersion)
        object["type"] = .string(type)
        return .object(object)
    }

    public struct Insets: Sendable, Hashable {
        public var top: Double
        public var bottom: Double
        public var left: Double
        public var right: Double
        public init(top: Double, bottom: Double, left: Double, right: Double) {
            self.top = top
            self.bottom = bottom
            self.left = left
            self.right = right
        }
    }

    public static func theme(
        dark: Bool, insets: Insets, fontScale: Double? = nil, reduceMotion: Bool? = nil, highContrast: Bool? = nil
    ) -> JSONValue {
        var fields: [String: JSONValue] = [
            "scheme": .string(dark ? "dark" : "light"),
            "insets": [
                "top": .double(insets.top), "bottom": .double(insets.bottom), "left": .double(insets.left), "right": .double(insets.right),
            ],
        ]
        if let fontScale { fields["font_scale"] = .double(fontScale) }
        if let reduceMotion { fields["reduce_motion"] = .bool(reduceMotion) }
        if let highContrast { fields["high_contrast"] = .bool(highContrast) }
        return message("theme", fields)
    }

    /// `zh-CN` or `en`.
    public static func locale(_ identifier: String) -> JSONValue {
        message("locale", ["locale": .string(identifier.lowercased().hasPrefix("zh") ? "zh-CN" : "en")])
    }

    /// `me`: the reader's name as the device records it (`author` / `answered.by`), shown as "you".
    public static func viewConversation(
        deviceID: String, sessionID: String, agent: String, readonly: Bool, encrypted: Bool, me: String? = nil
    ) -> JSONValue {
        var fields: [String: JSONValue] = [
            "device_id": .string(deviceID), "session_id": .string(sessionID), "agent": .string(agent),
            "readonly": .bool(readonly), "encrypted": .bool(encrypted),
        ]
        if let me { fields["me"] = .string(me) }
        return message("view.conversation", fields)
    }

    /// Forward an `aa.v3.Sessions/watch` event unchanged.
    public static func conversationEvent(sessionID: String, event: JSONValue) -> JSONValue {
        message("conversation.event", ["session_id": .string(sessionID), "event": event])
    }

    public static func conversationOlder(sessionID: String, messages: [JSONValue], hasMore: Bool) -> JSONValue {
        message("conversation.older", ["session_id": .string(sessionID), "messages": .array(messages), "has_more": .bool(hasMore)])
    }

    public static func conversationCached(sessionID: String, messages: [JSONValue], control: JSONValue) -> JSONValue {
        message("conversation.cached", ["session_id": .string(sessionID), "messages": .array(messages), "control": control, "stale": true])
    }

    public static func fileData(requestID: String, data: Data?, mime: String?, error: String?) -> JSONValue {
        var fields: [String: JSONValue] = ["request_id": .string(requestID), "ok": .bool(data != nil)]
        if let data { fields["base64"] = .string(data.base64EncodedString()) }
        if let mime { fields["mime"] = .string(mime) }
        if let error { fields["error"] = .string(error) }
        return message("file.data", fields)
    }

    /// `attachMode` `control` when this client just created the terminal; `info` adds its mode, owner and size.
    public static func viewTerminal(
        deviceID: String, terminalID: String, controllerLabel: String? = nil, attachMode: String? = nil, info: TerminalInfo? = nil
    ) -> JSONValue {
        var fields: [String: JSONValue] = ["device_id": .string(deviceID), "terminal_id": .string(terminalID)]
        if let controllerLabel { fields["controller_label"] = .string(controllerLabel) }
        if let attachMode { fields["attach_mode"] = .string(attachMode) }
        if let info {
            if let mode = info.mode { fields["term_mode"] = .string(mode) }
            if let owner = info.owner { fields["owner"] = .string(owner) }
            fields["cols"] = .int(Int64(info.cols))
            fields["rows"] = .int(Int64(info.rows))
        }
        return message("view.terminal", fields)
    }

    /// The attach stream ended. `fatal`: do not reconnect (the terminal is gone). `snapshotNext`: start over from a
    /// snapshot.
    public static func terminalClosed(terminalID: String, fatal: Bool, snapshotNext: Bool = false) -> JSONValue {
        var fields: [String: JSONValue] = ["terminal_id": .string(terminalID), "fatal": .bool(fatal)]
        if snapshotNext { fields["snapshot_next"] = true }
        return message("term.closed", fields)
    }

    /// An `aa.v3.Terminals/attach` output frame `{type: T, ...}` as `term.T`.
    public static func terminalFrame(terminalID: String, frame: JSONValue) -> JSONValue {
        var fields = frame.objectValue ?? [:]
        let type = fields.removeValue(forKey: "type")?.stringValue ?? "output"
        fields["terminal_id"] = .string(terminalID)
        return message("term.\(type)", fields)
    }

    /// A key of the native extra-keys bar; the page maps it to bytes exactly as the Web terminal does. `key`:
    /// `escape`, `tab`, `up`, `down`, `left`, `right`, `home`, `end`, `page_up`, `page_down`, a single character (with
    /// `ctrl` / `alt`), or `ctrl` alone to latch Ctrl for the next typed character.
    public static func terminalKey(_ key: String, ctrl: Bool = false, alt: Bool = false, shift: Bool = false) -> JSONValue {
        var fields: [String: JSONValue] = ["key": .string(key)]
        if ctrl { fields["ctrl"] = true }
        if alt { fields["alt"] = true }
        if shift { fields["shift"] = true }
        return message("term.key", fields)
    }

    public static func scroll(toBottom: Bool) -> JSONValue {
        message("scroll", ["to": .string(toBottom ? "bottom" : "top")])
    }
}

/// Messages the page sends to the native layer.
public enum BridgeIn: Sendable, Equatable {
    /// `protocol` is `aa.render/2` on the web-v3 bundle.
    case ready(version: String?, protocol: String?, capabilities: [String])
    case loadOlder(sessionID: String, beforeSeq: Int)
    case answer(sessionID: String, requestID: String, optionID: String)
    case openLink(URL)
    case openFile(path: String, line: Int?)
    case fileRead(requestID: String, path: String, maxBytes: Int?)
    case copy(String)
    case haptic(String)
    case scrollState(atBottom: Bool, distance: Double)
    /// `term.attach` / `term.detach` / `term.input` / `term.resize` / `term.claim` / `term.release`, fields kept.
    case terminal(type: String, fields: [String: JSONValue])
    case unknown(String)

    /// Parse what `postMessage` delivered (a dictionary from WebKit, or JSON text).
    public static func parse(_ body: Any) -> BridgeIn? {
        let value: JSONValue?
        if let text = body as? String {
            value = try? JSONValue(json: Data(text.utf8))
        } else if JSONSerialization.isValidJSONObject(body), let data = try? JSONSerialization.data(withJSONObject: body) {
            value = try? JSONValue(json: data)
        } else {
            value = nil
        }
        guard let value else { return nil }
        return parse(json: value)
    }

    public static func parse(json: JSONValue) -> BridgeIn? {
        guard let object = json.objectValue, let type = object["type"]?.stringValue else { return nil }
        func string(_ key: String) -> String? { object[key]?.stringValue }
        func int(_ key: String) -> Int? {
            if let value = object[key]?.intValue { return Int(value) }
            if case .double(let double) = object[key] { return Int(double) }
            return nil
        }
        switch type {
        case "ready":
            let capabilities = object["capabilities"]?.arrayValue?.compactMap(\.stringValue) ?? []
            let version: String? = string("version") ?? object["version"]?.intValue.map { String($0) }
            return .ready(version: version, protocol: string("protocol"), capabilities: capabilities)
        case "load_older":
            guard let sessionID = string("session_id"), let before = int("before_seq") else { return nil }
            return .loadOlder(sessionID: sessionID, beforeSeq: before)
        case "answer":
            guard let sessionID = string("session_id"), let requestID = string("request_id"), let optionID = string("option_id") else { return nil }
            return .answer(sessionID: sessionID, requestID: requestID, optionID: optionID)
        case "open_link":
            guard let text = string("url"), let url = URL(string: text) else { return nil }
            return .openLink(url)
        case "open_file":
            guard let path = string("path") else { return nil }
            return .openFile(path: path, line: int("line"))
        case "file.read":
            guard let requestID = string("request_id"), let path = string("path") else { return nil }
            return .fileRead(requestID: requestID, path: path, maxBytes: int("max_bytes"))
        case "copy":
            return string("text").map(BridgeIn.copy)
        case "haptic":
            return .haptic(string("kind") ?? "light")
        case "scroll_state":
            let distance: Double
            switch object["distance"] {
            case .double(let value): distance = value
            case .int(let value): distance = Double(value)
            default: distance = 0
            }
            return .scrollState(atBottom: object["at_bottom"]?.boolValue ?? true, distance: distance)
        case let type where type.hasPrefix("term."):
            var fields = object
            fields.removeValue(forKey: "type")
            fields.removeValue(forKey: "v")
            return .terminal(type: String(type.dropFirst("term.".count)), fields: fields)
        default:
            return .unknown(type)
        }
    }
}

/// Queues messages until `ready`, then hands out one script per frame: a single message, or a `batch`.
public struct BridgeOutbox: Sendable {
    public private(set) var isReady = false
    private var pending: [JSONValue] = []

    public init() {}

    public mutating func enqueue(_ message: JSONValue) {
        pending.append(message)
    }

    /// The page loaded (again): messages queued since may now go out. A reload resets everything the page knew.
    public mutating func markReady() {
        isReady = true
    }

    /// The page is gone (reload / crash): queue until the next `ready`.
    public mutating func reset() {
        isReady = false
        pending = []
    }

    public var hasPending: Bool { !pending.isEmpty }

    /// The JavaScript to evaluate for this frame, or nil when nothing is due.
    public mutating func drainScript() -> String? {
        guard isReady, !pending.isEmpty else { return nil }
        let payload: JSONValue = pending.count == 1 ? pending[0] : BridgeOut.message("batch", ["messages": .array(pending)])
        pending = []
        guard let data = try? payload.jsonData(), let json = String(data: data, encoding: .utf8) else { return nil }
        return "window.aa && window.aa.receive(\(json))"
    }
}
