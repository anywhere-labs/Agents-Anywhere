import Foundation

// MARK: - Overview
//
// ImageLoader fetches and caches images with task deduplication. When multiple requests for
// the same URL arrive concurrently, they share a single Task rather than creating redundant
// network requests.
//
// The actor ensures thread-safe access to the cache and ongoing tasks dictionary. Each
// request checks the cache first, then ongoing tasks, and only creates a new task if neither
// exists. Tasks are removed from the ongoing dictionary via defer after completion or failure.

actor ImageLoader {
  static let shared = ImageLoader()

  private let cache: NSCache<NSURL, Box<Image>>
  private let data: (URL) async throws -> (Data, URLResponse)
  private var ongoingTasks: [URL: Task<Image, Error>] = [:]

  init(session: URLSession = URLSession(configuration: .imageLoading)) {
    self.init(cache: NSCache(), data: session.data(from:))
  }

  init(
    cache: @autoclosure @Sendable () -> NSCache<NSURL, Box<Image>>,
    data: @escaping (URL) async throws -> (Data, URLResponse)
  ) {
    self.cache = cache()
    self.data = data
  }

  func image(for url: URL) async throws -> Image {
    // Check for a cached image
    if let image = self.cache.object(forKey: url as NSURL) {
      return image.wrappedValue
    }

    // Check for an ongoing task
    if let task = self.ongoingTasks[url] {
      return try await task.value
    }

    // Create a task
    let task = Task<Image, Error> {
      defer {
        // Remove ongoing task
        self.ongoingTasks.removeValue(forKey: url)
      }

      let (data, response) = try await self.data(url)

      // Notice that `data` and `file` URL schemes will not return `HTTPURLResponse`
      if let httpResponse = response as? HTTPURLResponse {
        guard 200..<300 ~= httpResponse.statusCode else {
          throw URLError(.badServerResponse)
        }
      }

      guard let image = Image(data: data) else {
        throw URLError(.cannotDecodeContentData)
      }

      // Cache image
      self.cache.setObject(Box(image), forKey: url as NSURL)

      return image
    }

    // Add ongoing task
    self.ongoingTasks[url] = task

    return try await task.value
  }
}

extension URLSessionConfiguration {
  fileprivate static var imageLoading: URLSessionConfiguration {
    let configuration = Self.default

    configuration.requestCachePolicy = .returnCacheDataElseLoad
    configuration.timeoutIntervalForRequest /= 2
    configuration.httpAdditionalHeaders = ["Accept": "image/*"]

    return configuration
  }
}
