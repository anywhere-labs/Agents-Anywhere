import SwiftUI

@usableFromInline
struct ImageResourceAttachment: Attachment {
  @usableFromInline
  var description: String {
    text.isEmpty ? name : text
  }

  private let name: String
  private let bundle: Bundle?
  private let text: String
  private let image: SwiftUI.Image
  private let size: CGSize

  init(
    name: String,
    bundle: Bundle?,
    text: String,
    environment: ColorEnvironmentValues
  ) {
    self.name = name
    self.bundle = bundle
    self.text = text

    let platformImage =
      PlatformImage.resolve(
        name,
        bundle: bundle,
        environment: environment
      ) ?? .init()

    self.image = .init(platformImage)
    self.size = platformImage.size
  }

  @usableFromInline
  var body: some View {
    image
      .resizable()
      .aspectRatio(contentMode: .fit)
  }

  @usableFromInline
  func sizeThatFits(_ proposal: ProposedViewSize, in _: TextEnvironmentValues) -> CGSize {
    guard let proposedWidth = proposal.width else {
      return size
    }

    let aspect = size.width / size.height
    let width = min(proposedWidth, size.width)
    let height = width / aspect

    return CGSize(width: width, height: height)
  }

  @usableFromInline
  static func == (lhs: Self, rhs: Self) -> Bool {
    lhs.name == rhs.name && lhs.bundle == rhs.bundle && lhs.text == rhs.text
  }

  @usableFromInline
  func hash(into hasher: inout Hasher) {
    hasher.combine(name)
    hasher.combine(bundle)
    hasher.combine(text)
  }
}
