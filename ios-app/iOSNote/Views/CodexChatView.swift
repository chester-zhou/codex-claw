import SwiftUI

struct CodexChatView: View {
    @ObservedObject var store: CodexRemoteStore
    @ObservedObject var settingsStore: SettingsStore
    var onOpenConnectionSettings: () -> Void = {}
    var onOpenMemoryInbox: () -> Void = {}
    var onOpenSettings: () -> Void = {}
    @State private var draft = ""
    @State private var userInputValues: [String: String] = [:]
    @StateObject private var audioRecorder = AudioRecordingService()
    @State private var isTranscribing = false
    @State private var toast: String?
    @State private var hasAttemptedAutoConnect = false

    private let qwenClient = QwenClient()

    private enum RichMessagePart: Identifiable, Equatable {
        case text(String)
        case image(String)

        var id: String {
            switch self {
            case .text(let value):
                return "text:\(value)"
            case .image(let value):
                return "image:\(value)"
            }
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            connectionBanner
            messageList
            if let activeInteraction = store.activeInteraction {
                interactionCard(activeInteraction)
            }
            composer
        }
        .background(
            LinearGradient(
                colors: [
                    Color(red: 0.95, green: 0.94, blue: 0.91),
                    Color(red: 0.90, green: 0.90, blue: 0.86)
                ],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
            .ignoresSafeArea()
        )
        .interactiveDismissDisabled()
        .presentationDragIndicator(.visible)
        .onAppear {
            guard !hasAttemptedAutoConnect else { return }
            hasAttemptedAutoConnect = true
            autoConnectIfNeeded()
        }
        .onChange(of: store.activeInteraction?.id) {
            userInputValues = [:]
        }
    }

    private var connectionBanner: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 10) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Codex Claw")
                        .font(.system(size: 16, weight: .bold, design: .rounded))
                        .foregroundStyle(Color.black.opacity(0.82))

                    HStack(spacing: 8) {
                        Circle()
                            .fill(store.isConnected ? Color.green : Color.orange)
                            .frame(width: 8, height: 8)

                        Text(currentWorkspaceTitle)
                            .font(.system(size: 12, weight: .semibold, design: .rounded))
                            .foregroundStyle(Color.black.opacity(0.54))
                            .lineLimit(1)
                    }
                }

                Spacer()

                headerMenu
            }

            HStack(spacing: 8) {
                statusChip(title: "连接", value: store.isConnected ? "正常" : "断开")
                statusChip(title: "发送", value: store.sendStatus)
                statusChip(title: "执行", value: store.executionStatus)
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 10)
        .padding(.bottom, 6)
        .background(Color.white.opacity(0.7))
    }

    private func statusChip(title: String, value: String) -> some View {
        HStack(spacing: 5) {
            Text(title)
                .font(.system(size: 10, weight: .bold, design: .rounded))
                .foregroundStyle(Color.black.opacity(0.42))

            Text(value)
                .font(.system(size: 11, weight: .semibold, design: .rounded))
                .foregroundStyle(Color.black.opacity(0.72))
                .lineLimit(1)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .background(
            Capsule(style: .continuous)
                .fill(Color.white.opacity(0.72))
        )
    }

    private var headerMenu: some View {
        Menu {
            if !store.workspaces.isEmpty {
                Section("工作区") {
                    ForEach(store.workspaces) { workspace in
                        Button {
                            store.selectWorkspace(workspace.id)
                        } label: {
                            if store.activeWorkspaceID == workspace.id {
                                Label(workspace.name, systemImage: "checkmark")
                            } else {
                                Text(workspace.name)
                            }
                        }
                    }
                }
            }

            if store.activeWorkspaceID != nil {
                Button("新对话", systemImage: "plus.bubble") {
                    store.startNewThread()
                }
            }

            Section("连接") {
                Button(store.isConnected ? "断开" : "重连", systemImage: store.isConnected ? "bolt.slash" : "arrow.clockwise") {
                    if store.isConnected {
                        store.disconnect()
                    } else {
                        store.reconnectNow()
                    }
                }

                Button("连接设置", systemImage: "antenna.radiowaves.left.and.right") {
                    onOpenConnectionSettings()
                }
            }

            Section("更多") {
                Button("Memory Inbox", systemImage: "tray.full") {
                    onOpenMemoryInbox()
                }

                Button("千问设置", systemImage: "slider.horizontal.3") {
                    onOpenSettings()
                }
            }
        } label: {
            Image(systemName: "ellipsis.circle")
                .font(.system(size: 20, weight: .semibold))
                .foregroundStyle(Color.black.opacity(0.76))
                .frame(width: 34, height: 34)
        }
    }

    private var messageList: some View {
        ScrollViewReader { proxy in
            ScrollView(showsIndicators: false) {
                VStack(alignment: .leading, spacing: 12) {
                    ForEach(store.activeMessages) { message in
                        messageBubble(message)
                            .id(message.id)
                    }
                }
                .padding(.horizontal, 20)
                .padding(.vertical, 16)
            }
            .onChange(of: store.activeMessages.count) {
                guard let lastID = store.activeMessages.last?.id else { return }
                withAnimation(.easeOut(duration: 0.2)) {
                    proxy.scrollTo(lastID, anchor: .bottom)
                }
            }
        }
    }

    private var composer: some View {
        HStack(spacing: 10) {
            TextField("问 Codex 一个问题，或者让它在当前工作区执行任务", text: $draft, axis: .vertical)
                .textFieldStyle(.plain)
                .font(.system(size: 18, weight: .medium, design: .rounded))
                .foregroundStyle(Color.black.opacity(0.86))
                .tint(Color.black.opacity(0.86))
                .disabled(isTranscribing)
                .padding(.horizontal, 16)
                .padding(.vertical, 14)
                .background(
                    RoundedRectangle(cornerRadius: 22, style: .continuous)
                        .fill(Color.white.opacity(0.82))
                )

            Button {
                handleRecordTap()
            } label: {
                Image(systemName: audioRecorder.isRecording ? "stop.fill" : "mic.fill")
                    .font(.system(size: 18, weight: .bold))
                    .foregroundStyle(audioRecorder.isRecording ? Color.white : Color.black.opacity(0.78))
                    .frame(width: 54, height: 54)
                    .background(
                        RoundedRectangle(cornerRadius: 20, style: .continuous)
                            .fill(audioRecorder.isRecording ? Color.red.opacity(0.86) : Color.white.opacity(0.82))
                    )
            }
            .disabled(isTranscribing)

            Button("发送") {
                Task {
                    await handleSendTap()
                }
            }
            .font(.system(size: 17, weight: .bold, design: .rounded))
            .foregroundStyle(Color.white)
            .padding(.horizontal, 18)
            .padding(.vertical, 14)
            .background(
                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .fill(Color.black.opacity(0.84))
            )
            .disabled(isSendDisabled)
        }
        .padding(16)
        .background(Color.white.opacity(0.48))
        .overlay(alignment: .top) {
            if let toast {
                Text(toast)
                    .font(.system(size: 13, weight: .semibold, design: .rounded))
                    .foregroundStyle(Color.white)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background(
                        Capsule(style: .continuous)
                            .fill(Color.black.opacity(0.84))
                    )
                    .offset(y: -54)
                    .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
    }

    @ViewBuilder
    private func interactionCard(_ interaction: CodexPendingInteraction) -> some View {
        switch interaction.kind {
        case .commandApproval:
            commandApprovalCard(interaction)
        case .fileChangeApproval:
            fileChangeApprovalCard(interaction)
        case .requestUserInput:
            requestUserInputCard(interaction)
        }
    }

    private func commandApprovalCard(_ interaction: CodexPendingInteraction) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            interactionHeader(
                title: "Codex 正在等待命令审批",
                interaction: interaction
            )

            if let reason = interaction.reason, !reason.isEmpty {
                Text(reason)
                    .font(.system(size: 13, weight: .medium, design: .rounded))
                    .foregroundStyle(Color.black.opacity(0.62))
            }

            if let command = interaction.command, !command.isEmpty {
                detailBlock(command, monospaced: true)
            }

            if let cwd = interaction.cwd, !cwd.isEmpty {
                Text(cwd)
                    .font(.system(size: 12, weight: .medium, design: .rounded))
                    .foregroundStyle(Color.black.opacity(0.46))
            }

            HStack(spacing: 10) {
                Button("拒绝") {
                    store.rejectPendingCommand()
                }
                .buttonStyle(.bordered)

                Button("批准") {
                    store.approvePendingCommand()
                }
                .buttonStyle(.borderedProminent)
            }
        }
        .padding(18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(cardBackground)
        .padding(.horizontal, 16)
        .padding(.bottom, 8)
    }

    private func fileChangeApprovalCard(_ interaction: CodexPendingInteraction) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            interactionHeader(
                title: "Codex 正在等待文件改动审批",
                interaction: interaction
            )

            if let reason = interaction.reason, !reason.isEmpty {
                Text(reason)
                    .font(.system(size: 13, weight: .medium, design: .rounded))
                    .foregroundStyle(Color.black.opacity(0.62))
            }

            if let grantRoot = interaction.grantRoot, !grantRoot.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    Text("授权目录")
                        .font(.system(size: 11, weight: .bold, design: .rounded))
                        .foregroundStyle(Color.black.opacity(0.38))
                    detailBlock(grantRoot, monospaced: true)
                }
            }

            if let diff = interaction.diff, !diff.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    Text("改动预览")
                        .font(.system(size: 11, weight: .bold, design: .rounded))
                        .foregroundStyle(Color.black.opacity(0.38))

                    ScrollView {
                        detailBlock(diff, monospaced: true)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .frame(maxHeight: 180)
                }
            }

            VStack(spacing: 10) {
                HStack(spacing: 10) {
                    Button("拒绝继续") {
                        store.respondToPendingFileChange(.decline)
                    }
                    .buttonStyle(.bordered)

                    Button("中止本轮") {
                        store.respondToPendingFileChange(.cancel)
                    }
                    .buttonStyle(.bordered)
                }

                HStack(spacing: 10) {
                    Button("批准一次") {
                        store.respondToPendingFileChange(.accept)
                    }
                    .buttonStyle(.borderedProminent)

                    Button("本会话都批准") {
                        store.respondToPendingFileChange(.acceptForSession)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(Color(red: 0.31, green: 0.47, blue: 0.40))
                }
            }
        }
        .padding(18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(cardBackground)
        .padding(.horizontal, 16)
        .padding(.bottom, 8)
    }

    private func requestUserInputCard(_ interaction: CodexPendingInteraction) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            interactionHeader(
                title: "Codex 需要更多输入",
                interaction: interaction
            )

            ForEach(interaction.questions) { question in
                VStack(alignment: .leading, spacing: 8) {
                    Text(question.header.uppercased())
                        .font(.system(size: 11, weight: .bold, design: .rounded))
                        .foregroundStyle(Color.black.opacity(0.38))

                    Text(question.question)
                        .font(.system(size: 14, weight: .medium, design: .rounded))
                        .foregroundStyle(Color.black.opacity(0.78))

                    if let options = question.options, !options.isEmpty {
                        VStack(spacing: 8) {
                            ForEach(options) { option in
                                Button {
                                    userInputValues[question.id] = option.label
                                } label: {
                                    HStack(alignment: .top, spacing: 10) {
                                        Image(systemName: userInputValues[question.id] == option.label ? "largecircle.fill.circle" : "circle")
                                            .font(.system(size: 14, weight: .semibold))

                                        VStack(alignment: .leading, spacing: 4) {
                                            Text(option.label)
                                                .font(.system(size: 14, weight: .bold, design: .rounded))
                                            Text(option.description)
                                                .font(.system(size: 12, weight: .medium, design: .rounded))
                                                .foregroundStyle(Color.black.opacity(0.56))
                                        }

                                        Spacer()
                                    }
                                    .foregroundStyle(Color.black.opacity(0.82))
                                    .padding(12)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .background(
                                        RoundedRectangle(cornerRadius: 16, style: .continuous)
                                            .fill(Color.white.opacity(userInputValues[question.id] == option.label ? 0.88 : 0.68))
                                    )
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }

                    if question.options?.isEmpty != false || question.isOther == true {
                        answerField(for: question)
                    }
                }
            }

            Button("提交给 Codex") {
                store.submitPendingUserInput(userInputValues)
            }
            .buttonStyle(.borderedProminent)
            .disabled(!canSubmit(interaction))
        }
        .padding(18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(cardBackground)
        .padding(.horizontal, 16)
        .padding(.bottom, 8)
    }

    private func interactionHeader(title: String, interaction: CodexPendingInteraction) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text(title)
                    .font(.system(size: 15, weight: .bold, design: .rounded))

                Spacer()

                if store.pendingInteractions.count > 1 {
                    Text("待处理 \(store.pendingInteractions.count)")
                        .font(.system(size: 11, weight: .bold, design: .rounded))
                        .foregroundStyle(Color.black.opacity(0.38))
                }
            }

            Text(store.workspaceName(for: interaction.workspaceId))
                .font(.system(size: 12, weight: .bold, design: .rounded))
                .foregroundStyle(Color.black.opacity(0.48))
        }
    }

    private func answerField(for question: CodexInteractionQuestion) -> some View {
        Group {
            if question.isSecret == true {
                SecureField("输入回答", text: answerBinding(for: question.id))
                    .textFieldStyle(.plain)
                    .foregroundStyle(Color.black.opacity(0.86))
                    .tint(Color.black.opacity(0.86))
                    .padding(.horizontal, 14)
                    .padding(.vertical, 12)
                    .background(
                        RoundedRectangle(cornerRadius: 16, style: .continuous)
                            .fill(Color.white.opacity(0.72))
                    )
            } else {
                TextField("输入回答", text: answerBinding(for: question.id), axis: .vertical)
                    .textFieldStyle(.plain)
                    .foregroundStyle(Color.black.opacity(0.86))
                    .tint(Color.black.opacity(0.86))
                    .padding(.horizontal, 14)
                    .padding(.vertical, 12)
                    .background(
                        RoundedRectangle(cornerRadius: 16, style: .continuous)
                            .fill(Color.white.opacity(0.72))
                    )
            }
        }
    }

    private func detailBlock(_ text: String, monospaced: Bool) -> some View {
        Text(text)
            .font(.system(size: 14, weight: .medium, design: monospaced ? .monospaced : .rounded))
            .foregroundStyle(Color.black.opacity(0.82))
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .fill(Color.white.opacity(0.72))
            )
    }

    private func answerBinding(for questionID: String) -> Binding<String> {
        Binding(
            get: { userInputValues[questionID] ?? "" },
            set: { userInputValues[questionID] = $0 }
        )
    }

    private func canSubmit(_ interaction: CodexPendingInteraction) -> Bool {
        !interaction.questions.isEmpty && interaction.questions.allSatisfy { question in
            let answer = userInputValues[question.id]?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return !answer.isEmpty
        }
    }

    private var cardBackground: some View {
        RoundedRectangle(cornerRadius: 24, style: .continuous)
            .fill(Color(red: 0.98, green: 0.92, blue: 0.80).opacity(0.96))
    }

    private func messageBubble(_ message: CodexChatMessage) -> some View {
        VStack(alignment: message.role == .user ? .trailing : .leading, spacing: 6) {
            HStack(spacing: 8) {
                Text(title(for: message.role))
                    .font(.system(size: 11, weight: .bold, design: .rounded))
                    .foregroundStyle(Color.black.opacity(0.38))

                if let deliveryLabel = deliveryLabel(for: message) {
                    Text(deliveryLabel)
                        .font(.system(size: 10, weight: .bold, design: .rounded))
                        .foregroundStyle(Color.black.opacity(0.32))
                }
            }

            bubbleContent(for: message)
                .frame(maxWidth: .infinity, alignment: message.role == .user ? .trailing : .leading)
        }
        .frame(maxWidth: .infinity, alignment: message.role == .user ? .trailing : .leading)
    }

    @ViewBuilder
    private func bubbleContent(for message: CodexChatMessage) -> some View {
        if message.role == .command {
            ScrollView(.vertical, showsIndicators: true) {
                Text(message.text.trimmingCharacters(in: .whitespacesAndNewlines))
                    .font(.system(size: 15, weight: .medium, design: .monospaced))
                    .lineSpacing(3)
                    .textSelection(.enabled)
                    .foregroundStyle(foreground(for: message.role))
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 12)
            }
            .frame(maxWidth: .infinity, maxHeight: 220, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .fill(background(for: message.role))
            )
        } else {
            richBubble(message)
        }
    }

    private func richBubble(_ message: CodexChatMessage) -> some View {
        let parts = richMessageParts(from: message.text, role: message.role)

        return VStack(alignment: .leading, spacing: 10) {
            ForEach(parts) { part in
                switch part {
                case .text(let value):
                    Text(value)
                        .font(.system(size: 18, weight: .medium, design: .rounded))
                        .lineSpacing(4)
                        .textSelection(.enabled)
                        .foregroundStyle(foreground(for: message.role))
                        .frame(maxWidth: .infinity, alignment: .leading)
                case .image(let value):
                    inlineImage(urlString: value)
                }
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .background(
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .fill(background(for: message.role))
        )
        .opacity(message.deliveryState == .sending ? 0.82 : 1)
    }

    private func deliveryLabel(for message: CodexChatMessage) -> String? {
        guard message.role == .user else { return nil }
        switch message.deliveryState {
        case .sending:
            return "发送中"
        case .failed:
            return "发送失败"
        case .sent:
            return nil
        }
    }

    @ViewBuilder
    private func inlineImage(urlString: String) -> some View {
        if let url = imageURL(from: urlString) {
            AsyncImage(url: url) { phase in
                switch phase {
                case .empty:
                    ZStack {
                        RoundedRectangle(cornerRadius: 16, style: .continuous)
                            .fill(Color.black.opacity(0.05))
                        ProgressView()
                    }
                    .frame(maxWidth: .infinity)
                    .frame(height: 220)
                case .success(let image):
                    image
                        .resizable()
                        .scaledToFit()
                        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                case .failure:
                    Link(destination: url) {
                        Label("打开图片", systemImage: "photo")
                            .font(.system(size: 14, weight: .bold, design: .rounded))
                    }
                @unknown default:
                    EmptyView()
                }
            }
        } else {
            Text(urlString)
                .font(.system(size: 14, weight: .medium, design: .rounded))
        }
    }

    private func imageURL(from source: String) -> URL? {
        let trimmed = source.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }

        if trimmed.hasPrefix("/") {
            return relayProxyURL(forLocalPath: trimmed)
        }

        if trimmed.hasPrefix("file://"),
           let fileURL = URL(string: trimmed),
           fileURL.isFileURL {
            return relayProxyURL(forLocalPath: fileURL.path)
        }

        guard let url = URL(string: trimmed),
              let scheme = url.scheme?.lowercased(),
              scheme == "https" || scheme == "http" else {
            return nil
        }

        return url
    }

    private func relayProxyURL(forLocalPath path: String) -> URL? {
        guard var components = URLComponents(string: store.relayURL) else {
            return nil
        }

        components.scheme = components.scheme == "wss" ? "https" : "http"
        components.path = "/bridge-image"
        components.queryItems = [
            URLQueryItem(name: "path", value: path)
        ]
        return components.url
    }

    private func title(for role: CodexChatMessage.Role) -> String {
        switch role {
        case .user:
            return "你"
        case .assistant:
            return "五七"
        case .command:
            return "执行输出"
        case .status:
            return "任务状态"
        case .error:
            return "错误"
        }
    }

    private func background(for role: CodexChatMessage.Role) -> Color {
        switch role {
        case .user:
            return Color.black.opacity(0.82)
        case .assistant:
            return Color.white.opacity(0.78)
        case .command:
            return Color(red: 0.86, green: 0.90, blue: 0.88)
        case .status:
            return Color(red: 0.90, green: 0.89, blue: 0.84)
        case .error:
            return Color(red: 0.95, green: 0.84, blue: 0.82)
        }
    }

    private func foreground(for role: CodexChatMessage.Role) -> Color {
        switch role {
        case .user:
            return .white
        case .assistant, .command, .status, .error:
            return Color.black.opacity(0.82)
        }
    }

    private var currentWorkspaceTitle: String {
        guard let workspaceID = store.activeWorkspaceID else {
            return store.connectionStatus
        }
        return store.workspaceName(for: workspaceID)
    }

    private func richMessageParts(from text: String, role: CodexChatMessage.Role) -> [RichMessagePart] {
        guard role == .assistant || role == .error || role == .status else {
            return [.text(text)]
        }

        let markdownPattern = #"\!\[[^\]]*\]\(([^)]+)\)|\[[^\]]+\]\(([^)]+)\)"#
        let nsText = text as NSString
        let markdownRegex = try? NSRegularExpression(pattern: markdownPattern)
        var matches: [(range: NSRange, url: String)] = markdownRegex?
            .matches(in: text, range: NSRange(location: 0, length: nsText.length))
            .compactMap { match in
                guard match.numberOfRanges > 2 else { return nil }
                let imageGroup = match.range(at: 1)
                let linkGroup = match.range(at: 2)
                let targetRange = imageGroup.location != NSNotFound ? imageGroup : linkGroup
                guard targetRange.location != NSNotFound else { return nil }
                let candidate = nsText.substring(with: targetRange)
                guard looksLikeImageReference(candidate) else { return nil }
                return (match.range, candidate)
            } ?? []

        for (lineRange, url) in standaloneImageURLs(in: text) {
            matches.append((lineRange, url))
        }

        guard !matches.isEmpty else {
            return [.text(text)]
        }

        matches.sort { $0.range.location < $1.range.location }
        var parts: [RichMessagePart] = []
        var cursor = 0

        for match in matches {
            guard match.range.location >= cursor else { continue }

            let textLength = match.range.location - cursor
            if textLength > 0 {
                let chunk = nsText.substring(with: NSRange(location: cursor, length: textLength))
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                if !chunk.isEmpty {
                    parts.append(.text(chunk))
                }
            }

            parts.append(.image(match.url))
            cursor = match.range.location + match.range.length
        }

        if cursor < nsText.length {
            let tail = nsText.substring(from: cursor).trimmingCharacters(in: .whitespacesAndNewlines)
            if !tail.isEmpty {
                parts.append(.text(tail))
            }
        }

        return parts.isEmpty ? [.text(text)] : parts
    }

    private func standaloneImageURLs(in text: String) -> [(NSRange, String)] {
        let nsText = text as NSString
        let lines = text.components(separatedBy: .newlines)
        var cursor = 0
        var results: [(NSRange, String)] = []

        for line in lines {
            let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
            let lineRange = NSRange(location: cursor, length: (line as NSString).length)
            defer { cursor += (line as NSString).length + 1 }

            guard looksLikeImageReference(trimmed) else {
                continue
            }
            guard nsText.substring(with: lineRange).trimmingCharacters(in: .whitespacesAndNewlines) == trimmed else {
                continue
            }

            results.append((lineRange, trimmed))
        }

        return results
    }

    private func looksLikeImageReference(_ value: String) -> Bool {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        let imageExtensions = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "heic"]

        if trimmed.hasPrefix("/") {
            let fileURL = URL(fileURLWithPath: trimmed)
            return imageExtensions.contains(fileURL.pathExtension.lowercased())
        }

        if trimmed.hasPrefix("file://"),
           let fileURL = URL(string: trimmed),
           fileURL.isFileURL {
            return imageExtensions.contains(fileURL.pathExtension.lowercased())
        }

        guard let url = URL(string: trimmed),
              let scheme = url.scheme?.lowercased(),
              scheme == "https" || scheme == "http" else {
            return false
        }

        let pathExtension = url.pathExtension.lowercased()
        return imageExtensions.contains(pathExtension)
            || trimmed.contains("/image")
            || trimmed.contains("blob.core")
            || trimmed.contains("cdn")
    }

    private func autoConnectIfNeeded() {
        guard !store.isConnected else { return }
        guard !store.relayURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        guard !store.bridgeID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        store.connect()
    }

    private var isSendDisabled: Bool {
        if !store.isConnected || isTranscribing {
            return true
        }

        if audioRecorder.isRecording {
            return false
        }

        if store.activeWorkspaceID == nil {
            return true
        }

        return draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func handleRecordTap() {
        if audioRecorder.isRecording {
            Task {
                await finishRecording(sendAfterTranscription: false)
            }
        } else {
            Task {
                await startRecording()
            }
        }
    }

    private func handleSendTap() async {
        if audioRecorder.isRecording {
            await finishRecording(sendAfterTranscription: true)
            return
        }

        let trimmed = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        store.sendMessage(trimmed)
        draft = ""
    }

    @MainActor
    private func startRecording() async {
        guard settingsStore.configuration != nil else {
            showToast("先在主设置里填入 DashScope API Key")
            return
        }

        do {
            try await audioRecorder.startRecording()
            showToast("开始录音，再点一次结束")
        } catch {
            showToast(error.localizedDescription)
        }
    }

    @MainActor
    private func finishRecording(sendAfterTranscription: Bool) async {
        guard let configuration = settingsStore.configuration else {
            showToast("缺少千问配置")
            return
        }

        do {
            let audio = try audioRecorder.stopRecording()
            defer { try? FileManager.default.removeItem(at: audio.url) }
            isTranscribing = true
            showToast("正在转写")
            let transcription = try await qwenClient.transcribe(audio: audio, using: configuration)
            let finalText = appendTranscription(transcription)
            if sendAfterTranscription {
                let trimmed = finalText.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !trimmed.isEmpty else {
                    showToast("没有识别到可发送内容")
                    isTranscribing = false
                    return
                }
                store.sendMessage(trimmed)
                draft = ""
                showToast("转写后已发送")
            } else {
                showToast("转写完成")
            }
        } catch {
            showToast(error.localizedDescription)
        }

        isTranscribing = false
    }

    @discardableResult
    private func appendTranscription(_ text: String) -> String {
        let cleaned = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleaned.isEmpty else { return draft }

        if draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            draft = cleaned
        } else {
            draft += "\n\n" + cleaned
        }

        return draft
    }

    @MainActor
    private func showToast(_ message: String) {
        withAnimation(.spring(response: 0.28, dampingFraction: 0.86)) {
            toast = message
        }

        Task { @MainActor in
            try? await Task.sleep(for: .seconds(1.8))
            guard toast == message else { return }
            withAnimation(.easeOut(duration: 0.2)) {
                toast = nil
            }
        }
    }
}
