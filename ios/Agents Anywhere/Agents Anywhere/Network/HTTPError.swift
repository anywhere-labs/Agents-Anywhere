import Foundation

enum HTTPError: LocalizedError {
    case invalidRequestURL(path: String)
    case invalidResponse
    case unauthorized
    case server(statusCode: Int, message: String)
    case decoding(message: String)

    var errorDescription: String? {
        switch self {
        case let .invalidRequestURL(path):
            return "The request URL is invalid: \(path)"
        case .invalidResponse:
            return "The server returned an invalid response."
        case .unauthorized:
            return "You are not signed in."
        case let .server(_, message):
            return message
        case let .decoding(message):
            return message
        }
    }
}

struct HTTPServerErrorEnvelope: Decodable {
    let detail: JSONValue

    var message: String {
        detail.displayString
    }
}
