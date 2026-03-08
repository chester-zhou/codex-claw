import Foundation

struct Note: Identifiable, Codable, Equatable {
    let id: UUID
    var content: String
    let createdAt: Date
    var updatedAt: Date

    init(
        id: UUID = UUID(),
        content: String,
        createdAt: Date = .now,
        updatedAt: Date = .now
    ) {
        self.id = id
        self.content = content.trimmingCharacters(in: .whitespacesAndNewlines)
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }

    var tags: [String] {
        NoteTagExtractor.tags(in: content)
    }

    var dedupKey: String {
        Self.dedupKey(content: content, createdAt: createdAt)
    }

    static func dedupKey(content: String, createdAt: Date) -> String {
        let timestamp = Int(createdAt.timeIntervalSince1970.rounded())
        let normalized = content
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current)
            .lowercased()

        return "\(timestamp)|\(normalized)"
    }

    static func canonicalTag(_ tag: String) -> String {
        tag
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current)
            .lowercased()
    }
}

private enum NoteTagExtractor {
    static let regex = try! NSRegularExpression(pattern: #"(?<!\S)#([^#\s]+)"#)
    static let trailingPunctuation = CharacterSet(charactersIn: #",.!?;:'"”’)]}，。！？；：、）》」』】"#)

    static func tags(in text: String) -> [String] {
        let nsText = text as NSString
        let matches = regex.matches(in: text, range: NSRange(location: 0, length: nsText.length))

        var seen = Set<String>()
        var tags: [String] = []

        for match in matches where match.numberOfRanges > 1 {
            var tag = nsText.substring(with: match.range(at: 1))
                .trimmingCharacters(in: trailingPunctuation)

            while tag.hasSuffix("/") {
                tag.removeLast()
            }

            guard !tag.isEmpty else { continue }

            let key = Note.canonicalTag(tag)
            guard seen.insert(key).inserted else { continue }
            tags.append(tag)
        }

        return tags
    }
}
