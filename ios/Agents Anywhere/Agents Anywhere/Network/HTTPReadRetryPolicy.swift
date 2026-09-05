import Foundation

nonisolated struct HTTPReadRetryPolicy {
    var maximumRetries = 2

    func delay(from header: String?, now: Date = Date()) -> TimeInterval? {
        guard let header else { return nil }
        if let seconds = TimeInterval(header) { return max(0, seconds) }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "EEE, dd MMM yyyy HH:mm:ss zzz"
        return formatter.date(from: header).map { max(0, $0.timeIntervalSince(now)) }
    }

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
