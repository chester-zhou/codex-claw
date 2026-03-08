import Combine
import Foundation

@MainActor
final class SettingsStore: ObservableObject {
    @Published var region: QwenRegion
    @Published var apiKey: String

    private let userDefaults: UserDefaults
    private let keychain: KeychainStore

    private enum Keys {
        static let region = "qwen.region"
        static let apiKey = "qwen.apiKey"
    }

    init(
        userDefaults: UserDefaults = .standard,
        keychain: KeychainStore = .shared
    ) {
        self.userDefaults = userDefaults
        self.keychain = keychain

        let rawRegion = userDefaults.string(forKey: Keys.region)
        region = QwenRegion(rawValue: rawRegion ?? "") ?? .mainland
        apiKey = keychain.string(for: Keys.apiKey) ?? ""
    }

    var configuration: QwenClientConfiguration? {
        let trimmedKey = apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedKey.isEmpty else { return nil }
        return QwenClientConfiguration(apiKey: trimmedKey, region: region)
    }

    func save(region: QwenRegion, apiKey: String) throws {
        self.region = region
        self.apiKey = apiKey

        userDefaults.set(region.rawValue, forKey: Keys.region)

        let trimmedKey = apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmedKey.isEmpty {
            try keychain.remove(Keys.apiKey)
        } else {
            try keychain.set(trimmedKey, for: Keys.apiKey)
        }
    }
}
