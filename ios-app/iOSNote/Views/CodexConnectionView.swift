import SwiftUI

struct CodexConnectionView: View {
    @Environment(\.dismiss) private var dismiss

    @ObservedObject var store: CodexRemoteStore

    var body: some View {
        NavigationStack {
            Form {
                Section("Bridge") {
                    TextField("Relay URL", text: $store.relayURL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()

                    TextField("Bridge ID", text: $store.bridgeID)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()

                    TextField("设备名", text: $store.deviceName)
                }

                Section("TLS") {
                    TextField("证书 SHA256 指纹", text: $store.relayCertificateFingerprint)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()

                    Text("可选。留空时使用系统默认 TLS 校验；如果你有固定证书，也可以填 SHA256 指纹做 pinning，支持带或不带冒号。")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }

                Section("Pairing") {
                    TextField("Pairing Code", text: $store.pairingCode)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()

                    Button("提交一次性配对") {
                        store.pairDevice()
                    }

                    Text("这里只填写 Bridge 临时生成的一次性配对码。配对成功后不会持久化保存。")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }

                Section("状态") {
                    Text(store.connectionStatus)
                        .font(.system(size: 14, weight: .semibold, design: .rounded))
                }
            }
            .navigationTitle("Codex 连接")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("关闭") { dismiss() }
                }

                ToolbarItem(placement: .confirmationAction) {
                    Button("保存") {
                        store.saveConfiguration()
                        dismiss()
                    }
                }
            }
        }
    }
}
