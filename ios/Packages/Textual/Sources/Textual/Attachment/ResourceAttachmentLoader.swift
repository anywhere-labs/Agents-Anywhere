import SwiftUI

/// An attachment loader that resolves images from the app bundle.
///
/// This loader maps a URL to an asset name and builds an attachment from the named image.
///
/// You can’t create `ResourceAttachmentLoader` directly. Use
/// ``AttachmentLoader/image(named:in:)`` and ``AttachmentLoader/emoji(named:in:)`` instead.
public struct ResourceAttachmentLoader<Content: Attachment>: AttachmentLoader {
  private let name: @Sendable (URL) -> String
  private let bundle: Bundle?
  private let content: @Sendable (String, Bundle?, String, ColorEnvironmentValues) -> Content

  fileprivate init(
    name: @Sendable @escaping (URL) -> String,
    bundle: Bundle?,
    content: @Sendable @escaping (String, Bundle?, String, ColorEnvironmentValues) -> Content
  ) {
    self.name = name
    self.bundle = bundle
    self.content = content
  }

  public func attachment(
    for url: URL,
    text: String,
    environment: ColorEnvironmentValues
  ) async throws -> some Attachment {
    content(name(url), bundle, text, environment)
  }
}

extension AttachmentLoader where Self == ResourceAttachmentLoader<ImageResourceAttachment> {
  /// Resolves image URLs into named images from a bundle.
  ///
  /// Use this when your markup references local images (for example `resource://logo`) and you
  /// want to load them from your app bundle.
  ///
  /// - Parameters:
  ///   - name: A closure that maps a URL to a resource name.
  ///   - bundle: The bundle to look up the resource in. The default is `nil`, which uses the
  ///     main bundle.
  public static func image(
    named name: @escaping @Sendable (URL) -> String,
    in bundle: Bundle? = nil
  ) -> Self {
    .init(
      name: name,
      bundle: bundle,
      content: ImageResourceAttachment.init(name:bundle:text:environment:)
    )
  }
}

extension AttachmentLoader where Self == ResourceAttachmentLoader<EmojiResourceAttachment> {
  /// Resolves custom emoji URLs into named images from a bundle.
  ///
  /// - Parameters:
  ///   - name: A closure that maps a URL to a resource name.
  ///   - bundle: The bundle to look up the resource in. The default is `nil`, which uses the
  ///     main bundle.
  public static func emoji(
    named name: @escaping @Sendable (URL) -> String,
    in bundle: Bundle? = nil
  ) -> Self {
    .init(
      name: name,
      bundle: bundle,
      content: EmojiResourceAttachment.init(name:bundle:text:environment:)
    )
  }
}
