import Combine
import CryptoKit
import Foundation
import Security
import UIKit

@MainActor
final class CodexRemoteStore: ObservableObject {
    @Published var relayURL: String
    @Published var bridgeID: String
    @Published var deviceName: String
    @Published var pairingCode = ""
    @Published var relayCertificateFingerprint: String

    @Published private(set) var connectionStatus = "未连接"
    @Published private(set) var sendStatus = "待发送"
    @Published private(set) var executionStatus = "当前空闲"
    @Published private(set) var isConnected = false
    @Published private(set) var needsPairing = false
    @Published private(set) var workspaces: [CodexWorkspace] = []
    @Published private(set) var activeWorkspaceID: String?
    @Published private(set) var pendingInteractions: [CodexPendingInteraction] = []
    @Published private(set) var agentSettings = CodexAgentSettings(soul: "", userNote: "", globalMemory: "")
    @Published private(set) var memoryInbox: [CodexMemoryEntry] = []

    private(set) var messagesByWorkspace: [String: [CodexChatMessage]] = [:]

    private let userDefaults: UserDefaults
    private let keychain: KeychainStore
    private let identityManager = CodexDeviceIdentityManager()
    private var socketTask: URLSessionWebSocketTask?
    private var session: URLSession?
    private var sessionDelegate: RelaySessionDelegate?
    private var itemIndexByWorkspace: [String: [String: String]] = [:]
    private var statusItemIDByWorkspace: [String: String] = [:]
    private var pendingOutboundMessage: PendingOutboundMessage?
    private var bufferedDeltas: [String: BufferedDelta] = [:]
    private var reconnectTask: Task<Void, Never>?
    private var heartbeatTask: Task<Void, Never>?
    private var deltaFlushTask: Task<Void, Never>?
    private var reconnectAttempts = 0
    private var shouldAutoReconnect = false
    private var lastReceiveAt = Date.distantPast

    private let heartbeatInterval: TimeInterval = 20
    private let heartbeatTimeout: TimeInterval = 45
    private let outboundAckTimeout: TimeInterval = 6
    private let maxReconnectAttempts = 20
    private let foregroundReconnectThreshold: TimeInterval = 30
    private let deltaFlushInterval: TimeInterval = 0.12

    private enum DefaultsKeys {
        static let relayURL = "codex.remote.relayURL"
        static let bridgeID = "codex.remote.bridgeID"
        static let deviceName = "codex.remote.deviceName"
        static let relayCertificateFingerprint = "codex.remote.relayCertificateFingerprint"
        static let activeWorkspaceID = "codex.remote.activeWorkspaceID"
    }

    private enum KeychainKeys {
        static let deviceID = "codex.remote.deviceID"
        static let legacyPrivateKey = "codex.remote.privateKey"
    }

    init(
        userDefaults: UserDefaults = .standard,
        keychain: KeychainStore = .shared
    ) {
        self.userDefaults = userDefaults
        self.keychain = keychain
        relayURL = userDefaults.string(forKey: DefaultsKeys.relayURL) ?? "ws://127.0.0.1:8787"
        bridgeID = userDefaults.string(forKey: DefaultsKeys.bridgeID) ?? "chester-mac"
        deviceName = userDefaults.string(forKey: DefaultsKeys.deviceName) ?? UIDevice.current.name
        relayCertificateFingerprint = userDefaults.string(forKey: DefaultsKeys.relayCertificateFingerprint) ?? ""
        activeWorkspaceID = userDefaults.string(forKey: DefaultsKeys.activeWorkspaceID)
    }

    var activeMessages: [CodexChatMessage] {
        guard let activeWorkspaceID else { return [] }
        return messagesByWorkspace[activeWorkspaceID] ?? []
    }

    var activeInteraction: CodexPendingInteraction? {
        pendingInteractions.first
    }

    var canReconnectNow: Bool {
        !isConnected
    }

    func saveConfiguration() {
        userDefaults.set(relayURL, forKey: DefaultsKeys.relayURL)
        userDefaults.set(bridgeID, forKey: DefaultsKeys.bridgeID)
        userDefaults.set(deviceName, forKey: DefaultsKeys.deviceName)
        userDefaults.set(relayCertificateFingerprint, forKey: DefaultsKeys.relayCertificateFingerprint)
        userDefaults.set(activeWorkspaceID, forKey: DefaultsKeys.activeWorkspaceID)
    }

    func connect() {
        closeTransport(manual: false)
        saveConfiguration()
        shouldAutoReconnect = true

        guard let url = URL(string: relayURL) else {
            setConnectionStatus("Relay 地址无效")
            return
        }

        let normalizedFingerprint = Self.normalizedFingerprint(relayCertificateFingerprint)
        reconnectTask?.cancel()

        setConnectionStatus("连接 Relay 中")
        sendStatus = "待发送"
        executionStatus = "正在连接"
        let delegate = RelaySessionDelegate(pinnedFingerprint: normalizedFingerprint)
        let session = URLSession(configuration: .default, delegate: delegate, delegateQueue: nil)
        let task = session.webSocketTask(with: url)

        self.sessionDelegate = delegate
        self.session = session
        socketTask = task
        lastReceiveAt = Date()
        task.resume()

        receiveLoop()
        startHeartbeat()
        send(CodexClientEnvelope(
            type: "app.connect",
            bridgeId: bridgeID
        ))
    }

    func disconnect() {
        shouldAutoReconnect = false
        reconnectTask?.cancel()
        reconnectTask = nil
        reconnectAttempts = 0
        closeTransport(manual: true)
        isConnected = false
        needsPairing = false
        pendingInteractions = []
        setConnectionStatus("未连接")
        sendStatus = "待发送"
        executionStatus = "当前空闲"
    }

    func reconnectNow() {
        reconnectTask?.cancel()
        reconnectTask = nil
        reconnectAttempts = 0
        connect()
    }

    func handleAppDidBecomeActive() {
        guard shouldAutoReconnect || isConnected || socketTask != nil else { return }

        let secondsSinceLastReceive = Date().timeIntervalSince(lastReceiveAt)
        let needsFreshConnection = !isConnected
            || socketTask == nil
            || secondsSinceLastReceive > foregroundReconnectThreshold

        guard needsFreshConnection else { return }
        reconnectNow()
    }

    func pairDevice() {
        let trimmedCode = pairingCode.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedCode.isEmpty else {
            setConnectionStatus("请输入一次性配对码")
            return
        }

        guard socketTask != nil else {
            setConnectionStatus("请先连接 Relay")
            return
        }

        do {
            let identity = try ensureDeviceIdentity()
            send(CodexClientEnvelope(
                type: "client.pair",
                bridgeId: bridgeID,
                deviceId: identity.deviceID,
                deviceName: deviceName,
                publicKeyPem: identity.publicKeyPEM,
                pairingCode: trimmedCode
            ))
            setConnectionStatus("提交配对中")
        } catch {
            setConnectionStatus(error.localizedDescription)
        }
    }

    func selectWorkspace(_ workspaceID: String) {
        activeWorkspaceID = workspaceID
        saveConfiguration()
        send(CodexClientEnvelope(type: "workspace.activate", workspaceId: workspaceID))
        if isConnected {
            send(CodexClientEnvelope(type: "workspace.preheat", workspaceId: workspaceID))
        }
    }

    func sendMessage(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        guard let workspaceID = activeWorkspaceID else {
            setConnectionStatus("工作区尚未就绪，正在重新加载")
            send(CodexClientEnvelope(type: "workspace.list"))
            return
        }
        queueOutboundMessage(text: trimmed, workspaceID: workspaceID)
    }

    func startNewThread() {
        guard let workspaceID = activeWorkspaceID else {
            setConnectionStatus("工作区尚未就绪，无法新建对话")
            return
        }

        pendingOutboundMessage?.timeoutTask?.cancel()
        pendingOutboundMessage = nil
        send(CodexClientEnvelope(type: "chat.newThread", workspaceId: workspaceID))
    }

    func approvePendingCommand() {
        guard let interaction = activeInteraction, interaction.kind == .commandApproval else { return }
        send(CodexClientEnvelope(
            type: "interaction.respond",
            requestId: interaction.id,
            interactionKind: CodexPendingInteractionKind.commandApproval.rawValue,
            decision: CodexCommandApprovalDecision.approved.rawValue
        ))
        removePendingInteraction(id: interaction.id)
    }

    func rejectPendingCommand() {
        guard let interaction = activeInteraction, interaction.kind == .commandApproval else { return }
        send(CodexClientEnvelope(
            type: "interaction.respond",
            requestId: interaction.id,
            interactionKind: CodexPendingInteractionKind.commandApproval.rawValue,
            decision: CodexCommandApprovalDecision.denied.rawValue
        ))
        removePendingInteraction(id: interaction.id)
    }

    func respondToPendingFileChange(_ decision: CodexFileChangeApprovalDecision) {
        guard let interaction = activeInteraction, interaction.kind == .fileChangeApproval else { return }
        send(CodexClientEnvelope(
            type: "interaction.respond",
            requestId: interaction.id,
            interactionKind: CodexPendingInteractionKind.fileChangeApproval.rawValue,
            decision: decision.rawValue
        ))
        removePendingInteraction(id: interaction.id)
    }

    func submitPendingUserInput(_ answers: [String: String]) {
        guard let interaction = activeInteraction, interaction.kind == .requestUserInput else { return }

        let payloadAnswers = answers.reduce(into: [String: CodexUserInputAnswer]()) { result, item in
            let trimmed = item.value.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { return }
            result[item.key] = CodexUserInputAnswer(answers: [trimmed])
        }

        guard payloadAnswers.count == interaction.questions.count else { return }

        send(CodexClientEnvelope(
            type: "interaction.respond",
            requestId: interaction.id,
            interactionKind: CodexPendingInteractionKind.requestUserInput.rawValue,
            answers: payloadAnswers
        ))
        removePendingInteraction(id: interaction.id)
    }

    func workspaceName(for workspaceID: String) -> String {
        workspaces.first(where: { $0.id == workspaceID })?.name ?? workspaceID
    }

    func loadAgentSettings() {
        send(CodexClientEnvelope(type: "agent.settings.get"))
    }

    func saveAgentSettings(_ settings: CodexAgentSettings) {
        send(CodexClientEnvelope(
            type: "agent.settings.save",
            soul: settings.soul,
            userNote: settings.userNote,
            globalMemory: settings.globalMemory
        ))
    }

    func loadMemoryInbox(limit: Int = 40) {
        send(CodexClientEnvelope(type: "agent.memory.inbox.get", limit: limit))
    }

    private func receiveLoop() {
        socketTask?.receive { [weak self] result in
            Task { @MainActor in
                guard let self else { return }
                switch result {
                case .success(let message):
                    self.lastReceiveAt = Date()
                    switch message {
                    case .string(let text):
                        self.handleIncomingText(text)
                    case .data(let data):
                        if let text = String(data: data, encoding: .utf8) {
                            self.handleIncomingText(text)
                        }
                    @unknown default:
                        break
                    }
                    self.receiveLoop()
                case .failure(let error):
                    self.setConnectionStatus("连接中断：\(error.localizedDescription)")
                    self.isConnected = false
                    self.scheduleReconnectIfNeeded()
                }
            }
        }
    }

    private func handleIncomingText(_ text: String) {
        guard let data = text.data(using: .utf8) else { return }

        do {
            let payload = try JSONDecoder().decode(CodexServerEnvelope.self, from: data)
            switch payload.type {
            case "relay.connected":
                setConnectionStatus("Relay 已连接，等待 Bridge")
                sendBridgeHello()
            case "session.status":
                setConnectionStatus(payload.message ?? payload.status ?? "状态更新")
                isConnected = payload.status == "ready"
                needsPairing = payload.status == "pairingRequired"
                if payload.status == "pairingAccepted" {
                    pairingCode = ""
                    needsPairing = false
                    sendBridgeHello()
                }
                if payload.status == "ready" {
                    reconnectAttempts = 0
                    needsPairing = false
                    sendStatus = "待发送"
                    executionStatus = "当前空闲"
                    send(CodexClientEnvelope(type: "workspace.list"))
                }
            case "session.challenge":
                guard
                    let challengeID = payload.challengeId,
                    let challenge = payload.challenge
                else {
                    return
                }
                respondToChallenge(challengeID: challengeID, challenge: challenge)
            case "workspace.state":
                workspaces = payload.workspaces ?? []
                if let workspaceID = payload.activeWorkspaceId {
                    activeWorkspaceID = workspaceID
                } else if activeWorkspaceID == nil {
                    activeWorkspaceID = workspaces.first?.id
                }
                saveConfiguration()
                if isConnected, let activeWorkspaceID {
                    send(CodexClientEnvelope(type: "workspace.preheat", workspaceId: activeWorkspaceID))
                }
            case "chat.user":
                guard
                    let workspaceID = payload.workspaceId,
                    let threadID = payload.threadId,
                    let text = payload.text
                else {
                    return
                }
                let wasPending = confirmOutboundMessageIfNeeded(workspaceID: workspaceID, text: text)
                sendStatus = "已发送"
                if !wasPending {
                    append(
                        CodexChatMessage(
                            id: "user-\(threadID)-\(UUID().uuidString)",
                            role: .user,
                            text: text,
                            timestamp: Date()
                        ),
                        to: workspaceID
                    )
                }
            case "chat.reset":
                guard let workspaceID = payload.workspaceId else {
                    return
                }
                resetThreadState(for: workspaceID, message: payload.message ?? "已开始新对话")
            case "chat.assistantDelta":
                guard
                    let workspaceID = payload.workspaceId,
                    let itemID = payload.itemId,
                    let delta = payload.delta
                else {
                    return
                }
                executionStatus = "正在回复"
                queueDelta(delta, workspaceID: workspaceID, itemID: itemID, role: .assistant)
            case "chat.commandDelta":
                guard
                    let workspaceID = payload.workspaceId,
                    let itemID = payload.itemId,
                    let delta = payload.delta
                else {
                    return
                }
                executionStatus = "调用工具中"
                queueDelta(delta, workspaceID: workspaceID, itemID: itemID, role: .command)
            case "chat.status":
                guard
                    let workspaceID = payload.workspaceId,
                    let threadID = payload.threadId,
                    let status = payload.status
                else {
                    return
                }
                upsertStatus(status, workspaceID: workspaceID, threadID: threadID)
                executionStatus = status
            case "chat.completed":
                guard
                    let workspaceID = payload.workspaceId,
                    let threadID = payload.threadId
                else {
                    setConnectionStatus("本轮已完成")
                    return
                }
                flushBufferedDeltas()
                completeThread(workspaceID: workspaceID, threadID: threadID)
                executionStatus = "当前空闲"
                setConnectionStatus("本轮已完成")
            case "agent.settings.state":
                agentSettings = CodexAgentSettings(
                    soul: payload.soul ?? "",
                    userNote: payload.userNote ?? "",
                    globalMemory: payload.globalMemory ?? ""
                )
            case "agent.settings.saved":
                setConnectionStatus(payload.message ?? "助手设定已保存")
            case "agent.memory.inbox.state":
                memoryInbox = payload.entries ?? []
            case "interaction.request":
                guard
                    let requestID = payload.requestId,
                    let interactionKindRaw = payload.interactionKind,
                    let interactionKind = CodexPendingInteractionKind(rawValue: interactionKindRaw),
                    let workspaceID = payload.workspaceId,
                    let threadID = payload.threadId
                else {
                    return
                }

                enqueuePendingInteraction(CodexPendingInteraction(
                    id: requestID,
                    kind: interactionKind,
                    workspaceId: workspaceID,
                    threadId: threadID,
                    turnId: payload.turnId,
                    command: payload.command,
                    cwd: payload.cwd,
                    reason: payload.reason,
                    grantRoot: payload.grantRoot,
                    diff: payload.diff,
                    questions: payload.questions ?? []
                ))
            case "error":
                setConnectionStatus(payload.message ?? "远程错误")
                executionStatus = "执行失败"
                append(
                    CodexChatMessage(
                        id: "error-\(UUID().uuidString)",
                        role: .error,
                        text: payload.message ?? "未知错误",
                        timestamp: Date()
                    ),
                    to: activeWorkspaceID ?? "global"
                )
            default:
                break
            }
        } catch {
            setConnectionStatus("协议解析失败")
        }
    }

    private func append(_ message: CodexChatMessage, to workspaceID: String) {
        var items = messagesByWorkspace[workspaceID] ?? []
        items.append(message)
        messagesByWorkspace[workspaceID] = items
        objectWillChange.send()
    }

    private func enqueuePendingInteraction(_ interaction: CodexPendingInteraction) {
        if let index = pendingInteractions.firstIndex(where: { $0.id == interaction.id }) {
            pendingInteractions[index] = interaction
            return
        }

        pendingInteractions.append(interaction)
    }

    private func removePendingInteraction(id: String) {
        pendingInteractions.removeAll { $0.id == id }
    }

    private func appendDelta(_ delta: String, workspaceID: String, itemID: String, role: CodexChatMessage.Role) {
        let normalizedDelta = normalized(delta: delta, for: role)
        guard !normalizedDelta.isEmpty else { return }
        var items = messagesByWorkspace[workspaceID] ?? []
        var indexMap = itemIndexByWorkspace[workspaceID] ?? [:]

        if let existingID = indexMap[itemID], let index = items.firstIndex(where: { $0.id == existingID }) {
            items[index].text += normalizedDelta
        } else {
            let messageID = "\(role)-\(itemID)"
            indexMap[itemID] = messageID
            items.append(
                CodexChatMessage(
                    id: messageID,
                    role: role,
                    text: normalizedDelta,
                    timestamp: Date()
                )
            )
        }

        itemIndexByWorkspace[workspaceID] = indexMap
        messagesByWorkspace[workspaceID] = items
        objectWillChange.send()
    }

    private func queueDelta(_ delta: String, workspaceID: String, itemID: String, role: CodexChatMessage.Role) {
        let normalizedDelta = normalized(delta: delta, for: role)
        guard !normalizedDelta.isEmpty else { return }

        let key = "\(workspaceID)|\(itemID)|\(roleKey(role))"
        if var existing = bufferedDeltas[key] {
            existing.text += normalizedDelta
            bufferedDeltas[key] = existing
        } else {
            bufferedDeltas[key] = BufferedDelta(
                workspaceID: workspaceID,
                itemID: itemID,
                role: role,
                text: normalizedDelta
            )
        }

        scheduleDeltaFlush()
    }

    private func upsertStatus(_ status: String, workspaceID: String, threadID: String) {
        let messageID = "status-\(threadID)"
        var items = messagesByWorkspace[workspaceID] ?? []

        if let existingMessageID = statusItemIDByWorkspace[workspaceID],
           existingMessageID != messageID,
           let index = items.firstIndex(where: { $0.id == existingMessageID }) {
            items.remove(at: index)
        }

        if let index = items.firstIndex(where: { $0.id == messageID }) {
            guard items[index].text != status else { return }
            items[index].text = status
        } else {
            items.append(
                CodexChatMessage(
                    id: messageID,
                    role: .status,
                    text: status,
                    timestamp: Date()
                )
            )
        }

        statusItemIDByWorkspace[workspaceID] = messageID
        messagesByWorkspace[workspaceID] = items
        objectWillChange.send()
    }

    private func completeThread(workspaceID: String, threadID: String) {
        let messageID = "status-\(threadID)"
        var items = messagesByWorkspace[workspaceID] ?? []

        if let index = items.firstIndex(where: { $0.id == messageID }) {
            items.remove(at: index)
        }

        if statusItemIDByWorkspace[workspaceID] == messageID {
            statusItemIDByWorkspace.removeValue(forKey: workspaceID)
        }

        pendingInteractions.removeAll { $0.workspaceId == workspaceID && $0.threadId == threadID }
        messagesByWorkspace[workspaceID] = items
        objectWillChange.send()
    }

    private func resetThreadState(for workspaceID: String, message: String) {
        messagesByWorkspace[workspaceID] = [
            CodexChatMessage(
                id: "reset-\(workspaceID)-\(UUID().uuidString)",
                role: .status,
                text: message,
                timestamp: Date()
            )
        ]
        itemIndexByWorkspace[workspaceID] = [:]
        statusItemIDByWorkspace.removeValue(forKey: workspaceID)
        pendingInteractions.removeAll { $0.workspaceId == workspaceID }
        objectWillChange.send()
        executionStatus = "当前空闲"
        setConnectionStatus(message)
    }

    private func setConnectionStatus(_ status: String) {
        guard connectionStatus != status else { return }
        connectionStatus = status
    }

    private func scheduleDeltaFlush() {
        guard deltaFlushTask == nil else { return }
        deltaFlushTask = Task { @MainActor [weak self] in
            guard let self else { return }
            try? await Task.sleep(for: .seconds(deltaFlushInterval))
            flushBufferedDeltas()
        }
    }

    private func flushBufferedDeltas() {
        deltaFlushTask?.cancel()
        deltaFlushTask = nil
        let pending = bufferedDeltas.values
        bufferedDeltas.removeAll()
        for entry in pending {
            appendDelta(entry.text, workspaceID: entry.workspaceID, itemID: entry.itemID, role: entry.role)
        }
    }

    private func normalized(delta: String, for role: CodexChatMessage.Role) -> String {
        guard role == .command else { return delta }

        let ansiPattern = #"\u{001B}\[[0-9;?]*[ -/]*[@-~]"#
        let withoutANSI = delta.replacingOccurrences(
            of: ansiPattern,
            with: "",
            options: .regularExpression
        )

        let withoutCarriageReturn = withoutANSI.replacingOccurrences(of: "\r", with: "")
        let compactBlankLines = withoutCarriageReturn.replacingOccurrences(
            of: #"\n{3,}"#,
            with: "\n\n",
            options: .regularExpression
        )
        return compactBlankLines
    }

    private func sendBridgeHello() {
        do {
            let identity = try ensureDeviceIdentity()
            send(CodexClientEnvelope(
                type: "client.hello",
                bridgeId: bridgeID,
                deviceId: identity.deviceID,
                deviceName: deviceName
            ))
        } catch {
            setConnectionStatus(error.localizedDescription)
        }
    }

    private func respondToChallenge(challengeID: String, challenge: String) {
        do {
            let signature = try identityManager.sign(
                challenge: challenge,
                keychain: keychain,
                deviceIDAccount: KeychainKeys.deviceID,
                legacyPrivateKeyAccount: KeychainKeys.legacyPrivateKey
            )
            send(CodexClientEnvelope(
                type: "client.auth",
                challengeId: challengeID,
                signatureBase64: signature
            ))
        } catch {
            setConnectionStatus("签名失败：\(error.localizedDescription)")
        }
    }

    private func ensureDeviceIdentity() throws -> CodexDeviceIdentity {
        try identityManager.ensureIdentity(
            keychain: keychain,
            deviceIDAccount: KeychainKeys.deviceID,
            legacyPrivateKeyAccount: KeychainKeys.legacyPrivateKey
        )
    }

    private func send(_ payload: CodexClientEnvelope) {
        guard let socketTask, let message = encode(payload) else { return }
        socketTask.send(message) { [weak self] error in
            guard let self, let error else { return }
            Task { @MainActor in
                self.setConnectionStatus("发送失败：\(error.localizedDescription)")
                self.handleTransportFailure(error)
            }
        }
    }

    private func closeTransport(manual: Bool) {
        heartbeatTask?.cancel()
        heartbeatTask = nil
        if manual {
            socketTask?.cancel(with: .goingAway, reason: nil)
        } else {
            socketTask?.cancel()
        }
        socketTask = nil
        session?.invalidateAndCancel()
        session = nil
        sessionDelegate = nil
    }

    private func startHeartbeat() {
        heartbeatTask?.cancel()
        heartbeatTask = Task { @MainActor [weak self] in
            guard let self else { return }
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(heartbeatInterval))
                guard !Task.isCancelled else { return }
                guard let socketTask else { return }
                if Date().timeIntervalSince(lastReceiveAt) > heartbeatTimeout {
                    let error = URLError(.networkConnectionLost)
                    setConnectionStatus("连接超时，准备重连")
                    handleTransportFailure(error)
                    return
                }

                do {
                    try await sendPing(on: socketTask)
                } catch {
                    setConnectionStatus("心跳失败：\(error.localizedDescription)")
                    handleTransportFailure(error)
                    return
                }
            }
        }
    }

    private func sendPing(on task: URLSessionWebSocketTask) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            task.sendPing { error in
                if let error {
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume(returning: ())
                }
            }
        }
    }

    private func handleTransportFailure(_ error: Error) {
        flushBufferedDeltas()
        closeTransport(manual: false)
        isConnected = false
        sendStatus = "待发送"
        executionStatus = "连接已断开"
        scheduleReconnectIfNeeded()
    }

    private func scheduleReconnectIfNeeded() {
        guard shouldAutoReconnect else { return }
        guard reconnectAttempts < maxReconnectAttempts else {
            setConnectionStatus("已停止自动重连，请稍后手动重试")
            return
        }

        reconnectTask?.cancel()
        let delays: [UInt64] = [1, 2, 4, 8, 15, 20, 25, 30]
        let delay = delays[min(reconnectAttempts, delays.count - 1)]
        reconnectAttempts += 1
        setConnectionStatus("连接已断开，\(delay)s 后自动重试 (\(reconnectAttempts)/\(maxReconnectAttempts))")

        reconnectTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard let self else { return }
            guard shouldAutoReconnect, !isConnected else { return }
            connect()
        }
    }

    private func queueOutboundMessage(text: String, workspaceID: String) {
        pendingOutboundMessage?.timeoutTask?.cancel()
        sendStatus = "发送中"
        let localMessageID = "user-local-\(UUID().uuidString)"
        append(
            CodexChatMessage(
                id: localMessageID,
                role: .user,
                text: text,
                timestamp: Date(),
                deliveryState: .sending
            ),
            to: workspaceID
        )
        pendingOutboundMessage = PendingOutboundMessage(
            localMessageID: localMessageID,
            workspaceID: workspaceID,
            text: text,
            attemptCount: 1,
            timeoutTask: nil
        )
        send(CodexClientEnvelope(type: "chat.send", workspaceId: workspaceID, text: text))
        armOutboundAckTimeout()
    }

    private func armOutboundAckTimeout() {
        guard var pendingOutboundMessage else { return }
        pendingOutboundMessage.timeoutTask?.cancel()
        pendingOutboundMessage.timeoutTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(self?.outboundAckTimeout ?? 6))
            guard let self else { return }
            await handleOutboundAckTimeout()
        }
        self.pendingOutboundMessage = pendingOutboundMessage
    }

    @discardableResult
    private func confirmOutboundMessageIfNeeded(workspaceID: String, text: String) -> Bool {
        guard let pendingOutboundMessage else { return false }
        guard pendingOutboundMessage.workspaceID == workspaceID else { return false }
        guard pendingOutboundMessage.text == text else { return false }
        pendingOutboundMessage.timeoutTask?.cancel()
        markMessageDeliveryState(
            messageID: pendingOutboundMessage.localMessageID,
            workspaceID: workspaceID,
            state: .sent
        )
        self.pendingOutboundMessage = nil
        return true
    }

    private func handleOutboundAckTimeout() async {
        guard var pendingOutboundMessage else { return }
        guard pendingOutboundMessage.attemptCount < 2 else {
            setConnectionStatus("消息发送未确认，请重试")
            sendStatus = "发送失败"
            markMessageDeliveryState(
                messageID: pendingOutboundMessage.localMessageID,
                workspaceID: pendingOutboundMessage.workspaceID,
                state: .failed
            )
            self.pendingOutboundMessage = nil
            return
        }

        pendingOutboundMessage.attemptCount += 1
        pendingOutboundMessage.timeoutTask?.cancel()
        self.pendingOutboundMessage = pendingOutboundMessage
        setConnectionStatus("消息发送未确认，正在重连补发")
        sendStatus = "重试发送"
        connect()
        try? await Task.sleep(for: .seconds(1.5))
        guard isConnected else {
            armOutboundAckTimeout()
            return
        }

        send(CodexClientEnvelope(
            type: "chat.send",
            workspaceId: pendingOutboundMessage.workspaceID,
            text: pendingOutboundMessage.text
        ))
        armOutboundAckTimeout()
    }

    private func markMessageDeliveryState(
        messageID: String,
        workspaceID: String,
        state: CodexChatMessage.DeliveryState
    ) {
        guard var items = messagesByWorkspace[workspaceID] else { return }
        guard let index = items.firstIndex(where: { $0.id == messageID }) else { return }
        items[index].deliveryState = state
        messagesByWorkspace[workspaceID] = items
        objectWillChange.send()
    }

    private func encode(_ payload: CodexClientEnvelope) -> URLSessionWebSocketTask.Message? {
        guard let data = try? JSONEncoder().encode(payload), let text = String(data: data, encoding: .utf8) else {
            return nil
        }
        return .string(text)
    }

    private static func normalizedFingerprint(_ fingerprint: String) -> String? {
        let normalized = fingerprint
            .lowercased()
            .replacingOccurrences(of: ":", with: "")
            .replacingOccurrences(of: " ", with: "")
            .trimmingCharacters(in: .whitespacesAndNewlines)

        guard !normalized.isEmpty else { return nil }
        return normalized
    }

    private func roleKey(_ role: CodexChatMessage.Role) -> String {
        switch role {
        case .user:
            return "user"
        case .assistant:
            return "assistant"
        case .command:
            return "command"
        case .status:
            return "status"
        case .error:
            return "error"
        }
    }
}

private struct PendingOutboundMessage {
    let localMessageID: String
    let workspaceID: String
    let text: String
    var attemptCount: Int
    var timeoutTask: Task<Void, Never>?
}

private struct BufferedDelta {
    let workspaceID: String
    let itemID: String
    let role: CodexChatMessage.Role
    var text: String
}

private struct CodexDeviceIdentity {
    let deviceID: String
    let publicKeyPEM: String
}

private enum CodexDeviceIdentityError: LocalizedError {
    case publicKeyUnavailable
    case privateKeyUnavailable
    case signatureFailed(String)

    var errorDescription: String? {
        switch self {
        case .publicKeyUnavailable:
            return "无法导出设备公钥"
        case .privateKeyUnavailable:
            return "无法创建设备私钥"
        case .signatureFailed(let message):
            return message
        }
    }
}

private final class CodexDeviceIdentityManager {
    private let applicationTag = Data("com.chesterzhou.iOSNote.codex.remote.device-signing-key".utf8)

    func ensureIdentity(
        keychain: KeychainStore,
        deviceIDAccount: String,
        legacyPrivateKeyAccount: String
    ) throws -> CodexDeviceIdentity {
        let deviceID = keychain.string(for: deviceIDAccount) ?? UUID().uuidString
        if keychain.string(for: deviceIDAccount) == nil {
            try? keychain.set(deviceID, for: deviceIDAccount)
        }

        let privateKey = try ensurePrivateKey(keychain: keychain, legacyPrivateKeyAccount: legacyPrivateKeyAccount)
        let publicKeyPEM = try publicKeyPEM(for: privateKey)
        return CodexDeviceIdentity(deviceID: deviceID, publicKeyPEM: publicKeyPEM)
    }

    func sign(
        challenge: String,
        keychain: KeychainStore,
        deviceIDAccount: String,
        legacyPrivateKeyAccount: String
    ) throws -> String {
        _ = try ensureIdentity(
            keychain: keychain,
            deviceIDAccount: deviceIDAccount,
            legacyPrivateKeyAccount: legacyPrivateKeyAccount
        )

        let privateKey = try ensurePrivateKey(keychain: keychain, legacyPrivateKeyAccount: legacyPrivateKeyAccount)
        var error: Unmanaged<CFError>?
        guard
            let signature = SecKeyCreateSignature(
                privateKey,
                .ecdsaSignatureMessageX962SHA256,
                Data(challenge.utf8) as CFData,
                &error
            ) as Data?
        else {
            let message = error?.takeRetainedValue().localizedDescription ?? "设备签名失败"
            throw CodexDeviceIdentityError.signatureFailed(message)
        }

        return signature.base64EncodedString()
    }

    private func ensurePrivateKey(keychain: KeychainStore, legacyPrivateKeyAccount: String) throws -> SecKey {
        if let existingKey = existingPrivateKey() {
            try? keychain.remove(legacyPrivateKeyAccount)
            return existingKey
        }

        let createdKey = try createPrivateKey()
        try? keychain.remove(legacyPrivateKeyAccount)
        return createdKey
    }

    private func existingPrivateKey() -> SecKey? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassKey,
            kSecAttrApplicationTag as String: applicationTag,
            kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
            kSecAttrKeyClass as String: kSecAttrKeyClassPrivate,
            kSecReturnRef as String: true
        ]

        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        guard status == errSecSuccess else { return nil }
        guard let item else { return nil }
        let key: SecKey = item as! SecKey
        return key
    }

    private func createPrivateKey() throws -> SecKey {
        if let secureEnclaveKey = try? createSecureEnclavePrivateKey() {
            return secureEnclaveKey
        }

        return try createSoftwarePrivateKey()
    }

    private func createSecureEnclavePrivateKey() throws -> SecKey {
        try createKeyAttributes(includeSecureEnclave: true)
    }

    private func createSoftwarePrivateKey() throws -> SecKey {
        try createKeyAttributes(includeSecureEnclave: false)
    }

    private func createKeyAttributes(includeSecureEnclave: Bool) throws -> SecKey {
        var accessError: Unmanaged<CFError>?
        guard let accessControl = SecAccessControlCreateWithFlags(
            nil,
            kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
            .privateKeyUsage,
            &accessError
        ) else {
            let message = accessError?.takeRetainedValue().localizedDescription ?? "无法创建访问控制"
            throw CodexDeviceIdentityError.signatureFailed(message)
        }

        var attributes: [String: Any] = [
            kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
            kSecAttrKeySizeInBits as String: 256,
            kSecPrivateKeyAttrs as String: [
                kSecAttrIsPermanent as String: true,
                kSecAttrApplicationTag as String: applicationTag,
                kSecAttrAccessControl as String: accessControl
            ]
        ]

        if includeSecureEnclave {
            attributes[kSecAttrTokenID as String] = kSecAttrTokenIDSecureEnclave
        }

        var createError: Unmanaged<CFError>?
        guard let key = SecKeyCreateRandomKey(attributes as CFDictionary, &createError) else {
            let message = createError?.takeRetainedValue().localizedDescription ?? "无法创建设备私钥"
            throw CodexDeviceIdentityError.signatureFailed(message)
        }

        return key
    }

    private func publicKeyPEM(for privateKey: SecKey) throws -> String {
        guard let publicKey = SecKeyCopyPublicKey(privateKey) else {
            throw CodexDeviceIdentityError.publicKeyUnavailable
        }

        var exportError: Unmanaged<CFError>?
        guard let rawPublicKey = SecKeyCopyExternalRepresentation(publicKey, &exportError) as Data? else {
            let message = exportError?.takeRetainedValue().localizedDescription ?? "无法导出设备公钥"
            throw CodexDeviceIdentityError.signatureFailed(message)
        }

        return Self.publicKeyPEM(for: rawPublicKey)
    }

    private static func publicKeyPEM(for rawRepresentation: Data) -> String {
        let header = Data([
            0x30, 0x59,
            0x30, 0x13,
            0x06, 0x07, 0x2A, 0x86, 0x48, 0xCE, 0x3D, 0x02, 0x01,
            0x06, 0x08, 0x2A, 0x86, 0x48, 0xCE, 0x3D, 0x03, 0x01, 0x07,
            0x03, 0x42, 0x00
        ])

        let der = header + rawRepresentation
        let base64 = der.base64EncodedString()
        let lines = stride(from: 0, to: base64.count, by: 64).map { index in
            let start = base64.index(base64.startIndex, offsetBy: index)
            let end = base64.index(
                start,
                offsetBy: min(64, base64.distance(from: start, to: base64.endIndex)),
                limitedBy: base64.endIndex
            ) ?? base64.endIndex
            return String(base64[start..<end])
        }

        return """
        -----BEGIN PUBLIC KEY-----
        \(lines.joined(separator: "\n"))
        -----END PUBLIC KEY-----
        """
    }
}

private final class RelaySessionDelegate: NSObject, URLSessionDelegate {
    private let pinnedFingerprint: String?

    init(pinnedFingerprint: String?) {
        self.pinnedFingerprint = pinnedFingerprint
    }

    func urlSession(
        _ session: URLSession,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust else {
            completionHandler(.performDefaultHandling, nil)
            return
        }

        guard
            let trust = challenge.protectionSpace.serverTrust,
            let pinnedFingerprint
        else {
            completionHandler(.performDefaultHandling, nil)
            return
        }

        guard let certificate = (SecTrustCopyCertificateChain(trust) as? [SecCertificate])?.first else {
            completionHandler(.cancelAuthenticationChallenge, nil)
            return
        }

        let certificateData = SecCertificateCopyData(certificate) as Data
        let fingerprint = SHA256.hash(data: certificateData).map { String(format: "%02x", $0) }.joined()

        guard fingerprint == pinnedFingerprint else {
            completionHandler(.cancelAuthenticationChallenge, nil)
            return
        }

        completionHandler(.useCredential, URLCredential(trust: trust))
    }
}
