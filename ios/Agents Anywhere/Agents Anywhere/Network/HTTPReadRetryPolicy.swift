import Foundation

nonisolated struct HTTPReadRetryPolicy {
    var maximumRetries = 2

    @MainActor func permitsRetry(_ error: Error) -> Bool {
        if let error = error as? URLError {
            return [.timedOut, .networkConnectionLost, .cannotConnectToHost, .dnsLookupFailed,
                    .cannotFindHost, .notConnectedToInternet].contains(error.code)
        }
        if let status = (error as? HTTPError)?.statusCode {
            return [408, 425, 429, 500, 502, 503, 504].contains(status)
        }
        return false
    }
}

enum V2MobileNetworking {
    static func configuration() -> URLSessionConfiguration {
        let config = URLSessionConfiguration.ephemeral
        config.waitsForConnectivity = true
        config.timeoutIntervalForRequest = 30
        config.timeoutIntervalForResource = 90
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.urlCache = nil
        // Cellular and Low Data Mode still support explicit reads/writes. The repository
        // exposes path cost so future views can defer optional media prefetching.
        config.allowsCellularAccess = true
        config.allowsExpensiveNetworkAccess = true
        config.allowsConstrainedNetworkAccess = true
        return config
    }
}
