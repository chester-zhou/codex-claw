import Foundation

struct CodexWorkspace: Identifiable, Codable, Hashable {
    let id: String
    let name: String
    let cwd: String
    let sandbox: String
    let approvalPolicy: String
    let model: String?
}

struct CodexChatMessage: Identifiable, Equatable {
    enum Role {
        case user
        case assistant
        case command
        case status
        case error
    }

    enum DeliveryState: Equatable {
        case sending
        case sent
        case failed
    }

    let id: String
    let role: Role
    var text: String
    let timestamp: Date
    var deliveryState: DeliveryState = .sent
}

enum CodexPendingInteractionKind: String, Codable {
    case commandApproval
    case fileChangeApproval
    case requestUserInput
}

enum CodexCommandApprovalDecision: String {
    case approved
    case denied
}

enum CodexFileChangeApprovalDecision: String {
    case accept
    case acceptForSession
    case decline
    case cancel
}

struct CodexInteractionOption: Identifiable, Codable, Equatable {
    var id: String { label }

    let label: String
    let description: String
}

struct CodexInteractionQuestion: Identifiable, Codable, Equatable {
    let header: String
    let id: String
    let question: String
    let options: [CodexInteractionOption]?
    let isOther: Bool?
    let isSecret: Bool?
}

struct CodexUserInputAnswer: Codable, Equatable {
    let answers: [String]
}

struct CodexPendingInteraction: Identifiable, Equatable {
    let id: String
    let kind: CodexPendingInteractionKind
    let workspaceId: String
    let threadId: String
    let turnId: String?
    let command: String?
    let cwd: String?
    let reason: String?
    let grantRoot: String?
    let diff: String?
    let questions: [CodexInteractionQuestion]
}

struct CodexConnectionConfiguration {
    var relayURL: String
    var bridgeId: String
    var deviceName: String
    var pairingCode: String
    var relayCertificateFingerprint: String
}

struct CodexAgentSettings: Equatable {
    var soul: String
    var userNote: String
    var globalMemory: String
}

struct CodexMemoryEntry: Identifiable, Codable, Equatable {
    var id: String {
        "\(timestamp)|\(workspaceId)|\(userText.prefix(32))"
    }

    let timestamp: String
    let workspaceId: String
    let workspaceName: String
    let userText: String
    let assistantSummary: String
    let openLoops: [String]
    let source: String?
}

struct CodexClientEnvelope: Codable {
    let type: String
    var bridgeId: String?
    var deviceId: String?
    var deviceName: String?
    var publicKeyPem: String?
    var pairingCode: String?
    var challengeId: String?
    var signatureBase64: String?
    var workspaceId: String?
    var text: String?
    var threadId: String?
    var requestId: String?
    var interactionKind: String?
    var decision: String?
    var answers: [String: CodexUserInputAnswer]?
    var soul: String?
    var userNote: String?
    var globalMemory: String?
    var limit: Int?
}

struct CodexServerEnvelope: Codable {
    let type: String
    var status: String?
    var message: String?
    var challengeId: String?
    var challenge: String?
    var bridgeName: String?
    var workspaces: [CodexWorkspace]?
    var activeWorkspaceId: String?
    var workspaceId: String?
    var threadId: String?
    var text: String?
    var timestamp: String?
    var itemId: String?
    var delta: String?
    var requestId: String?
    var interactionKind: String?
    var command: String?
    var cwd: String?
    var reason: String?
    var turnId: String?
    var grantRoot: String?
    var diff: String?
    var questions: [CodexInteractionQuestion]?
    var connectionId: String?
    var soul: String?
    var userNote: String?
    var globalMemory: String?
    var entries: [CodexMemoryEntry]?
}
