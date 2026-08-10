import Foundation

struct EmptyRequestBody: Encodable {}

struct EmptyResponse: Decodable {}

struct HTTPUploadFile: Hashable {
    let fieldName: String
    let fileName: String
    let mediaType: String
    let data: Data
}

struct HTTPUploadRequest<Response: Decodable> {
    let path: String
    let files: [HTTPUploadFile]
    let requiresAuth: Bool

    init(path: String, files: [HTTPUploadFile], requiresAuth: Bool = true) {
        self.path = path
        self.files = files
        self.requiresAuth = requiresAuth
    }
}

struct HTTPRequest<Body: Encodable, Response: Decodable> {
    let method: HTTPMethod
    let path: String
    let queryItems: [URLQueryItem]
    let body: Body?
    let requiresAuth: Bool

    init(
        method: HTTPMethod,
        path: String,
        queryItems: [URLQueryItem] = [],
        body: Body? = nil,
        requiresAuth: Bool = true
    ) {
        self.method = method
        self.path = path
        self.queryItems = queryItems
        self.body = body
        self.requiresAuth = requiresAuth
    }
}

extension HTTPRequest where Body == EmptyRequestBody {
    init(
        method: HTTPMethod,
        path: String,
        queryItems: [URLQueryItem] = [],
        requiresAuth: Bool = true
    ) {
        self.method = method
        self.path = path
        self.queryItems = queryItems
        self.body = nil
        self.requiresAuth = requiresAuth
    }
}
