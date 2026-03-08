import Foundation

enum FlomoImportError: LocalizedError {
    case unreadableFile
    case unsupportedEncoding
    case noMemoFound

    var errorDescription: String? {
        switch self {
        case .unreadableFile:
            "读取 flomo 导出文件失败。"
        case .unsupportedEncoding:
            "无法识别 flomo 导出文件编码。"
        case .noMemoFound:
            "没有从这个 HTML 文件里识别到 flomo memo。"
        }
    }
}

final class FlomoImportService {
    private let memoDivRegex = try! NSRegularExpression(
        pattern: #"<div\b[^>]*class=["'][^"']*\bmemo\b[^"']*["'][^>]*>"#,
        options: [.caseInsensitive]
    )
    private let divTagRegex = try! NSRegularExpression(
        pattern: #"<div\b[^>]*>|</div>"#,
        options: [.caseInsensitive]
    )

    func parse(url: URL) throws -> [ImportedNoteDraft] {
        let accessed = url.startAccessingSecurityScopedResource()
        defer {
            if accessed {
                url.stopAccessingSecurityScopedResource()
            }
        }

        let data: Data
        do {
            data = try Data(contentsOf: url)
        } catch {
            throw FlomoImportError.unreadableFile
        }

        guard let html = decodeHTML(from: data) else {
            throw FlomoImportError.unsupportedEncoding
        }

        let memos = memoBlocks(in: html).compactMap(parseMemoBlock(_:))
        guard !memos.isEmpty else {
            throw FlomoImportError.noMemoFound
        }

        return memos.sorted { $0.createdAt > $1.createdAt }
    }

    private func decodeHTML(from data: Data) -> String? {
        let encodings: [String.Encoding] = [
            .utf8,
            .unicode,
            .utf16,
            .utf16LittleEndian,
            .utf16BigEndian,
            .init(
                rawValue: CFStringConvertEncodingToNSStringEncoding(
                    CFStringEncoding(CFStringEncodings.GB_18030_2000.rawValue)
                )
            )
        ]

        for encoding in encodings {
            if let string = String(data: data, encoding: encoding) {
                return string
            }
        }

        return nil
    }

    private func memoBlocks(in html: String) -> [String] {
        let nsHTML = html as NSString
        let matches = memoDivRegex.matches(in: html, range: NSRange(location: 0, length: nsHTML.length))

        return matches.compactMap { match in
            guard let blockRange = balancedDivRange(in: html, openingTagRange: match.range) else {
                return nil
            }
            return nsHTML.substring(with: blockRange)
        }
    }

    private func parseMemoBlock(_ block: String) -> ImportedNoteDraft? {
        let contentHTML = innerHTML(forAnyClass: ["content", "memo-content"], in: block) ?? block
        let content = plainText(fromHTML: contentHTML)
        guard !content.isEmpty else { return nil }

        let timeHTML = innerHTML(forAnyClass: ["time", "memo-time"], in: block) ?? ""
        let timeText = plainText(fromHTML: timeHTML)
        let createdAt = parseDate(from: timeText) ?? .now

        return ImportedNoteDraft(content: content, createdAt: createdAt)
    }

    private func innerHTML(forAnyClass classes: [String], in html: String) -> String? {
        for className in classes {
            if let html = innerHTML(forClass: className, in: html) {
                return html
            }
        }
        return nil
    }

    private func innerHTML(forClass className: String, in html: String) -> String? {
        let escapedClassName = NSRegularExpression.escapedPattern(for: className)
        let regex = try! NSRegularExpression(
            pattern: #"<div\b[^>]*class=["'][^"']*\b\#(escapedClassName)\b[^"']*["'][^>]*>"#,
            options: [.caseInsensitive]
        )

        let nsHTML = html as NSString
        guard
            let match = regex.firstMatch(in: html, range: NSRange(location: 0, length: nsHTML.length)),
            let blockRange = balancedDivRange(in: html, openingTagRange: match.range)
        else {
            return nil
        }

        let innerLocation = match.range.location + match.range.length
        let innerLength = blockRange.location + blockRange.length - innerLocation - 6
        guard innerLength > 0 else { return nil }

        return nsHTML.substring(with: NSRange(location: innerLocation, length: innerLength))
    }

    private func balancedDivRange(in html: String, openingTagRange: NSRange) -> NSRange? {
        let nsHTML = html as NSString
        let searchStart = openingTagRange.location + openingTagRange.length
        let searchRange = NSRange(location: searchStart, length: nsHTML.length - searchStart)

        var depth = 1
        var resolvedRange: NSRange?

        divTagRegex.enumerateMatches(in: html, range: searchRange) { match, _, stop in
            guard let match else { return }
            let tag = nsHTML.substring(with: match.range).lowercased()
            if tag.hasPrefix("</div") {
                depth -= 1
            } else {
                depth += 1
            }

            if depth == 0 {
                resolvedRange = NSRange(
                    location: openingTagRange.location,
                    length: match.range.location + match.range.length - openingTagRange.location
                )
                stop.pointee = true
            }
        }

        return resolvedRange
    }

    private func plainText(fromHTML html: String) -> String {
        var prepared = html
        prepared = prepared.replacingOccurrences(
            of: #"<img\b[^>]*src=["']([^"']+)["'][^>]*>"#,
            with: "<p>[图片] $1</p>",
            options: .regularExpression
        )
        prepared = prepared.replacingOccurrences(
            of: #"<audio\b[^>]*src=["']([^"']+)["'][^>]*>"#,
            with: "<p>[音频] $1</p>",
            options: .regularExpression
        )
        prepared = prepared.replacingOccurrences(
            of: #"<video\b[^>]*src=["']([^"']+)["'][^>]*>"#,
            with: "<p>[视频] $1</p>",
            options: .regularExpression
        )
        prepared = prepared.replacingOccurrences(
            of: #"<br\s*/?>"#,
            with: "\n",
            options: [.regularExpression, .caseInsensitive]
        )
        prepared = prepared.replacingOccurrences(
            of: #"</p\s*>"#,
            with: "\n",
            options: [.regularExpression, .caseInsensitive]
        )
        prepared = prepared.replacingOccurrences(
            of: #"</li\s*>"#,
            with: "\n",
            options: [.regularExpression, .caseInsensitive]
        )

        prepared = prepared.replacingOccurrences(of: "&nbsp;", with: " ")
        let stripped = prepared.replacingOccurrences(of: #"<[^>]+>"#, with: "", options: .regularExpression)
        let decoded = decodeHTMLEntities(in: stripped)
        return normalizePlainText(decoded)
    }

    private func normalizePlainText(_ text: String) -> String {
        text
            .replacingOccurrences(of: "\u{00a0}", with: " ")
            .components(separatedBy: .newlines)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .reduce(into: [String]()) { lines, line in
                if line.isEmpty {
                    if lines.last?.isEmpty == false {
                        lines.append("")
                    }
                } else {
                    lines.append(line)
                }
            }
            .joined(separator: "\n")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func parseDate(from rawText: String) -> Date? {
        let candidate = rawText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !candidate.isEmpty else { return nil }

        let formats = [
            "yyyy-MM-dd HH:mm:ss",
            "yyyy-MM-dd HH:mm",
            "yyyy/MM/dd HH:mm:ss",
            "yyyy/MM/dd HH:mm"
        ]

        for format in formats {
            let formatter = DateFormatter()
            formatter.locale = Locale(identifier: "en_US_POSIX")
            formatter.timeZone = .current
            formatter.dateFormat = format
            if let date = formatter.date(from: candidate) {
                return date
            }
        }

        return nil
    }

    private func decodeHTMLEntities(in text: String) -> String {
        var decoded = text

        let namedEntities = [
            "&amp;": "&",
            "&lt;": "<",
            "&gt;": ">",
            "&quot;": "\"",
            "&#39;": "'",
            "&apos;": "'",
            "&nbsp;": " "
        ]

        for (entity, replacement) in namedEntities {
            decoded = decoded.replacingOccurrences(of: entity, with: replacement)
        }

        let regex = try! NSRegularExpression(pattern: #"&#(x?[0-9A-Fa-f]+);"#)
        let nsDecoded = decoded as NSString
        let matches = regex.matches(in: decoded, range: NSRange(location: 0, length: nsDecoded.length)).reversed()
        var mutable = decoded

        for match in matches where match.numberOfRanges > 1 {
            let token = nsDecoded.substring(with: match.range(at: 1))
            let scalarValue: UInt32?

            if token.lowercased().hasPrefix("x") {
                scalarValue = UInt32(token.dropFirst(), radix: 16)
            } else {
                scalarValue = UInt32(token, radix: 10)
            }

            guard
                let value = scalarValue,
                let scalar = UnicodeScalar(value)
            else {
                continue
            }

            let replacement = String(Character(scalar))
            let range = Range(match.range, in: mutable)!
            mutable.replaceSubrange(range, with: replacement)
        }

        return mutable
    }
}
