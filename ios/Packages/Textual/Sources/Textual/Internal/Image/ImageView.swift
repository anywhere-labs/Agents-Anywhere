import SwiftUI

struct ImageView: View {
  private let content: Image

  init(_ content: Image) {
    self.content = content
  }

  var body: some View {
    if content.isAnimated {
      AnimatedImageView(content)
    } else {
      SwiftUI.Image(decorative: content.cgImage, scale: 1.0)
        .resizable()
    }
  }
}

// MARK: - AnimatedImageView

private struct AnimatedImageView: View {
  @State private var clock: AnimationClock

  private let content: Image

  init(_ content: Image) {
    self._clock = State(initialValue: .init(image: content))
    self.content = content
  }

  var body: some View {
    TimelineView(.animation) { context in
      let index = clock.frameIndex(at: context.date)
      let frame = content.frames[index].cgImage

      SwiftUI.Image(decorative: frame, scale: 1.0)
        .resizable()
    }
    .onChange(of: content) { _, newValue in
      clock = AnimationClock(image: newValue)
    }
  }
}

// MARK: - AnimationClock
//
// AnimationClock maps elapsed time to frame indices. The Schedule pre-computes cumulative
// frame start times and uses binary search for efficient frame lookup.
//
// loopCount semantics: 0 means infinite looping, >0 means loop that many times then freeze
// on the last frame.

private struct AnimationClock: Sendable {
  private let referenceDate: Date
  private let schedule: Schedule
  private let loopCount: Int

  init(image: Image, referenceDate: Date = .init()) {
    self.referenceDate = referenceDate
    self.schedule = Schedule(delayTimes: image.frames.map(\.delayTime))
    self.loopCount = image.loopCount
  }

  func frameIndex(at date: Date) -> Int {
    guard schedule.numberOfFrames > 0 else { return 0 }

    let elapsedSinceStart = max(0, date.timeIntervalSince(referenceDate))

    if loopCount > 0 {
      let totalAnimationDuration = schedule.cycleDuration * TimeInterval(loopCount)

      if elapsedSinceStart >= totalAnimationDuration {
        // freeze on last frame
        return schedule.numberOfFrames - 1
      }
    }

    let elapsedWithinCycle = elapsedSinceStart.truncatingRemainder(
      dividingBy: schedule.cycleDuration
    )
    return schedule.frameIndex(forElapsedTime: elapsedWithinCycle)
  }
}

extension AnimationClock {
  private struct Schedule: Sendable {
    var numberOfFrames: Int {
      max(0, startTimes.count - 1)
    }

    let cycleDuration: TimeInterval

    private let startTimes: [TimeInterval]

    init(delayTimes: [TimeInterval]) {
      var startTimes: [TimeInterval] = [0]
      startTimes.reserveCapacity(delayTimes.count + 1)

      var accumulatedTime: TimeInterval = 0
      for delayTime in delayTimes {
        accumulatedTime += max(0, delayTime)
        startTimes.append(accumulatedTime)
      }

      self.startTimes = startTimes
      self.cycleDuration = max(accumulatedTime, .leastNonzeroMagnitude)
    }

    func frameIndex(forElapsedTime elapsedTime: TimeInterval) -> Int {
      var lowerBound = 0
      var upperBound = startTimes.count - 1
      while lowerBound < upperBound {
        let candidate = (lowerBound + upperBound + 1) / 2
        if startTimes[candidate] <= elapsedTime {
          lowerBound = candidate
        } else {
          upperBound = candidate - 1
        }
      }
      return min(lowerBound, numberOfFrames - 1)
    }
  }
}

// MARK: - Preview

#Preview("JPEG") {
  @Previewable @State var image: Image?

  Group {
    if let image {
      ImageView(image)
        .aspectRatio(contentMode: .fit)
        .frame(width: image.size.width)
    } else {
      Color.clear
    }
  }
  .task {
    image = try? await ImageLoader.shared.image(
      for: URL(string: "https://picsum.photos/id/91/400/300")!
    )
  }
}

#Preview("GIF") {
  @Previewable @State var image: Image?

  Group {
    if let image {
      ImageView(image)
        .aspectRatio(contentMode: .fit)
        .frame(width: image.size.width)
    } else {
      Color.clear
    }
  }
  .task {
    image = try? await ImageLoader.shared.image(
      for: URL(
        string:
          "https://user-images.githubusercontent.com/373190/209442987-2aa9d73d-3bf2-46cb-b03a-5d9c0ab8475f.gif"
      )!
    )
  }
}

#Preview("APNG") {
  @Previewable @State var image: Image?

  Group {
    if let image {
      ImageView(image)
        .aspectRatio(contentMode: .fit)
        .frame(width: image.size.width)
    } else {
      Color.clear
    }
  }
  .task {
    image = try? await ImageLoader.shared.image(
      for: URL(
        string:
          "https://s3.masto.ai/custom_emojis/images/000/014/970/original/807d7387e4b3bf5f.png"
      )!
    )
  }
}

#Preview("webP") {
  @Previewable @State var image: Image?

  Group {
    if let image {
      ImageView(image)
        .aspectRatio(contentMode: .fit)
        .frame(width: image.size.width)
    } else {
      Color.clear
    }
  }
  .task {
    image = try? await ImageLoader.shared.image(
      for: URL(string: "https://mathiasbynens.be/demo/animated-webp-supported.webp")!
    )
  }
}

#Preview("HEIC") {
  @Previewable @State var image: Image?

  Group {
    if let image {
      ImageView(image)
        .aspectRatio(contentMode: .fit)
        .frame(width: image.size.width)
    } else {
      Color.clear
    }
  }
  .task {
    image = try? await ImageLoader.shared.image(
      for: URL(
        string:
          "https://nokiatech.github.io/heif/content/image_sequences/starfield_animation.heic"
      )!
    )
  }
}
