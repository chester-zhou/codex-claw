import Foundation

struct TagSummary: Identifiable, Hashable {
    let name: String
    let count: Int

    var id: String {
        name
    }
}

