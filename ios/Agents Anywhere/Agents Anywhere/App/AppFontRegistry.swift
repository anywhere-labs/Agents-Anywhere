import CoreText
import Foundation

@MainActor
enum AppFontRegistry {
    private static var registered = false

    /// Registers the bundled brand font with Core Text for the current process.
    static func registerBundledFonts() {
        guard !registered else { return }
        guard let fontURL = Bundle.main.url(
            forResource: "caveat_wght",
            withExtension: "ttf"
        ) else {
            preconditionFailure("Bundled Caveat font is missing")
        }

        var registrationError: Unmanaged<CFError>?
        let registrationSucceeded = CTFontManagerRegisterFontsForURL(
            fontURL as CFURL,
            .process,
            &registrationError
        )
        if !registrationSucceeded {
            let error = registrationError?.takeRetainedValue() as Error? as NSError?
            let fontWasAlreadyRegistered = error?.domain == kCTFontManagerErrorDomain as String
                && error?.code == CTFontManagerError.alreadyRegistered.rawValue
            guard fontWasAlreadyRegistered else {
                let description = error?.localizedDescription ?? "Unknown Core Text error"
                preconditionFailure("Unable to register bundled Caveat font: \(description)")
            }
        }
        registered = true
    }
}
