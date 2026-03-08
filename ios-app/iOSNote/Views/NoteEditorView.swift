import SwiftUI

struct NoteEditorView: View {
    @Environment(\.dismiss) private var dismiss

    let note: Note
    let onSave: (String) -> Void

    @State private var content: String

    init(note: Note, onSave: @escaping (String) -> Void) {
        self.note = note
        self.onSave = onSave
        _content = State(initialValue: note.content)
    }

    var body: some View {
        NavigationStack {
            ZStack {
                Color(red: 0.97, green: 0.95, blue: 0.92)
                    .ignoresSafeArea()

                VStack(alignment: .leading, spacing: 16) {
                    Text(note.createdAt.formatted(.dateTime.year().month().day().hour().minute()))
                        .font(.system(size: 13, weight: .semibold, design: .rounded))
                        .foregroundStyle(Color.black.opacity(0.42))

                    TextEditor(text: $content)
                        .scrollContentBackground(.hidden)
                        .padding(18)
                        .background(
                            RoundedRectangle(cornerRadius: 28, style: .continuous)
                                .fill(Color.white.opacity(0.88))
                        )
                        .font(.system(size: 17, weight: .medium, design: .rounded))
                }
                .padding(20)
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("关闭") { dismiss() }
                }

                ToolbarItem(placement: .confirmationAction) {
                    Button("保存") {
                        let trimmed = content.trimmingCharacters(in: .whitespacesAndNewlines)
                        guard !trimmed.isEmpty else { return }
                        onSave(trimmed)
                        dismiss()
                    }
                    .fontWeight(.bold)
                }
            }
        }
    }
}
