export type CommandApprovalDecision = "approved" | "denied";
export type FileChangeApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel";
export type PendingInteractionKind = "commandApproval" | "fileChangeApproval" | "requestUserInput";

export type RequestUserInputOption = {
  label: string;
  description: string;
};

export type RequestUserInputQuestion = {
  header: string;
  id: string;
  question: string;
  options?: RequestUserInputOption[] | null;
  isOther?: boolean;
  isSecret?: boolean;
};

export type RequestUserInputAnswer = {
  answers: string[];
};

export type WorkspaceDescriptor = {
  id: string;
  name: string;
  cwd: string;
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
  approvalPolicy: "untrusted" | "on-failure" | "on-request" | "never";
  model?: string | null;
};

export type AppClientMessage =
  | {
      type: "client.hello";
      bridgeId: string;
      deviceId: string;
      deviceName: string;
    }
  | {
      type: "client.pair";
      bridgeId: string;
      deviceId: string;
      deviceName: string;
      publicKeyPem: string;
      pairingCode: string;
    }
  | {
      type: "client.auth";
      challengeId: string;
      signatureBase64: string;
    }
  | {
      type: "workspace.list";
    }
  | {
      type: "workspace.activate";
      workspaceId: string;
    }
  | {
      type: "chat.send";
      workspaceId: string;
      text: string;
    }
  | {
      type: "chat.newThread";
      workspaceId: string;
    }
  | {
      type: "chat.interrupt";
      threadId: string;
    }
  | {
      type: "agent.settings.get";
    }
  | {
      type: "agent.settings.save";
      soul: string;
      userNote: string;
      globalMemory: string;
    }
  | {
      type: "agent.memory.inbox.get";
      limit?: number;
    }
  | {
      type: "interaction.respond";
      requestId: string;
      interactionKind: "commandApproval";
      decision: CommandApprovalDecision;
    }
  | {
      type: "interaction.respond";
      requestId: string;
      interactionKind: "fileChangeApproval";
      decision: FileChangeApprovalDecision;
    }
  | {
      type: "interaction.respond";
      requestId: string;
      interactionKind: "requestUserInput";
      answers: Record<string, RequestUserInputAnswer>;
    };

export type AppServerMessage =
  | {
      type: "session.status";
      status:
        | "connecting"
        | "pairingRequired"
        | "pairingAccepted"
        | "authenticating"
        | "ready"
        | "error";
      message?: string;
    }
  | {
      type: "session.challenge";
      challengeId: string;
      challenge: string;
      bridgeName: string;
    }
  | {
      type: "workspace.state";
      workspaces: WorkspaceDescriptor[];
      activeWorkspaceId: string | null;
    }
  | {
      type: "chat.thread";
      workspaceId: string;
      threadId: string;
    }
  | {
      type: "chat.reset";
      workspaceId: string;
      message: string;
    }
  | {
      type: "chat.user";
      workspaceId: string;
      threadId: string;
      text: string;
      timestamp: string;
    }
  | {
      type: "chat.assistantDelta";
      workspaceId: string;
      threadId: string;
      itemId: string;
      delta: string;
    }
  | {
      type: "chat.commandDelta";
      workspaceId: string;
      threadId: string;
      itemId: string;
      delta: string;
    }
  | {
      type: "chat.status";
      workspaceId: string;
      threadId: string;
      status: string;
    }
  | {
      type: "chat.completed";
      workspaceId: string;
      threadId: string;
    }
  | {
      type: "agent.settings.state";
      soul: string;
      userNote: string;
      globalMemory: string;
    }
  | {
      type: "agent.settings.saved";
      message: string;
    }
  | {
      type: "agent.memory.inbox.state";
      entries: {
        timestamp: string;
        workspaceId: string;
        workspaceName: string;
        userText: string;
        assistantSummary: string;
        openLoops: string[];
        source?: string;
      }[];
    }
  | {
      type: "interaction.request";
      requestId: string;
      interactionKind: "commandApproval";
      workspaceId: string;
      threadId: string;
      command?: string | null;
      cwd?: string | null;
      reason?: string | null;
    }
  | {
      type: "interaction.request";
      requestId: string;
      interactionKind: "fileChangeApproval";
      workspaceId: string;
      threadId: string;
      turnId: string;
      reason?: string | null;
      grantRoot?: string | null;
      diff?: string | null;
    }
  | {
      type: "interaction.request";
      requestId: string;
      interactionKind: "requestUserInput";
      workspaceId: string;
      threadId: string;
      turnId: string;
      questions: RequestUserInputQuestion[];
    }
  | {
      type: "error";
      message: string;
    };

export type RelayBridgeRegisterMessage = {
  type: "bridge.register";
  bridgeId: string;
  bridgeName: string;
  bridgeToken: string;
};

export type RelayBridgeOutgoingMessage =
  | {
      type: "bridge.push";
      connectionId: string;
      payload: AppServerMessage;
    }
  | {
      type: "bridge.disconnect";
      connectionId: string;
      reason?: string;
    };

export type RelayBridgeIncomingMessage =
  | {
      type: "relay.app.connected";
      connectionId: string;
    }
  | {
      type: "relay.app.disconnected";
      connectionId: string;
    }
  | {
      type: "relay.app.message";
      connectionId: string;
      payload: AppClientMessage;
    };

export type RelayAppHelloMessage = {
  type: "app.connect";
  bridgeId: string;
};

export type RelayServerMessage =
  | {
      type: "relay.connected";
      connectionId: string;
    }
  | AppServerMessage;

export function safeJsonParse<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}
