import Foundation

enum HTTPError: LocalizedError {
    case invalidRequestURL(path: String)
    case invalidResponse
    case unauthorized
    case server(statusCode: Int, message: String, detail: JSONValue? = nil)
    case decoding(message: String)
    case streamOverflow

    var statusCode: Int? {
        if case let .server(statusCode, _, _) = self { return statusCode }
        return nil
    }

    var serverCode: String? {
        if case let .server(_, _, detail) = self { return detail?["code"]?.stringValue }
        return nil
    }

    var errorDescription: String? {
        switch self {
        case let .invalidRequestURL(path):
            return "The request URL is invalid: \(path)"
        case .invalidResponse:
            return "The server returned an invalid response."
        case .unauthorized:
            return "You are not signed in."
        case let .server(_, message, _):
            return message
        case let .decoding(message):
            return message
        case .streamOverflow:
            return "The live update buffer is full. Reconnect and recover session events."
        }
    }
}

struct HTTPServerErrorEnvelope: Decodable {
    let detail: JSONValue

    var message: String {
        detail["message"]?.stringValue ?? detail.displayString
    }
}
