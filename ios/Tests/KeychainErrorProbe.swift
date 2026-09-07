import Foundation
import Security

// Compile alongside Stores/KeychainStore.swift. Exercises the NSError bridge
// used by the login UI without reading or writing the user's Keychain.
@main private struct KeychainErrorProbe {
    static func main() {
        for status in [errSecMissingEntitlement, errSecInteractionNotAllowed, errSecParam, errSecAuthFailed] {
            let error: Error = KeychainStoreError.unhandledStatus(status)
            let description = error.localizedDescription
            precondition(description.contains(String(status)), "The actual Keychain status was lost: \(description)")
            precondition(!description.contains("KeychainStoreError"), "An internal error type leaked into the login UI")
            precondition((error as NSError).localizedDescription == description)
        }
        print("Passed 4 Keychain error bridge checks; no credentials accessed.")
    }
}
