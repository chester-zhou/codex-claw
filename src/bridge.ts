import path from "node:path";
import process from "node:process";
import { readFile } from "node:fs/promises";

import WebSocket from "ws";

import {
  appendMemoryTurn,
  buildAgentPrompt,
  createMemoryTurnRecord,
  ensureAgentScaffold,
  loadInboxEntries,
  loadAgentSettings,
  saveAgentSettings,
} from "./agentMemory.js";
import { CodexAppServerClient } from "./codexAppServerClient.js";
import { syncNativeCodexThreads } from "./nativeCodexMemorySync.js";
import {
  loadBridgeConfig,
  loadDeviceRegistry,
  loadPairingSessions,
  saveDeviceRegistry,
  savePairingSessions,
  type PairedDeviceRecord,
} from "./shared/config.js";
import { createChallenge, verifySignature } from "./shared/crypto.js";
import type {
  AppClientMessage,
  AppServerMessage,
  PendingInteractionKind,
  RelayBridgeIncomingMessage,
  RelayBridgeOutgoingMessage,
  RequestUserInputQuestion,
  WorkspaceDescriptor,
} from "./shared/protocol.js";

type PendingInteractionMessage = Extract<AppServerMessage, { type: "interaction.request" }>;

type AppSession = {
  connectionId: string;
  deviceId: string | null;
  authenticated: boolean;
  activeWorkspaceId: string | null;
  currentChallenge: {
    id: string;
    value: string;
  } | null;
};

type ThreadBinding = {
  workspaceId: string;
  threadId: string;
  deviceId: string;
  connectionId: string;
};

type TurnMemoryContext = {
  workspaceId: string;
  userText: string;
  assistantText: string;
};

type PendingInteraction = {
  connectionId: string;
  deviceId: string;
  serverRequestId: number;
  interactionKind: PendingInteractionKind;
  payload: PendingInteractionMessage;
};

const configPath = process.argv[2] ?? path.resolve(process.cwd(), "bridge.config.json");
const configDirectory = path.dirname(configPath);
const devicesPath = path.resolve(configDirectory, "data/devices.json");
const pairingSessionsPath = path.resolve(configDirectory, "data/pairing-sessions.json");

const sessions = new Map<string, AppSession>();
const threadBindings = new Map<string, ThreadBinding>();
const workspaceThreads = new Map<string, string>();
const deviceActiveWorkspaces = new Map<string, string>();
const pendingInteractions = new Map<string, PendingInteraction>();
const turnDiffs = new Map<string, string>();
const turnMemoryContexts = new Map<string, TurnMemoryContext>();

let devices: PairedDeviceRecord[] = [];
let bridgeSocket: WebSocket | null = null;

const config = await loadBridgeConfig(configPath);
const agentPaths = await ensureAgentScaffold(configDirectory, config.workspaces);
devices = await loadDeviceRegistry(devicesPath);
const relayBridgeToken = process.env.RELAY_BRIDGE_TOKEN;

if (!relayBridgeToken) {
  throw new Error("RELAY_BRIDGE_TOKEN is required for the bridge");
}

const bridgeToken = relayBridgeToken;

const relaySocketOptions = await createRelaySocketOptions();

const codex = new CodexAppServerClient(config.codexListenUrl);
codex.on("stderr", (line) => {
  console.log(`[codex] ${String(line).trim()}`);
});
codex.on("notification", (notification) => {
  handleCodexNotification(notification.method, notification.params);
});
codex.on("request", (request) => {
  handleCodexRequest(request.id, request.method, request.params);
});
await codex.start();
void runNativeMemorySync();
setInterval(() => {
  void runNativeMemorySync();
}, 60_000);

void connectRelay();

async function createRelaySocketOptions(): Promise<WebSocket.ClientOptions> {
  if (!config.relayCaPath) {
    return {};
  }

  const resolvedCaPath = path.isAbsolute(config.relayCaPath)
    ? config.relayCaPath
    : path.resolve(configDirectory, config.relayCaPath);

  const ca = await readFile(resolvedCaPath);
  return { ca };
}

function connectRelay(): void {
  bridgeSocket = new WebSocket(config.relayUrl, relaySocketOptions);

  bridgeSocket.on("open", () => {
    console.log(`Connected to relay at ${config.relayUrl}`);
    relaySend({
      type: "bridge.register",
      bridgeId: config.bridgeId,
      bridgeName: config.bridgeName,
      bridgeToken,
    });
  });

  bridgeSocket.on("message", (raw) => {
    const message = JSON.parse(raw.toString("utf8")) as RelayBridgeIncomingMessage;
    handleRelayMessage(message).catch((error) => {
      console.error(error);
    });
  });

  bridgeSocket.on("close", () => {
    console.log("Relay connection closed, retrying in 1s");
    setTimeout(connectRelay, 1000);
  });
}

async function handleRelayMessage(message: RelayBridgeIncomingMessage): Promise<void> {
  switch (message.type) {
  case "relay.app.connected":
    sessions.set(message.connectionId, {
      connectionId: message.connectionId,
      deviceId: null,
      authenticated: false,
      activeWorkspaceId: null,
      currentChallenge: null,
    });
    break;
  case "relay.app.disconnected":
    persistDisconnectedSession(message.connectionId);
    break;
  case "relay.app.message":
    try {
      await handleAppMessage(message.connectionId, message.payload);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unexpected bridge error";
      push(message.connectionId, {
        type: "error",
        message: errorMessage,
      });
    }
    break;
  }
}

async function handleAppMessage(connectionId: string, payload: AppClientMessage): Promise<void> {
  const session = requireSession(connectionId);

  switch (payload.type) {
  case "client.hello": {
    session.deviceId = payload.deviceId;
    const device = devices.find((item) => item.deviceId === payload.deviceId);
    if (!device) {
      push(connectionId, {
        type: "session.status",
        status: "pairingRequired",
        message: "This device is not paired. Enter the pairing code once to register it.",
      });
      return;
    }

    const challenge = createChallenge();
    session.currentChallenge = {
      id: challenge.challengeId,
      value: challenge.challenge,
    };
    push(connectionId, {
      type: "session.status",
      status: "authenticating",
      message: "Verifying paired device",
    });
    push(connectionId, {
      type: "session.challenge",
      challengeId: challenge.challengeId,
      challenge: challenge.challenge,
      bridgeName: config.bridgeName,
    });
    return;
  }
  case "client.pair": {
    const now = Date.now();
    const pairingSessions = await loadPairingSessions(pairingSessionsPath);
    const activeSessions = pairingSessions.filter((item) => new Date(item.expiresAt).getTime() > now);
    const pairingSession = activeSessions.find((item) => item.code === payload.pairingCode);

    if (!pairingSession) {
      push(connectionId, { type: "error", message: "Invalid pairing code" });
      return;
    }

    const existingDevice = devices.find((item) => item.deviceId === payload.deviceId);
    if (!existingDevice && devices.length > 0) {
      push(connectionId, {
        type: "error",
        message: "A different device is already paired. Clear data/devices.json before pairing a new iPhone.",
      });
      return;
    }

    const existingIndex = devices.findIndex((item) => item.deviceId === payload.deviceId);
    const nextRecord: PairedDeviceRecord = {
      deviceId: payload.deviceId,
      deviceName: payload.deviceName,
      publicKeyPem: payload.publicKeyPem,
      pairedAt: new Date().toISOString(),
    };

    if (existingIndex >= 0) {
      devices[existingIndex] = nextRecord;
    } else {
      devices = [nextRecord];
    }

    await saveDeviceRegistry(devicesPath, devices);
    await savePairingSessions(
      pairingSessionsPath,
      activeSessions.filter((item) => item.code !== pairingSession.code),
    );
    push(connectionId, {
      type: "session.status",
      status: "pairingAccepted",
      message: "Device paired. Reconnecting authentication.",
    });
    return;
  }
  case "client.auth": {
    if (!session.deviceId || !session.currentChallenge) {
      push(connectionId, { type: "error", message: "No active challenge" });
      return;
    }

    const device = devices.find((item) => item.deviceId === session.deviceId);
    if (!device) {
      push(connectionId, { type: "error", message: "Unknown paired device" });
      return;
    }

    const isValid = session.currentChallenge.id === payload.challengeId
      && verifySignature(device.publicKeyPem, session.currentChallenge.value, payload.signatureBase64);

    if (!isValid) {
      session.currentChallenge = null;
      session.authenticated = false;
      push(connectionId, {
        type: "session.status",
        status: "error",
        message: "Device authentication failed. Create a fresh pairing code and pair this device again.",
      });
      return;
    }

    session.currentChallenge = null;
    session.authenticated = true;
    session.activeWorkspaceId = deviceActiveWorkspaces.get(session.deviceId)
      ?? config.workspaces[0]?.id
      ?? null;

    push(connectionId, {
      type: "session.status",
      status: "ready",
      message: "Connected to Codex bridge",
    });
    pushWorkspaceState(connectionId, session.activeWorkspaceId);
    restoreSessionState(session, connectionId);
    return;
  }
  case "workspace.list":
    requireAuthenticated(session);
    pushWorkspaceState(connectionId, session.activeWorkspaceId);
    return;
  case "workspace.activate":
    requireAuthenticated(session);
    requireWorkspace(payload.workspaceId);
    session.activeWorkspaceId = payload.workspaceId;
    rememberSessionWorkspace(session);
    pushWorkspaceState(connectionId, session.activeWorkspaceId);
    return;
  case "chat.send":
    requireAuthenticated(session);
    await sendChatMessage(session, connectionId, payload.workspaceId, payload.text);
    return;
  case "chat.interrupt":
    requireAuthenticated(session);
    await codex.request("turn/interrupt", { threadId: payload.threadId });
    return;
  case "agent.settings.get":
    requireAuthenticated(session);
    push(connectionId, {
      type: "agent.settings.state",
      ...(await loadAgentSettings(agentPaths)),
    });
    return;
  case "agent.settings.save":
    requireAuthenticated(session);
    await saveAgentSettings(agentPaths, {
      soul: payload.soul,
      userNote: payload.userNote,
      globalMemory: payload.globalMemory,
    });
    push(connectionId, {
      type: "agent.settings.saved",
      message: "助手设定已保存",
    });
    push(connectionId, {
      type: "agent.settings.state",
      ...(await loadAgentSettings(agentPaths)),
    });
    return;
  case "agent.memory.inbox.get":
    requireAuthenticated(session);
    push(connectionId, {
      type: "agent.memory.inbox.state",
      entries: await loadInboxEntries(agentPaths, payload.limit ?? 30),
    });
    return;
  case "interaction.respond": {
    requireAuthenticated(session);
    const pending = pendingInteractions.get(payload.requestId);
    if (!pending) {
      push(connectionId, { type: "error", message: "Pending interaction expired" });
      return;
    }

    if (pending.interactionKind !== payload.interactionKind) {
      push(connectionId, { type: "error", message: "Interaction type mismatch" });
      return;
    }

    if (!canRespondToPendingInteraction(session, connectionId, pending)) {
      push(connectionId, { type: "error", message: "This interaction belongs to a different active session" });
      return;
    }

    switch (payload.interactionKind) {
    case "commandApproval":
      codex.respond(pending.serverRequestId, {
        decision: payload.decision,
      });
      break;
    case "fileChangeApproval":
      codex.respond(pending.serverRequestId, {
        decision: payload.decision,
      });
      break;
    case "requestUserInput":
      codex.respond(pending.serverRequestId, {
        answers: payload.answers,
      });
      break;
    }

    pendingInteractions.delete(payload.requestId);
    return;
  }
  }
}

async function sendChatMessage(
  session: AppSession,
  connectionId: string,
  workspaceId: string,
  text: string,
): Promise<void> {
  const workspace = requireWorkspace(workspaceId);
  const deviceId = requireDeviceId(session);
  const workspaceThreadKey = `${deviceId}:${workspaceId}`;
  let threadId = workspaceThreads.get(workspaceThreadKey);
  session.activeWorkspaceId = workspaceId;
  rememberSessionWorkspace(session);

  if (!threadId) {
    const response = await codex.request<{ thread: { id: string } }>("thread/start", {
      cwd: workspace.cwd,
      sandbox: workspace.sandbox,
      approvalPolicy: workspace.approvalPolicy,
      model: workspace.model ?? null,
      personality: "pragmatic",
    });

    threadId = response.thread.id;
    workspaceThreads.set(workspaceThreadKey, threadId);
    threadBindings.set(threadId, { workspaceId, threadId, deviceId, connectionId });
    push(connectionId, {
      type: "chat.thread",
      workspaceId,
      threadId,
    });
  } else if (!threadBindings.has(threadId)) {
    threadBindings.set(threadId, { workspaceId, threadId, deviceId, connectionId });
  } else {
    const binding = threadBindings.get(threadId);
    if (binding) {
      binding.connectionId = connectionId;
    }
  }

  push(connectionId, {
    type: "chat.user",
    workspaceId,
    threadId,
    text,
    timestamp: new Date().toISOString(),
  });

  turnMemoryContexts.set(threadId, {
    workspaceId,
    userText: text,
    assistantText: "",
  });

  await codex.request("turn/start", {
    threadId,
    cwd: workspace.cwd,
    input: [
      {
        type: "text",
        text: await buildAgentPrompt(agentPaths, workspace, text),
      },
    ],
  });
}

function handleCodexNotification(method: string, params: unknown): void {
  switch (method) {
  case "turn/diff/updated": {
    const payload = params as { threadId: string; turnId: string; diff: string };
    turnDiffs.set(turnDiffKey(payload.threadId, payload.turnId), payload.diff);
    break;
  }
  case "thread/status/changed": {
    const payload = params as { threadId: string; status: { type: string; activeFlags?: string[] } };
    const binding = threadBindings.get(payload.threadId);
    if (!binding) {
      return;
    }
    pushToBinding(binding, {
      type: "chat.status",
      workspaceId: binding.workspaceId,
      threadId: binding.threadId,
      status: payload.status.type,
    });
    break;
  }
  case "item/agentMessage/delta": {
    const payload = params as { threadId: string; itemId: string; delta: string };
    const binding = threadBindings.get(payload.threadId);
    if (!binding) {
      return;
    }
    const turnContext = turnMemoryContexts.get(payload.threadId);
    if (turnContext) {
      turnContext.assistantText += payload.delta;
    }
    pushToBinding(binding, {
      type: "chat.assistantDelta",
      workspaceId: binding.workspaceId,
      threadId: binding.threadId,
      itemId: payload.itemId,
      delta: payload.delta,
    });
    break;
  }
  case "item/commandExecution/outputDelta": {
    const payload = params as { threadId: string; itemId: string; delta: string };
    const binding = threadBindings.get(payload.threadId);
    if (!binding) {
      return;
    }
    pushToBinding(binding, {
      type: "chat.commandDelta",
      workspaceId: binding.workspaceId,
      threadId: binding.threadId,
      itemId: payload.itemId,
      delta: payload.delta,
    });
    break;
  }
  case "turn/completed": {
    const payload = params as { threadId: string };
    const binding = threadBindings.get(payload.threadId);
    clearTurnDiffs(payload.threadId);
    void persistTurnMemory(payload.threadId);
    if (!binding) {
      return;
    }
    pushToBinding(binding, {
      type: "chat.completed",
      workspaceId: binding.workspaceId,
      threadId: binding.threadId,
    });
    break;
  }
  default:
    break;
  }
}

async function persistTurnMemory(threadId: string): Promise<void> {
  const turnContext = turnMemoryContexts.get(threadId);
  if (!turnContext) {
    return;
  }

  turnMemoryContexts.delete(threadId);
  const workspace = config.workspaces.find((item) => item.id === turnContext.workspaceId);
  if (!workspace) {
    return;
  }

  await appendMemoryTurn(
    agentPaths,
    createMemoryTurnRecord({
      workspace,
      userText: turnContext.userText,
      assistantText: turnContext.assistantText,
    }),
  );
}

async function runNativeMemorySync(): Promise<void> {
  try {
    const imported = await syncNativeCodexThreads(agentPaths, config.workspaces);
    if (imported > 0) {
      console.log(`Synced ${imported} native Codex thread(s) into shared memory`);
    }
  } catch (error) {
    console.error(error);
  }
}

function handleCodexRequest(id: number, method: string, params: unknown): void {
  switch (method) {
  case "item/commandExecution/requestApproval": {
    const payload = params as {
      itemId: string;
      threadId: string;
      command?: string | null;
      cwd?: string | null;
      reason?: string | null;
    };

    const binding = threadBindings.get(payload.threadId);
    if (!binding) {
      codex.respond(id, { decision: "denied" });
      return;
    }

    const targetSession = resolveSession(binding);
    if (!targetSession) {
      codex.respond(id, { decision: "denied" });
      return;
    }

    const interactionPayload: PendingInteractionMessage = {
      type: "interaction.request",
      requestId: `interaction-${id}`,
      interactionKind: "commandApproval",
      workspaceId: binding.workspaceId,
      threadId: binding.threadId,
      command: payload.command,
      cwd: payload.cwd,
      reason: payload.reason,
    };

    const requestId = registerPendingInteraction(
      targetSession.connectionId,
      binding.deviceId,
      id,
      interactionPayload,
    );

    push(targetSession.connectionId, {
      ...interactionPayload,
      requestId,
    });
    break;
  }
  case "item/fileChange/requestApproval": {
    const payload = params as {
      itemId: string;
      threadId: string;
      turnId: string;
      reason?: string | null;
      grantRoot?: string | null;
    };

    const binding = threadBindings.get(payload.threadId);
    if (!binding) {
      codex.respond(id, { decision: "decline" });
      return;
    }

    const targetSession = resolveSession(binding);
    if (!targetSession) {
      codex.respond(id, { decision: "decline" });
      return;
    }

    const interactionPayload: PendingInteractionMessage = {
      type: "interaction.request",
      requestId: `interaction-${id}`,
      interactionKind: "fileChangeApproval",
      workspaceId: binding.workspaceId,
      threadId: binding.threadId,
      turnId: payload.turnId,
      reason: payload.reason,
      grantRoot: payload.grantRoot,
      diff: turnDiffs.get(turnDiffKey(payload.threadId, payload.turnId)) ?? null,
    };

    const requestId = registerPendingInteraction(
      targetSession.connectionId,
      binding.deviceId,
      id,
      interactionPayload,
    );

    push(targetSession.connectionId, {
      ...interactionPayload,
      requestId,
    });
    break;
  }
  case "item/tool/requestUserInput": {
    const payload = params as {
      itemId: string;
      threadId: string;
      turnId: string;
      questions: RequestUserInputQuestion[];
    };

    const binding = threadBindings.get(payload.threadId);
    if (!binding) {
      codex.respond(id, { answers: {} });
      return;
    }

    const targetSession = resolveSession(binding);
    if (!targetSession) {
      codex.respond(id, { answers: {} });
      return;
    }

    const interactionPayload: PendingInteractionMessage = {
      type: "interaction.request",
      requestId: `interaction-${id}`,
      interactionKind: "requestUserInput",
      workspaceId: binding.workspaceId,
      threadId: binding.threadId,
      turnId: payload.turnId,
      questions: payload.questions,
    };

    const requestId = registerPendingInteraction(
      targetSession.connectionId,
      binding.deviceId,
      id,
      interactionPayload,
    );

    push(targetSession.connectionId, {
      ...interactionPayload,
      requestId,
    });
    break;
  }
  default:
    codex.respond(id, { decision: "denied" });
    break;
  }
}

function registerPendingInteraction(
  connectionId: string,
  deviceId: string,
  serverRequestId: number,
  payload: PendingInteractionMessage,
): string {
  const requestId = `interaction-${serverRequestId}`;
  pendingInteractions.set(requestId, {
    connectionId,
    deviceId,
    serverRequestId,
    interactionKind: payload.interactionKind as PendingInteractionKind,
    payload: {
      ...payload,
      requestId,
    },
  });
  return requestId;
}

function canRespondToPendingInteraction(
  session: AppSession,
  connectionId: string,
  pending: PendingInteraction,
): boolean {
  if (pending.connectionId === connectionId) {
    return true;
  }

  const originalSession = sessions.get(pending.connectionId);
  const isOriginalSessionStillActive = originalSession?.authenticated && originalSession.deviceId === pending.deviceId;
  if (isOriginalSessionStillActive) {
    return false;
  }

  if (session.deviceId !== pending.deviceId) {
    return false;
  }

  pending.connectionId = connectionId;
  return true;
}

function turnDiffKey(threadId: string, turnId: string): string {
  return `${threadId}:${turnId}`;
}

function clearTurnDiffs(threadId: string): void {
  for (const key of turnDiffs.keys()) {
    if (key.startsWith(`${threadId}:`)) {
      turnDiffs.delete(key);
    }
  }
}

function pushWorkspaceState(connectionId: string, activeWorkspaceId: string | null): void {
  push(connectionId, {
    type: "workspace.state",
    workspaces: config.workspaces,
    activeWorkspaceId,
  });
}

function restoreSessionState(session: AppSession, connectionId: string): void {
  const deviceId = session.deviceId;
  if (!deviceId) {
    return;
  }

  const activeWorkspaceId = session.activeWorkspaceId;
  if (activeWorkspaceId) {
    const threadId = workspaceThreads.get(`${deviceId}:${activeWorkspaceId}`);
    if (threadId) {
      push(connectionId, {
        type: "chat.status",
        workspaceId: activeWorkspaceId,
        threadId,
        status: "已恢复到上一次工作区，可继续当前线程",
      });
    }
  }

  for (const pending of pendingInteractions.values()) {
    if (pending.deviceId !== deviceId) {
      continue;
    }
    pending.connectionId = connectionId;
    push(connectionId, pending.payload);
  }
}

function persistDisconnectedSession(connectionId: string): void {
  const session = sessions.get(connectionId);
  if (session) {
    rememberSessionWorkspace(session);
  }
  sessions.delete(connectionId);
}

function rememberSessionWorkspace(session: AppSession): void {
  if (!session.deviceId || !session.activeWorkspaceId) {
    return;
  }
  deviceActiveWorkspaces.set(session.deviceId, session.activeWorkspaceId);
}

function pushToBinding(binding: ThreadBinding, payload: AppServerMessage): void {
  const targetSession = resolveSession(binding);
  if (!targetSession) {
    return;
  }

  push(targetSession.connectionId, payload);
}

function push(connectionId: string, payload: AppServerMessage): void {
  relaySend({
    type: "bridge.push",
    connectionId,
    payload,
  });
}

function relaySend(message: RelayBridgeOutgoingMessage | { type: "bridge.register"; bridgeId: string; bridgeName: string; bridgeToken: string }): void {
  if (!bridgeSocket || bridgeSocket.readyState !== WebSocket.OPEN) {
    throw new Error("Relay websocket is not connected");
  }

  bridgeSocket.send(JSON.stringify(message));
}

function requireSession(connectionId: string): AppSession {
  const session = sessions.get(connectionId);
  if (!session) {
    throw new Error(`Unknown app session ${connectionId}`);
  }
  return session;
}

function requireAuthenticated(session: AppSession): void {
  if (!session.authenticated) {
    throw new Error("App session is not authenticated");
  }
}

function requireDeviceId(session: AppSession): string {
  if (!session.deviceId) {
    throw new Error("App session is missing a device identity");
  }
  return session.deviceId;
}

function requireWorkspace(workspaceId: string): WorkspaceDescriptor {
  const workspace = config.workspaces.find((item) => item.id === workspaceId);
  if (!workspace) {
    throw new Error(`Unknown workspace ${workspaceId}`);
  }
  return workspace;
}

function sessionsForDevice(deviceId: string): AppSession[] {
  return Array.from(sessions.values()).filter(
    (session) => session.authenticated && session.deviceId === deviceId,
  );
}

function resolveSession(binding: ThreadBinding): AppSession | null {
  const currentSession = sessions.get(binding.connectionId);
  if (currentSession?.authenticated && currentSession.deviceId === binding.deviceId) {
    return currentSession;
  }

  const fallbackSession = sessionsForDevice(binding.deviceId)[0] ?? null;
  if (fallbackSession) {
    binding.connectionId = fallbackSession.connectionId;
  }
  return fallbackSession;
}
