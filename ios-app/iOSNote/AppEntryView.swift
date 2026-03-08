import SwiftUI

struct AppEntryView: View {
    @Environment(\.scenePhase) private var scenePhase

    @StateObject private var storeProvider = AppStoreProvider()
    @State private var isSettingsPresented = false
    @State private var isCodexConnectionPresented = false
    @State private var isCodexMemoryInboxPresented = false

    var body: some View {
        CodexChatView(
            store: storeProvider.codexStore,
            settingsStore: storeProvider.settingsStore,
            onOpenConnectionSettings: { isCodexConnectionPresented = true },
            onOpenMemoryInbox: { isCodexMemoryInboxPresented = true },
            onOpenSettings: { isSettingsPresented = true }
        )
        .onChange(of: scenePhase) { _, newPhase in
            guard newPhase == .active else { return }
            storeProvider.codexStore.handleAppDidBecomeActive()
        }
        .sheet(isPresented: $isSettingsPresented) {
            SettingsView(store: storeProvider.settingsStore)
        }
        .sheet(isPresented: $isCodexConnectionPresented) {
            CodexConnectionView(store: storeProvider.codexStore)
        }
        .sheet(isPresented: $isCodexMemoryInboxPresented) {
            CodexMemoryInboxView(store: storeProvider.codexStore)
        }
    }
}

@MainActor
private final class AppStoreProvider: ObservableObject {
    lazy var settingsStore = SettingsStore()
    lazy var codexStore = CodexRemoteStore()
}

struct AppEntryView_Previews: PreviewProvider {
    static var previews: some View {
        AppEntryView()
    }
}
