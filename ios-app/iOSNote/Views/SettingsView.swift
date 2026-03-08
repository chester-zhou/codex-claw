import SwiftUI

struct SettingsView: View {
    @Environment(\.dismiss) private var dismiss

    @ObservedObject var store: SettingsStore

    @State private var selectedRegion: QwenRegion
    @State private var apiKeyDraft: String
    @State private var revealAPIKey = false
    @State private var errorMessage: String?

    init(store: SettingsStore) {
        self.store = store
        _selectedRegion = State(initialValue: store.region)
        _apiKeyDraft = State(initialValue: store.apiKey)
    }

    var body: some View {
        NavigationStack {
            ZStack {
                LinearGradient(
                    colors: [
                        Color(red: 0.96, green: 0.94, blue: 0.90),
                        Color(red: 0.91, green: 0.88, blue: 0.83)
                    ],
                    startPoint: .topLeading,
                    endPoint: .bottomTrailing
                )
                .ignoresSafeArea()

                ScrollView(showsIndicators: false) {
                    VStack(alignment: .leading, spacing: 18) {
                        header
                        regionSection
                        keySection
                        if let errorMessage {
                            Text(errorMessage)
                                .font(.system(size: 14, weight: .semibold, design: .rounded))
                                .foregroundStyle(Color.red.opacity(0.86))
                                .padding(.horizontal, 4)
                        }
                    }
                    .padding(20)
                }
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("关闭") { dismiss() }
                }

                ToolbarItem(placement: .confirmationAction) {
                    Button("保存") {
                        save()
                    }
                    .fontWeight(.bold)
                }
            }
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("千问设置")
                .font(.system(size: 28, weight: .bold, design: .rounded))
                .foregroundStyle(Color.black.opacity(0.84))

            Text("语音转写会走 DashScope API。密钥只保存在当前设备的 Keychain。")
                .font(.system(size: 15, weight: .medium, design: .rounded))
                .foregroundStyle(Color.black.opacity(0.56))
        }
    }

    private var regionSection: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("地域")
                .font(.system(size: 15, weight: .bold, design: .rounded))
                .foregroundStyle(Color.black.opacity(0.72))

            ForEach(QwenRegion.allCases) { region in
                Button {
                    selectedRegion = region
                } label: {
                    HStack(alignment: .center, spacing: 12) {
                        Image(systemName: selectedRegion == region ? "largecircle.fill.circle" : "circle")
                            .font(.system(size: 18, weight: .semibold))
                            .foregroundStyle(selectedRegion == region ? Color.accentColor : Color.black.opacity(0.34))

                        VStack(alignment: .leading, spacing: 4) {
                            Text(region.displayName)
                                .font(.system(size: 16, weight: .semibold, design: .rounded))
                                .foregroundStyle(Color.black.opacity(0.82))

                            Text(region.subtitle)
                                .font(.system(size: 13, weight: .medium, design: .rounded))
                                .foregroundStyle(Color.black.opacity(0.50))
                        }

                        Spacer()
                    }
                    .padding(16)
                    .background(
                        RoundedRectangle(cornerRadius: 22, style: .continuous)
                            .fill(Color.white.opacity(0.78))
                    )
                }
                .buttonStyle(.plain)
            }
        }
    }

    private var keySection: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("DashScope API Key")
                .font(.system(size: 15, weight: .bold, design: .rounded))
                .foregroundStyle(Color.black.opacity(0.72))

            VStack(alignment: .leading, spacing: 12) {
                Group {
                    if revealAPIKey {
                        TextField("sk-...", text: $apiKeyDraft, axis: .vertical)
                            .apiKeyFieldStyle()
                    } else {
                        SecureField("sk-...", text: $apiKeyDraft)
                            .apiKeyFieldStyle()
                    }
                }

                Button(revealAPIKey ? "隐藏" : "显示") {
                    revealAPIKey.toggle()
                }
                .font(.system(size: 14, weight: .semibold, design: .rounded))
                .foregroundStyle(Color.black.opacity(0.64))
            }
            .padding(18)
            .background(
                RoundedRectangle(cornerRadius: 22, style: .continuous)
                    .fill(Color.white.opacity(0.82))
            )
        }
    }

    private func save() {
        do {
            try store.save(region: selectedRegion, apiKey: apiKeyDraft)
            dismiss()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

struct SettingsView_Previews: PreviewProvider {
    static var previews: some View {
        SettingsView(store: SettingsStore())
    }
}

private extension View {
    @ViewBuilder
    func apiKeyFieldStyle() -> some View {
#if os(iOS)
        self
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .font(.system(size: 15, weight: .medium, design: .monospaced))
            .foregroundStyle(Color.black.opacity(0.8))
#else
        self
            .font(.system(size: 15, weight: .medium, design: .monospaced))
            .foregroundStyle(Color.black.opacity(0.8))
#endif
    }
}
