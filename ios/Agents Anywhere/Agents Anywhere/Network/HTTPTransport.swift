import Foundation

protocol HTTPTransport {
    func send<Body: Encodable, Response: Decodable>(_ request: HTTPRequest<Body, Response>) async throws -> Response
    func upload<Response: Decodable>(_ request: HTTPUploadRequest<Response>) async throws -> Response
    func download(_ url: URL) async throws -> URL
}

struct URLSessionHTTPTransport: HTTPTransport {
    private let serverURL: URL
    private let urlSession: URLSession
    private let tokenProvider: AuthTokenProvider
    private let encoder: JSONEncoder
    private let decoder: JSONDecoder
    private let retryPolicy: HTTPReadRetryPolicy
    private let sleep: (Duration) async throws -> Void

    init(
        serverURL: URL,
        urlSession: URLSession = .shared,
        tokenProvider: AuthTokenProvider,
        encoder: JSONEncoder = JSONEncoder(),
        decoder: JSONDecoder = JSONDecoder(),
        retryPolicy: HTTPReadRetryPolicy = HTTPReadRetryPolicy(),
        sleep: @escaping (Duration) async throws -> Void = { try await Task.sleep(for: $0) }
    ) {
        self.serverURL = serverURL.normalizedV2ServerURL()
        self.urlSession = urlSession
        self.tokenProvider = tokenProvider
        self.encoder = encoder
        self.decoder = decoder
        self.retryPolicy = retryPolicy
        self.sleep = sleep
    }

    /// Performs network I/O, injects auth when requested, and decodes the response body.
    func send<Body: Encodable, Response: Decodable>(_ request: HTTPRequest<Body, Response>) async throws -> Response {
        let urlRequest = try await makeURLRequest(request)
        var attempt = 0
        while true {
            try Task.checkCancellation()
            var retryAfter: TimeInterval?
            do {
                let (data, response) = try await urlSession.data(for: urlRequest)
                guard let http = response as? HTTPURLResponse else { throw HTTPError.invalidResponse }
                guard 200..<300 ~= http.statusCode else {
                    retryAfter = retryPolicy.delay(from: http.value(forHTTPHeaderField: "Retry-After"))
                    throw HTTPError.server(statusCode: http.statusCode,
                                           message: decodeServerErrorMessage(data: data, statusCode: http.statusCode),
                                           detail: try? decoder.decode(HTTPServerErrorEnvelope.self, from: data).detail)
                }
                return try decodeResponse(Response.self, from: data)
            } catch {
                try Task.checkCancellation()
                guard request.method == .get, attempt < retryPolicy.maximumRetries,
                      retryPolicy.permitsRetry(error) else { throw error }
                // Long rate-limit waits are surfaced to the caller; never retry earlier
                // than the server asks, or hold a foreground request indefinitely.
                if let retryAfter, retryAfter > 30 { throw error }
                let delay = max(0.5 * pow(2, Double(attempt)), retryAfter ?? 0)
                attempt += 1
                try await sleep(.seconds(delay))
            }
        }
    }

    /// Performs multipart upload I/O and decodes the JSON response.
    func upload<Response: Decodable>(_ request: HTTPUploadRequest<Response>) async throws -> Response {
        let boundary = "AgentsAnywhere-\(UUID().uuidString)"
        let urlRequest = try await makeUploadURLRequest(request, boundary: boundary)
        let (data, response) = try await urlSession.data(for: urlRequest)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw HTTPError.invalidResponse
        }
        guard 200..<300 ~= httpResponse.statusCode else {
            throw HTTPError.server(
                statusCode: httpResponse.statusCode,
                message: decodeServerErrorMessage(data: data, statusCode: httpResponse.statusCode),
                detail: try? decoder.decode(HTTPServerErrorEnvelope.self, from: data).detail
            )
        }
        return try decodeResponse(Response.self, from: data)
    }

    /// The API returns a transfer URL. Resolve it only against this account's
    /// server and never forward its credentials to another origin on redirect.
    func download(_ url: URL) async throws -> URL {
        guard let target = URL(string: url.relativeString, relativeTo: serverURL)?.absoluteURL,
              target.hasSameOrigin(as: serverURL) else { throw HTTPError.invalidResponse }
        guard let token = try await tokenProvider.accessToken(), !token.isEmpty else { throw HTTPError.unauthorized }
        var request = URLRequest(url: target)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/octet-stream", forHTTPHeaderField: "Accept")
        try Task.checkCancellation()
        let (file, response) = try await urlSession.download(for: request, delegate: DownloadRedirectPolicy(origin: serverURL))
        do {
            try Task.checkCancellation()
            guard let http = response as? HTTPURLResponse else { throw HTTPError.invalidResponse }
            guard 200..<300 ~= http.statusCode else {
                throw HTTPError.server(statusCode: http.statusCode, message: HTTPURLResponse.localizedString(forStatusCode: http.statusCode))
            }
            return file
        } catch { try? FileManager.default.removeItem(at: file); throw error }
    }

    private func decodeResponse<Response: Decodable>(_ responseType: Response.Type, from data: Data) throws -> Response {
        if responseType == EmptyResponse.self, let empty = EmptyResponse() as? Response {
            return empty
        }
        do {
            return try decoder.decode(Response.self, from: data)
        } catch let error as DecodingError {
            throw HTTPError.decoding(message: error.v2Description)
        }
    }

    private func makeUploadURLRequest<Response: Decodable>(
        _ request: HTTPUploadRequest<Response>,
        boundary: String
    ) async throws -> URLRequest {
        guard let url = URL(string: v2APIPath(request.path), relativeTo: serverURL)?.absoluteURL else {
            throw HTTPError.invalidRequestURL(path: request.path)
        }
        var urlRequest = URLRequest(url: url)
        urlRequest.httpMethod = HTTPMethod.post.rawValue
        urlRequest.setValue("application/json", forHTTPHeaderField: "Accept")
        urlRequest.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        if request.requiresAuth {
            guard let token = try await tokenProvider.accessToken(), !token.isEmpty else {
                throw HTTPError.unauthorized
            }
            urlRequest.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        urlRequest.httpBody = multipartBody(files: request.files, boundary: boundary)
        return urlRequest
    }

    private func multipartBody(files: [HTTPUploadFile], boundary: String) -> Data {
        var body = Data()
        for file in files {
            body.append("--\(boundary)\r\n".data(using: .utf8) ?? Data())
            body.append(
                "Content-Disposition: form-data; name=\"\(multipartQuoted(file.fieldName))\"; filename=\"\(multipartQuoted(file.fileName))\"\r\n"
                    .data(using: .utf8) ?? Data()
            )
            body.append("Content-Type: \(file.mediaType)\r\n\r\n".data(using: .utf8) ?? Data())
            body.append(file.data)
            body.append("\r\n".data(using: .utf8) ?? Data())
        }
        body.append("--\(boundary)--\r\n".data(using: .utf8) ?? Data())
        return body
    }

    private func multipartQuoted(_ value: String) -> String {
        value
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
            .replacingOccurrences(of: "\r", with: "")
            .replacingOccurrences(of: "\n", with: "")
    }

    private func makeURLRequest<Body: Encodable, Response: Decodable>(
        _ request: HTTPRequest<Body, Response>
    ) async throws -> URLRequest {
        guard var components = URLComponents(
            url: URL(string: v2APIPath(request.path), relativeTo: serverURL)?.absoluteURL ?? serverURL,
            resolvingAgainstBaseURL: false
        ) else {
            throw HTTPError.invalidRequestURL(path: request.path)
        }
        if !request.queryItems.isEmpty {
            components.queryItems = request.queryItems
        }
        guard let url = components.url else {
            throw HTTPError.invalidRequestURL(path: request.path)
        }

        var urlRequest = URLRequest(url: url)
        urlRequest.httpMethod = request.method.rawValue
        urlRequest.setValue("application/json", forHTTPHeaderField: "Accept")
        if request.requiresAuth {
            guard let token = try await tokenProvider.accessToken(), !token.isEmpty else {
                throw HTTPError.unauthorized
            }
            urlRequest.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        if let body = request.body {
            urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
            urlRequest.httpBody = try encoder.encode(body)
        }
        return urlRequest
    }

    private func decodeServerErrorMessage(data: Data, statusCode: Int) -> String {
        if let envelope = try? decoder.decode(HTTPServerErrorEnvelope.self, from: data) {
            return envelope.message
        }
        return HTTPURLResponse.localizedString(forStatusCode: statusCode)
    }
}

private let v2Namespace = "/api/v2"

func v2APIPath(_ path: String) -> String {
    let normalized = path.hasPrefix("/") ? path : "/\(path)"
    if normalized == v2Namespace || normalized.hasPrefix("\(v2Namespace)/") {
        return normalized
    }
    return "\(v2Namespace)\(normalized)"
}

extension URL {
    func normalizedV2ServerURL() -> URL {
        let components = URLComponents(url: self, resolvingAgainstBaseURL: false)
        guard var normalized = components else { return self }
        normalized.path = ""
        normalized.query = nil
        normalized.fragment = nil
        return normalized.url ?? self
    }
}

extension String {
    var v2URLPathComponentEncoded: String {
        let forbidden = CharacterSet(charactersIn: "/?#")
        return addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(forbidden)) ?? self
    }
}

extension DecodingError {
    var v2Description: String {
        switch self {
        case let .keyNotFound(key, context):
            return "The server response is missing '\(v2Path(context.codingPath + [key]))'."
        case let .typeMismatch(type, context):
            return "The server response has an invalid type at '\(v2Path(context.codingPath))' for \(type)."
        case let .valueNotFound(type, context):
            return "The server response is missing a value at '\(v2Path(context.codingPath))' for \(type)."
        case let .dataCorrupted(context):
            return "The server response could not be decoded at '\(v2Path(context.codingPath))'."
        @unknown default:
            return "The server response could not be decoded."
        }
    }

    func v2Path(_ codingPath: [CodingKey]) -> String {
        let value = codingPath.map(\.stringValue).joined(separator: ".")
        return value.isEmpty ? "<root>" : value
    }
}
