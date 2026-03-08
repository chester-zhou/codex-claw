import SwiftUI

struct ComposerPanel: View {
    @Binding var draft: String

    let isRecording: Bool
    let isTranscribing: Bool
    let onRecordTap: () -> Void
    let onSaveTap: () -> Void

    private var isBusy: Bool {
        isTranscribing
    }

    private var statusText: String? {
        if isRecording {
            return "录音中，点麦克风结束"
        }
        if isTranscribing {
            return "千问正在转文字"
        }
        return nil
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            if let statusText {
                HStack(spacing: 8) {
                    if isRecording {
                        Circle()
                            .fill(Color.red)
                            .frame(width: 8, height: 8)
                    } else {
                        ProgressView()
                            .controlSize(.small)
                    }

                    Text(statusText)
                        .font(.system(size: 13, weight: .semibold, design: .rounded))
                        .foregroundStyle(Color.black.opacity(0.62))
                }
                .padding(.horizontal, 2)
            }

            ZStack(alignment: .topLeading) {
                TextEditor(text: $draft)
                    .scrollContentBackground(.hidden)
                    .frame(minHeight: 118, maxHeight: 160)
                    .font(.system(size: 17, weight: .medium, design: .rounded))
                    .foregroundStyle(Color.black.opacity(0.84))
                    .disabled(isBusy)

                if draft.isEmpty {
                    Text("想到什么就写下来，或者先录一段。")
                        .font(.system(size: 17, weight: .medium, design: .rounded))
                        .foregroundStyle(Color.black.opacity(0.28))
                        .padding(.top, 8)
                        .padding(.leading, 6)
                        .allowsHitTesting(false)
                }
            }

            HStack(spacing: 10) {
                Spacer(minLength: 0)

                Button(action: onRecordTap) {
                    label(isRecording ? "结束" : "语音", systemImage: isRecording ? "stop.fill" : "mic.fill", filled: isRecording)
                }
                .disabled(isTranscribing)

                Button(action: onSaveTap) {
                    label("保存", systemImage: "arrow.up.circle.fill", filled: true)
                }
                .disabled(isBusy || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(18)
        .background(
            RoundedRectangle(cornerRadius: 30, style: .continuous)
                .fill(.ultraThinMaterial)
                .background(
                    RoundedRectangle(cornerRadius: 30, style: .continuous)
                        .fill(Color.white.opacity(0.58))
                )
        )
        .overlay(
            RoundedRectangle(cornerRadius: 30, style: .continuous)
                .stroke(Color.white.opacity(0.48), lineWidth: 1)
        )
        .shadow(color: Color.black.opacity(0.10), radius: 18, y: 8)
    }

    private func label(_ title: String, systemImage: String, filled: Bool) -> some View {
        HStack(spacing: 8) {
            Image(systemName: systemImage)
                .font(.system(size: 14, weight: .bold))

            Text(title)
                .font(.system(size: 14, weight: .bold, design: .rounded))
        }
        .foregroundStyle(filled ? Color.white : Color.black.opacity(0.72))
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .background(
            Capsule(style: .continuous)
                .fill(filled ? Color.black.opacity(0.86) : Color.white.opacity(0.70))
        )
    }
}

struct ComposerPanel_Previews: PreviewProvider {
    static var previews: some View {
        ComposerPanel(
            draft: .constant("周三把笔记应用的交互再收一下，保持输入足够轻。"),
            isRecording: false,
            isTranscribing: false,
            onRecordTap: {},
            onSaveTap: {}
        )
        .padding()
        .background(Color.orange.opacity(0.14))
    }
}
