import Foundation

enum QwenRegion: String, CaseIterable, Identifiable {
    case mainland
    case singapore
    case us

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .mainland:
            "China Mainland"
        case .singapore:
            "Singapore"
        case .us:
            "US"
        }
    }

    var subtitle: String {
        switch self {
        case .mainland:
            "dashscope.aliyuncs.com"
        case .singapore:
            "dashscope-intl.aliyuncs.com"
        case .us:
            "dashscope-intl.aliyuncs.com"
        }
    }

    var baseURL: URL {
        switch self {
        case .mainland:
            URL(string: "https://dashscope.aliyuncs.com/compatible-mode/v1")!
        case .singapore, .us:
            URL(string: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1")!
        }
    }

    var asrModel: String {
        switch self {
        case .us:
            "qwen3-asr-flash-us"
        case .mainland, .singapore:
            "qwen3-asr-flash"
        }
    }

    var textModel: String {
        "qwen-plus"
    }
}

struct QwenClientConfiguration {
    let apiKey: String
    let region: QwenRegion

    var chatCompletionsURL: URL {
        region.baseURL
            .appendingPathComponent("chat")
            .appendingPathComponent("completions")
    }
}

