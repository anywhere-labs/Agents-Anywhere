import Foundation
import Security

enum KeychainStoreError: LocalizedError {
    case unhandledStatus(OSStatus)

    var errorDescription: String? {
        guard case let .unhandledStatus(status) = self else { return nil }
        // Status codes are identifiers, not locale-formatted numbers.
        let code = String(status)
        if status == errSecMissingEntitlement {
            return String(localized: "The app's signing configuration does not allow access to sign-in credentials in the Keychain (error \(code)).")
        }
        if let reason = SecCopyErrorMessageString(status, nil) as String? {
            return String(localized: "Could not access sign-in credentials in the Keychain (error \(code)): \(reason)")
        }
        return String(localized: "Could not access sign-in credentials in the Keychain (error \(code)).")
    }
}

struct KeychainStore {
    let service = "AgentsAnywhere"

    func readString(account: String) throws -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw KeychainStoreError.unhandledStatus(status) }
        guard let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    func saveString(_ value: String, account: String) throws {
        let data = Data(value.utf8)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var insert = query
            insert[kSecValueData as String] = data
            insert[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            let insertStatus = SecItemAdd(insert as CFDictionary, nil)
            guard insertStatus == errSecSuccess else {
                throw KeychainStoreError.unhandledStatus(insertStatus)
            }
            return
        }
        guard status == errSecSuccess else { throw KeychainStoreError.unhandledStatus(status) }
    }

    func delete(account: String) throws {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        let status = SecItemDelete(query as CFDictionary)
        if status == errSecItemNotFound { return }
        guard status == errSecSuccess else { throw KeychainStoreError.unhandledStatus(status) }
    }
}
