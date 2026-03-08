import Foundation

enum QwenClientError: LocalizedError {
    case invalidResponse
    case emptyResponse
    case api(message: String)

    var errorDescription: String? {
        switch self {
        case .invalidResponse:
            "千问接口返回了无法识别的数据。"
        case .emptyResponse:
            "千问接口没有返回可用文本。"
        case .api(let message):
            message
        }
    }
}

final class QwenClient {
    private let session: URLSession

    init(session: URLSession = .shared) {
        self.session = session
    }

    func transcribe(audio: RecordedAudio, using configuration: QwenClientConfiguration) async throws -> String {
        let dataURL = "data:\(audio.mimeType);base64,\(audio.data.base64EncodedString())"
        let requestBody = ASRRequest(
            model: configuration.region.asrModel,
            messages: [
                .init(
                    role: "user",
                    content: [
                        .inputAudio(dataURL)
                    ]
                )
            ],
            stream: false,
            asrOptions: .init(language: "zh", enableITN: true)
        )

        let response = try await performRequest(requestBody, configuration: configuration)
        let text = response.primaryText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else {
            throw QwenClientError.emptyResponse
        }
        return text
    }

    func polish(text: String, using configuration: QwenClientConfiguration) async throws -> String {
        let requestBody = TextRequest(
            model: configuration.region.textModel,
            messages: [
                .init(
                    role: "system",
                    content: """
                    你是一个克制的中文笔记编辑。请只做轻量整理：
                    1. 保留原意
                    2. 补足必要标点
                    3. 删除明显口头禅和重复
                    4. 不要扩写，不要加标题，不要解释
                    """
                ),
                .init(role: "user", content: text)
            ],
            temperature: 0.2,
            stream: false
        )

        let response = try await performRequest(requestBody, configuration: configuration)
        let polished = response.primaryText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !polished.isEmpty else {
            throw QwenClientError.emptyResponse
        }
        return polished
    }

    private func performRequest<T: Encodable>(
        _ body: T,
        configuration: QwenClientConfiguration
    ) async throws -> CompletionResponse {
        var request = URLRequest(url: configuration.chatCompletionsURL)
        request.httpMethod = "POST"
        request.timeoutInterval = 90
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(configuration.apiKey)", forHTTPHeaderField: "Authorization")
        request.httpBody = try JSONEncoder().encode(body)

        let (data, urlResponse) = try await session.data(for: request)

        guard let httpResponse = urlResponse as? HTTPURLResponse else {
            throw QwenClientError.invalidResponse
        }

        guard (200...299).contains(httpResponse.statusCode) else {
            let errorPayload = try? JSONDecoder().decode(APIErrorResponse.self, from: data)
            let message = errorPayload?.resolvedMessage ?? "千问请求失败，HTTP \(httpResponse.statusCode)"
            throw QwenClientError.api(message: message)
        }

        do {
            return try JSONDecoder().decode(CompletionResponse.self, from: data)
        } catch {
            throw QwenClientError.invalidResponse
        }
    }
}

private struct TextRequest: Encodable {
    let model: String
    let messages: [TextMessage]
    let temperature: Double
    let stream: Bool
}

private struct TextMessage: Encodable {
    let role: String
    let content: String
}

private struct ASRRequest: Encodable {
    let model: String
    let messages: [ASRMessage]
    let stream: Bool
    let asrOptions: ASROptions

    enum CodingKeys: String, CodingKey {
        case model
        case messages
        case stream
        case asrOptions = "asr_options"
    }
}

private struct ASRMessage: Encodable {
    let role: String
    let content: [ASRContent]
}

private struct ASRContent: Encodable {
    let type: String
    let inputAudio: InputAudio?

    enum CodingKeys: String, CodingKey {
        case type
        case inputAudio = "input_audio"
    }

    static func inputAudio(_ dataURL: String) -> ASRContent {
        ASRContent(type: "input_audio", inputAudio: InputAudio(data: dataURL))
    }
}

private struct InputAudio: Encodable {
    let data: String
}

private struct ASROptions: Encodable {
    let language: String
    let enableITN: Bool

    enum CodingKeys: String, CodingKey {
        case language
        case enableITN = "enable_itn"
    }
}

private struct CompletionResponse: Decodable {
    let choices: [Choice]

    struct Choice: Decodable {
        let message: Message
    }

    struct Message: Decodable {
        let content: MessageContent
    }

    var primaryText: String {
        choices.first?.message.content.text ?? ""
    }
}

private enum MessageContent: Decodable {
    case string(String)
    case parts([MessagePart])

    var text: String {
        switch self {
        case .string(let value):
            value
        case .parts(let parts):
            parts
                .compactMap(\.text)
                .joined(separator: "\n")
        }
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let stringValue = try? container.decode(String.self) {
            self = .string(stringValue)
        } else if let partValues = try? container.decode([MessagePart].self) {
            self = .parts(partValues)
        } else {
            throw DecodingError.typeMismatch(
                MessageContent.self,
                .init(codingPath: decoder.codingPath, debugDescription: "Unsupported response content")
            )
        }
    }
}

private struct MessagePart: Decodable {
    let type: String?
    let text: String?
}

private struct APIErrorResponse: Decodable {
    let error: NestedError?
    let code: String?
    let message: String?

    struct NestedError: Decodable {
        let message: String?
        let code: String?
    }

    var resolvedMessage: String? {
        if let nested = error?.message, !nested.isEmpty {
            return nested
        }
        if let message, !message.isEmpty {
            return message
        }
        if let nestedCode = error?.code, !nestedCode.isEmpty {
            return nestedCode
        }
        return code
    }
}

