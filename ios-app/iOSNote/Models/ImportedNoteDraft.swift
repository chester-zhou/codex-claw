import Foundation

struct ImportedNoteDraft: Equatable {
    let content: String
    let createdAt: Date
    let updatedAt: Date

    init(content: String, createdAt: Date, updatedAt: Date? = nil) {
        self.content = content.trimmingCharacters(in: .whitespacesAndNewlines)
        self.createdAt = createdAt
        self.updatedAt = updatedAt ?? createdAt
    }

    var dedupKey: String {
        Note.dedupKey(content: content, createdAt: createdAt)
    }
}

struct NoteImportSummary: Equatable {
    let sourceName: String
    let importedCount: Int
    let skippedCount: Int

    var totalCount: Int {
        importedCount + skippedCount
    }

    var toastText: String {
        if skippedCount == 0 {
            return "已从 flomo 导入 \(importedCount) 条"
        }
        return "导入 \(importedCount) 条，跳过 \(skippedCount) 条重复"
    }
}

