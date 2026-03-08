import Foundation
import Security

enum KeychainStoreError: LocalizedError {
    case unexpectedStatus(OSStatus)

    var errorDescription: String? {
        switch self {
        case .unexpectedStatus(let status):
            "Keychain 访问失败，状态码：\(status)"
        }
    }
}

final class KeychainStore: @unchecked Sendable {
    static let shared = KeychainStore(service: "com.chesterzhou.iOSNote")

    private let service: String

    init(service: String) {
        self.service = service
    }

    func string(for account: String) -> String? {
        var query = baseQuery(for: account)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)

        guard status != errSecItemNotFound else { return nil }
        guard status == errSecSuccess else { return nil }

        guard
            let data = result as? Data,
            let string = String(data: data, encoding: .utf8)
        else {
            return nil
        }

        return string
    }

    func set(_ value: String, for account: String) throws {
        let data = Data(value.utf8)
        let query = baseQuery(for: account)
        let attributes = [kSecValueData as String: data]

        let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        switch status {
        case errSecSuccess:
            return
        case errSecItemNotFound:
            var insertion = query
            insertion[kSecValueData as String] = data
            let addStatus = SecItemAdd(insertion as CFDictionary, nil)
            guard addStatus == errSecSuccess else {
                throw KeychainStoreError.unexpectedStatus(addStatus)
            }
        default:
            throw KeychainStoreError.unexpectedStatus(status)
        }
    }

    func remove(_ account: String) throws {
        let status = SecItemDelete(baseQuery(for: account) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw KeychainStoreError.unexpectedStatus(status)
        }
    }

    private func baseQuery(for account: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
    }
}
