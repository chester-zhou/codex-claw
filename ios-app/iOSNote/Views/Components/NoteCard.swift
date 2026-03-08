import SwiftUI

struct NoteCard: View {
    let note: Note
    let onTap: () -> Void
    let onDelete: () -> Void

    var body: some View {
        Button(action: onTap) {
            VStack(alignment: .leading, spacing: 14) {
                HStack {
                    Text(note.createdAt.formatted(.dateTime.hour().minute()))
                        .font(.system(size: 13, weight: .bold, design: .rounded))
                        .foregroundStyle(Color.black.opacity(0.44))

                    Spacer()

                    if note.updatedAt != note.createdAt {
                        Text("已编辑")
                            .font(.system(size: 11, weight: .bold, design: .rounded))
                            .foregroundStyle(Color.black.opacity(0.38))
                    }
                }

                Text(note.content)
                    .font(.system(size: 17, weight: .medium, design: .rounded))
                    .foregroundStyle(Color.black.opacity(0.84))
                    .multilineTextAlignment(.leading)
                    .frame(maxWidth: .infinity, alignment: .leading)

                if !note.tags.isEmpty {
                    HStack(spacing: 8) {
                        ForEach(Array(note.tags.prefix(3)), id: \.self) { tag in
                            Text("#\(tag)")
                                .font(.system(size: 12, weight: .bold, design: .rounded))
                                .foregroundStyle(Color.black.opacity(0.56))
                                .padding(.horizontal, 10)
                                .padding(.vertical, 6)
                                .background(
                                    Capsule(style: .continuous)
                                        .fill(Color.black.opacity(0.05))
                                )
                        }
                    }
                }
            }
            .padding(20)
            .background(
                RoundedRectangle(cornerRadius: 28, style: .continuous)
                    .fill(Color.white.opacity(0.78))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 28, style: .continuous)
                    .stroke(Color.white.opacity(0.55), lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
        .contextMenu {
            Button("编辑", action: onTap)
            Button("删除", role: .destructive, action: onDelete)
        }
    }
}

struct NoteCard_Previews: PreviewProvider {
    static var previews: some View {
        NoteCard(
            note: Note(content: "周二下午把 iOS 版本先做成一个极简 MVP，录音后直接落字，不做多级目录。"),
            onTap: {},
            onDelete: {}
        )
        .padding()
        .background(Color.orange.opacity(0.15))
    }
}
