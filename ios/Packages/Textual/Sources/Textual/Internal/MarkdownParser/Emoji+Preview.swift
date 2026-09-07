import Foundation

extension Set where Element == Emoji {
  static let previewEmoji: Self = [
    Emoji(
      shortcode: "doge",
      url: URL(
        string: "https://s3.masto.ai/custom_emojis/images/000/009/662/original/13cbe67b559a0b17.png"
      )!
    ),
    Emoji(
      shortcode: "dogroll",
      url: URL(
        string: "https://s3.masto.ai/custom_emojis/images/000/015/362/original/ef3d8a02071a8817.gif"
      )!
    ),
    Emoji(
      shortcode: "confused_dog",
      url: URL(
        string: "https://s3.masto.ai/custom_emojis/images/000/015/374/original/f2f9f6f06168baca.gif"
      )!
    ),
    Emoji(
      shortcode: "sad_dog",
      url: URL(
        string: "https://s3.masto.ai/custom_emojis/images/000/015/592/original/d1d6d0bac8777ac4.png"
      )!
    ),
  ]
}
