import Combine
import Foundation

@MainActor
final class NoteStore: ObservableObject {
    @Published private(set) var notes: [Note] = []

    private let fileURL: URL
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    init(fileManager: FileManager = .default) {
        let supportURL = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        fileURL = supportURL.appendingPathComponent("iOSNote").appendingPathComponent("notes.json")
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        encoder.dateEncodingStrategy = .iso8601
        decoder.dateDecodingStrategy = .iso8601
        load()
    }

    func createNote(from content: String) {
        let trimmed = content.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }

        notes.insert(Note(content: trimmed), at: 0)
        persist()
    }

    func importNotes(_ drafts: [ImportedNoteDraft], sourceName: String) -> NoteImportSummary {
        guard !drafts.isEmpty else {
            return NoteImportSummary(sourceName: sourceName, importedCount: 0, skippedCount: 0)
        }

        var existingKeys = Set(notes.map(\.dedupKey))
        var batchKeys = Set<String>()
        var importedNotes: [Note] = []
        var skippedCount = 0

        for draft in drafts.sorted(by: { $0.createdAt > $1.createdAt }) {
            let trimmed = draft.content.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else {
                skippedCount += 1
                continue
            }

            let dedupKey = draft.dedupKey
            guard !existingKeys.contains(dedupKey), batchKeys.insert(dedupKey).inserted else {
                skippedCount += 1
                continue
            }

            existingKeys.insert(dedupKey)
            importedNotes.append(
                Note(
                    content: trimmed,
                    createdAt: draft.createdAt,
                    updatedAt: draft.updatedAt
                )
            )
        }

        if !importedNotes.isEmpty {
            notes = (importedNotes + notes).sorted { $0.createdAt > $1.createdAt }
            persist()
        }

        return NoteImportSummary(
            sourceName: sourceName,
            importedCount: importedNotes.count,
            skippedCount: skippedCount
        )
    }

    func update(noteID: UUID, content: String) {
        guard let index = notes.firstIndex(where: { $0.id == noteID }) else { return }

        let trimmed = content.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }

        notes[index].content = trimmed
        notes[index].updatedAt = .now
        persist()
    }

    func delete(_ note: Note) {
        notes.removeAll { $0.id == note.id }
        persist()
    }

    func filteredNotes(searchText: String, selectedTag: String?) -> [Note] {
        let normalizedSearch = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        let selectedTagKey = selectedTag.map(Note.canonicalTag)

        return notes.filter { note in
            let matchesSearch: Bool
            if normalizedSearch.isEmpty {
                matchesSearch = true
            } else {
                matchesSearch =
                    note.content.localizedCaseInsensitiveContains(normalizedSearch) ||
                    note.tags.contains { $0.localizedCaseInsensitiveContains(normalizedSearch) }
            }

            let matchesTag: Bool
            if let selectedTagKey {
                matchesTag = note.tags.contains { Note.canonicalTag($0) == selectedTagKey }
            } else {
                matchesTag = true
            }

            return matchesSearch && matchesTag
        }
    }

    func tagSummaries(in sourceNotes: [Note]? = nil) -> [TagSummary] {
        let baseNotes = sourceNotes ?? notes

        var counts: [String: Int] = [:]
        var displayNames: [String: String] = [:]

        for note in baseNotes {
            for tag in note.tags {
                let key = Note.canonicalTag(tag)
                counts[key, default: 0] += 1
                if displayNames[key] == nil {
                    displayNames[key] = tag
                }
            }
        }

        return counts.keys
            .map { key in
                TagSummary(name: displayNames[key] ?? key, count: counts[key] ?? 0)
            }
            .sorted {
                if $0.count == $1.count {
                    return $0.name.localizedCompare($1.name) == .orderedAscending
                }
                return $0.count > $1.count
            }
    }

    private func load() {
        guard FileManager.default.fileExists(atPath: fileURL.path) else { return }

        do {
            let data = try Data(contentsOf: fileURL)
            let decoded = try decoder.decode([Note].self, from: data)
            notes = decoded.sorted { $0.createdAt > $1.createdAt }
        } catch {
            notes = []
        }
    }

    private func persist() {
        do {
            let folderURL = fileURL.deletingLastPathComponent()
            try FileManager.default.createDirectory(at: folderURL, withIntermediateDirectories: true)
            let data = try encoder.encode(notes)
            try data.write(to: fileURL, options: [.atomic])
        } catch {
            assertionFailure("Failed to persist notes: \(error)")
        }
    }
}
