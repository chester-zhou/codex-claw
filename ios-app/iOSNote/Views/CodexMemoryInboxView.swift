import SwiftUI

struct CodexMemoryInboxView: View {
    @Environment(\.dismiss) private var dismiss

    @ObservedObject var store: CodexRemoteStore

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    ForEach(store.memoryInbox) { entry in
                        VStack(alignment: .leading, spacing: 8) {
                            HStack {
                                Text(entry.workspaceName)
                                    .font(.system(size: 14, weight: .bold, design: .rounded))

                                Spacer()

                                Text(shortTimestamp(entry.timestamp))
                                    .font(.system(size: 11, weight: .semibold, design: .rounded))
                                    .foregroundStyle(Color.black.opacity(0.42))
                            }

                            Text(entry.userText)
                                .font(.system(size: 15, weight: .bold, design: .rounded))
                                .foregroundStyle(Color.black.opacity(0.84))

                            Text(entry.assistantSummary)
                                .font(.system(size: 14, weight: .medium, design: .rounded))
                                .foregroundStyle(Color.black.opacity(0.72))

                            if !entry.openLoops.isEmpty {
                                VStack(alignment: .leading, spacing: 4) {
                                    ForEach(entry.openLoops, id: \.self) { loop in
                                        Text("待续: \(loop)")
                                            .font(.system(size: 12, weight: .semibold, design: .rounded))
                                            .foregroundStyle(Color.black.opacity(0.56))
                                    }
                                }
                            }

                            if let source = entry.source {
                                Text(source)
                                    .font(.system(size: 11, weight: .bold, design: .rounded))
                                    .foregroundStyle(Color.black.opacity(0.36))
                            }
                        }
                        .padding(16)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(
                            RoundedRectangle(cornerRadius: 22, style: .continuous)
                                .fill(Color.white.opacity(0.76))
                        )
                    }
                }
                .padding(20)
            }
            .background(Color(red: 0.95, green: 0.94, blue: 0.91).ignoresSafeArea())
            .navigationTitle("Memory Inbox")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("关闭") { dismiss() }
                }

                ToolbarItem(placement: .confirmationAction) {
                    Button("刷新") {
                        store.loadMemoryInbox()
                    }
                    .disabled(!store.isConnected)
                }
            }
            .onAppear {
                store.loadMemoryInbox()
            }
        }
    }

    private func shortTimestamp(_ value: String) -> String {
        guard let date = ISO8601DateFormatter().date(from: value) else { return value }
        return date.formatted(.dateTime.month().day().hour().minute())
    }
}
