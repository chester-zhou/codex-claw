import Combine
import Foundation

#if os(iOS)
import AVFoundation
#endif

enum AudioRecordingError: LocalizedError {
    case permissionDenied
    case failedToStart
    case noActiveRecording

    var errorDescription: String? {
        switch self {
        case .permissionDenied:
            "没有拿到麦克风权限。"
        case .failedToStart:
            "录音启动失败。"
        case .noActiveRecording:
            "当前没有进行中的录音。"
        }
    }
}

@MainActor
final class AudioRecordingService: NSObject, ObservableObject {
    @Published private(set) var isRecording = false

#if os(iOS)
    private var recorder: AVAudioRecorder?
    private var recordingURL: URL?

    func startRecording() async throws {
        try await ensurePermission()

        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .spokenAudio, options: [.defaultToSpeaker, .allowBluetooth])
        try session.setActive(true)

        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
            .appendingPathExtension("m4a")

        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: 16_000,
            AVNumberOfChannelsKey: 1,
            AVEncoderAudioQualityKey: AVAudioQuality.high.rawValue
        ]

        let recorder = try AVAudioRecorder(url: url, settings: settings)
        recorder.prepareToRecord()

        guard recorder.record() else {
            throw AudioRecordingError.failedToStart
        }

        self.recorder = recorder
        self.recordingURL = url
        isRecording = true
    }

    func stopRecording() throws -> RecordedAudio {
        guard let recorder, let recordingURL else {
            throw AudioRecordingError.noActiveRecording
        }

        recorder.stop()
        self.recorder = nil
        isRecording = false

        try AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])

        let data = try Data(contentsOf: recordingURL)
        self.recordingURL = nil
        return RecordedAudio(url: recordingURL, data: data, mimeType: "audio/m4a")
    }

    func cancelRecording() {
        recorder?.stop()
        recorder = nil
        if let recordingURL {
            try? FileManager.default.removeItem(at: recordingURL)
        }
        self.recordingURL = nil
        isRecording = false
        try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
    }

    private func ensurePermission() async throws {
        let session = AVAudioSession.sharedInstance()

        switch session.recordPermission {
        case .granted:
            return
        case .denied:
            throw AudioRecordingError.permissionDenied
        case .undetermined:
            let granted = await withCheckedContinuation { continuation in
                session.requestRecordPermission { allowed in
                    continuation.resume(returning: allowed)
                }
            }
            guard granted else {
                throw AudioRecordingError.permissionDenied
            }
        @unknown default:
            throw AudioRecordingError.permissionDenied
        }
    }
#else
    func startRecording() async throws {
        throw AudioRecordingError.permissionDenied
    }

    func stopRecording() throws -> RecordedAudio {
        throw AudioRecordingError.noActiveRecording
    }

    func cancelRecording() {}
#endif
}
