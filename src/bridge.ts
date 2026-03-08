import path from "node:path";
import process from "node:process";
import { readFile } from "node:fs/promises";

import WebSocket from "ws";

import {
  appendHeartbeatReport,
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
import { shouldAutoContinueTurn as shouldAutoContinueTurnForContext } from "./turnLifecycle.js";
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
  deviceId: string;
  userText: string;
  assistantText: string;
  hadToolOutput: boolean;
  awaitingInteraction: boolean;
  startedAt: number;
  lastProgressAt: number;
  continuationCount: number;
  waitingNoticeSent: boolean;
  watchdogTimer: NodeJS.Timeout | null;
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
const threadTurnCounts = new Map<string, number>();
const deviceActiveWorkspaces = new Map<string, string>();
const pendingInteractions = new Map<string, PendingInteraction>();
const turnDiffs = new Map<string, string>();
const turnMemoryContexts = new Map<string, TurnMemoryContext>();
const pendingAssistantDeltas = new Map<string, { binding: ThreadBinding; itemId: string; text: string }>();
const pendingCommandDeltas = new Map<string, { binding: ThreadBinding; itemId: string; text: string }>();
let deltaFlushTimer: NodeJS.Timeout | null = null;
const WATCHDOG_SOFT_DELAY_MS = 20_000;
const WATCHDOG_HARD_DELAY_MS = 45_000;
const MAX_AUTO_CONTINUATIONS = 2;
const MAX_TURNS_PER_THREAD = 24;
const DELTA_FLUSH_INTERVAL_MS = Number(process.env.BRIDGE_DELTA_FLUSH_MS ?? "90");

let devices: PairedDeviceRecord[] = [];
let bridgeSocket: WebSocket | null = null;
let heartbeatTimer: NodeJS.Timeout | null = null;

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
startHeartbeatRunner();

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

function startHeartbeatRunner(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
  }

  const intervalMinutes = Math.max(5, config.heartbeatIntervalMinutes ?? 30);
  void runHeartbeatCheck();
  heartbeatTimer = setInterval(() => {
    void runHeartbeatCheck();
  }, intervalMinutes * 60_000);
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
    if (session.activeWorkspaceId) {
      void preheatWorkspaceSession(session, connectionId, session.activeWorkspaceId);
    }
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
    void preheatWorkspaceSession(session, connectionId, payload.workspaceId);
    return;
  case "workspace.preheat":
    requireAuthenticated(session);
    requireWorkspace(payload.workspaceId);
    void preheatWorkspaceSession(session, connectionId, payload.workspaceId);
    return;
  case "chat.send":
    requireAuthenticated(session);
    await sendChatMessage(session, connectionId, payload.workspaceId, payload.text);
    return;
  case "chat.newThread":
    requireAuthenticated(session);
    resetWorkspaceThread(session, connectionId, payload.workspaceId);
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

    const resumedThreadId = pending.payload.threadId;
    pendingInteractions.delete(payload.requestId);
    const turnContext = turnMemoryContexts.get(resumedThreadId);
    if (turnContext) {
      turnContext.awaitingInteraction = false;
      touchTurnProgress(resumedThreadId, false);
    }
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
  const trimmedText = text.trim();
  if (trimmedText === "/new" || trimmedText === "/reset") {
    resetWorkspaceThread(session, connectionId, workspaceId);
    return;
  }

  const workspace = requireWorkspace(workspaceId);
  const deviceId = requireDeviceId(session);
  const workspaceThreadKey = `${deviceId}:${workspaceId}`;
  session.activeWorkspaceId = workspaceId;
  rememberSessionWorkspace(session);
  const threadId = await ensureWorkspaceThread(session, connectionId, workspaceId);

  threadTurnCounts.set(threadId, (threadTurnCounts.get(threadId) ?? 0) + 1);

  push(connectionId, {
    type: "chat.user",
    workspaceId,
    threadId,
    text,
    timestamp: new Date().toISOString(),
  });

  turnMemoryContexts.set(threadId, {
    workspaceId,
    deviceId,
    userText: text,
    assistantText: "",
    hadToolOutput: false,
    awaitingInteraction: false,
    startedAt: Date.now(),
    lastProgressAt: Date.now(),
    continuationCount: 0,
    waitingNoticeSent: false,
    watchdogTimer: null,
  });
  scheduleTurnWatchdog(threadId, WATCHDOG_SOFT_DELAY_MS);

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

function resetWorkspaceThread(session: AppSession, connectionId: string, workspaceId: string): void {
  requireWorkspace(workspaceId);
  const deviceId = requireDeviceId(session);
  const workspaceThreadKey = `${deviceId}:${workspaceId}`;
  const threadId = workspaceThreads.get(workspaceThreadKey);

  if (threadId) {
    retireThread(workspaceThreadKey, threadId);
  }

  push(connectionId, {
    type: "chat.reset",
    workspaceId,
    message: "已开始新对话，旧线程已退休。",
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
    touchTurnProgress(payload.threadId, false);
    pushToBinding(binding, {
      type: "chat.status",
      workspaceId: binding.workspaceId,
      threadId: binding.threadId,
      status: localizedThreadStatus(payload.status.type, payload.status.activeFlags ?? []),
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
    touchTurnProgress(payload.threadId, false);
    queueDelta(pendingAssistantDeltas, binding, payload.itemId, payload.delta);
    break;
  }
  case "item/commandExecution/outputDelta": {
    const payload = params as { threadId: string; itemId: string; delta: string };
    const binding = threadBindings.get(payload.threadId);
    if (!binding) {
      return;
    }
    touchTurnProgress(payload.threadId, true);
    queueDelta(pendingCommandDeltas, binding, payload.itemId, payload.delta);
    break;
  }
  case "turn/completed": {
    const payload = params as { threadId: string };
    const binding = threadBindings.get(payload.threadId);
    flushQueuedDeltasForThread(payload.threadId);
    clearTurnDiffs(payload.threadId);
    void handleTurnCompleted(payload.threadId);
    if (!binding) {
      return;
    }
    break;
  }
  default:
    break;
  }
}

async function handleTurnCompleted(threadId: string): Promise<void> {
  const turnContext = turnMemoryContexts.get(threadId);
  if (!turnContext) {
    return;
  }

  clearTurnWatchdog(turnContext);
  if (turnContext.awaitingInteraction) {
    return;
  }

  if (shouldAutoContinueTurn(turnContext)) {
    await continueUnfinishedTurn(threadId, "上一轮还没真正完成，我继续把结果查完。");
    return;
  }

  await finalizeTurn(threadId);
}

async function persistTurnMemory(threadId: string): Promise<void> {
  const turnContext = turnMemoryContexts.get(threadId);
  if (!turnContext) {
    return;
  }

  clearTurnWatchdog(turnContext);
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

function scheduleTurnWatchdog(threadId: string, delayMs = WATCHDOG_SOFT_DELAY_MS): void {
  const turnContext = turnMemoryContexts.get(threadId);
  if (!turnContext) {
    return;
  }

  clearTurnWatchdog(turnContext);
  turnContext.watchdogTimer = setTimeout(() => {
    void handleTurnWatchdog(threadId);
  }, delayMs);
}

function clearTurnWatchdog(turnContext: TurnMemoryContext): void {
  if (!turnContext.watchdogTimer) {
    return;
  }
  clearTimeout(turnContext.watchdogTimer);
  turnContext.watchdogTimer = null;
}

function touchTurnProgress(threadId: string, hadToolOutput: boolean): void {
  const turnContext = turnMemoryContexts.get(threadId);
  if (!turnContext) {
    return;
  }

  turnContext.lastProgressAt = Date.now();
  if (hadToolOutput) {
    turnContext.hadToolOutput = true;
  }

  if (!turnContext.awaitingInteraction) {
    scheduleTurnWatchdog(threadId, WATCHDOG_SOFT_DELAY_MS);
  }
}

function markAwaitingInteraction(threadId: string): void {
  const turnContext = turnMemoryContexts.get(threadId);
  if (!turnContext) {
    return;
  }

  turnContext.awaitingInteraction = true;
  turnContext.lastProgressAt = Date.now();
  clearTurnWatchdog(turnContext);
}

async function handleTurnWatchdog(threadId: string): Promise<void> {
  const turnContext = turnMemoryContexts.get(threadId);
  if (!turnContext || turnContext.awaitingInteraction) {
    return;
  }

  const now = Date.now();
  const quietForMs = now - turnContext.lastProgressAt;
  const ageMs = now - turnContext.startedAt;

  if (quietForMs < WATCHDOG_SOFT_DELAY_MS - 1_000) {
    scheduleTurnWatchdog(threadId, WATCHDOG_SOFT_DELAY_MS);
    return;
  }

  if (ageMs < WATCHDOG_HARD_DELAY_MS) {
    scheduleTurnWatchdog(threadId, WATCHDOG_HARD_DELAY_MS - ageMs);
    return;
  }

  if (turnContext.continuationCount >= MAX_AUTO_CONTINUATIONS) {
    await finalizeTurn(threadId, "任务暂时停住了，已重置到新线程；你直接再发一句即可继续。");
    return;
  }

  await continueUnfinishedTurn(threadId, "上一轮似乎卡住了，我继续直接执行，不停在说明。");
}

function shouldAutoContinueTurn(turnContext: TurnMemoryContext): boolean {
  return shouldAutoContinueTurnForContext(turnContext, MAX_AUTO_CONTINUATIONS);
}

async function continueUnfinishedTurn(threadId: string, status: string): Promise<void> {
  const turnContext = turnMemoryContexts.get(threadId);
  const binding = threadBindings.get(threadId);
  if (!turnContext || !binding) {
    return;
  }

  const workspace = config.workspaces.find((item) => item.id === turnContext.workspaceId);
  if (!workspace) {
    return;
  }

  turnContext.continuationCount += 1;
  turnContext.lastProgressAt = Date.now();
  turnContext.awaitingInteraction = false;
  turnContext.waitingNoticeSent = false;
  scheduleTurnWatchdog(threadId, WATCHDOG_HARD_DELAY_MS);

  pushToBinding(binding, {
    type: "chat.status",
    workspaceId: binding.workspaceId,
    threadId: binding.threadId,
    status,
  });

  await codex.request("turn/start", {
    threadId,
    cwd: workspace.cwd,
    input: [
      {
        type: "text",
        text: [
          "Continue the same user task.",
          "The previous turn stopped before the user's goal was actually completed.",
          "Do not say you will check later.",
          "Directly use the necessary tools now and return the concrete result.",
          "If blocked, say the exact blocker.",
          "",
          `Original user request: ${turnContext.userText}`,
          "",
          `Previous partial assistant reply: ${turnContext.assistantText.trim() || "(empty)"}`,
        ].join("\n"),
      },
    ],
  });
}

async function finalizeTurn(threadId: string, status?: string): Promise<void> {
  const turnContext = turnMemoryContexts.get(threadId);
  const binding = threadBindings.get(threadId);
  if (!turnContext) {
    return;
  }

  clearTurnWatchdog(turnContext);
  await persistTurnMemory(threadId);

  if (!binding) {
    return;
  }

  if (status) {
    pushToBinding(binding, {
      type: "chat.status",
      workspaceId: binding.workspaceId,
      threadId: binding.threadId,
      status,
    });
  }

  pushToBinding(binding, {
    type: "chat.completed",
    workspaceId: binding.workspaceId,
    threadId: binding.threadId,
  });

  if (status?.includes("已重置到新线程")) {
    retireThread(`${binding.deviceId}:${binding.workspaceId}`, threadId);
  }
}

function retireThread(workspaceThreadKey: string, threadId: string): void {
  if (workspaceThreads.get(workspaceThreadKey) === threadId) {
    workspaceThreads.delete(workspaceThreadKey);
  }
  threadBindings.delete(threadId);
  threadTurnCounts.delete(threadId);
  turnMemoryContexts.delete(threadId);
  pendingInteractions.forEach((pending, requestId) => {
    if (pending.payload.threadId === threadId) {
      pendingInteractions.delete(requestId);
    }
  });
  clearTurnDiffs(threadId);
}

async function preheatWorkspacePrompt(workspaceId: string): Promise<void> {
  const workspace = config.workspaces.find((item) => item.id === workspaceId);
  if (!workspace) {
    return;
  }

  try {
    await buildAgentPrompt(agentPaths, workspace, "继续当前工作区的上下文。");
  } catch (error) {
    console.error(error);
  }
}

async function preheatWorkspaceSession(
  session: AppSession,
  connectionId: string,
  workspaceId: string,
): Promise<void> {
  await Promise.all([
    preheatWorkspacePrompt(workspaceId),
    ensureWorkspaceThread(session, connectionId, workspaceId),
  ]);
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

async function runHeartbeatCheck(): Promise<void> {
  try {
    const now = new Date();
    const staleTurnCount = Array.from(turnMemoryContexts.values()).filter((context) => {
      return now.getTime() - context.startedAt > 15 * 60_000;
    }).length;

    const staleInteractionCount = pendingInteractions.size;
    const connectedDevices = Array.from(sessions.values()).filter((session) => session.authenticated).length;
    const relayConnected = bridgeSocket?.readyState === WebSocket.OPEN;
    const codexConnected = codex.isConnected();

    const checks = [
      `Relay: ${relayConnected ? "connected" : "disconnected"}`,
      `Codex app-server: ${codexConnected ? "connected" : "disconnected"}`,
      `Authenticated devices: ${connectedDevices}`,
      `Pending interactions: ${staleInteractionCount}`,
      `Long-running turns (>15m): ${staleTurnCount}`,
    ];

    const summary = (!relayConnected || !codexConnected || staleTurnCount > 0)
      ? "attention-needed"
      : "healthy";

    await appendHeartbeatReport(agentPaths, {
      timestamp: now.toISOString(),
      summary,
      checks,
    });

    if (summary !== "healthy") {
      console.log(`[heartbeat] ${summary}: ${checks.join(" | ")}`);
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
    markAwaitingInteraction(binding.threadId);

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
    markAwaitingInteraction(binding.threadId);

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
    markAwaitingInteraction(binding.threadId);

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

function queueDelta(
  target: Map<string, { binding: ThreadBinding; itemId: string; text: string }>,
  binding: ThreadBinding,
  itemId: string,
  delta: string,
): void {
  const key = `${binding.threadId}:${itemId}`;
  const existing = target.get(key);
  if (existing) {
    existing.text += delta;
  } else {
    target.set(key, {
      binding: { ...binding },
      itemId,
      text: delta,
    });
  }
  scheduleDeltaFlush();
}

function scheduleDeltaFlush(): void {
  if (deltaFlushTimer) {
    return;
  }

  deltaFlushTimer = setTimeout(() => {
    deltaFlushTimer = null;
    flushQueuedDeltas();
  }, DELTA_FLUSH_INTERVAL_MS);
}

function flushQueuedDeltas(): void {
  flushDeltaMap(pendingAssistantDeltas, "chat.assistantDelta");
  flushDeltaMap(pendingCommandDeltas, "chat.commandDelta");
}

function flushQueuedDeltasForThread(threadId: string): void {
  flushDeltaMapForThread(pendingAssistantDeltas, "chat.assistantDelta", threadId);
  flushDeltaMapForThread(pendingCommandDeltas, "chat.commandDelta", threadId);
}

function flushDeltaMap(
  source: Map<string, { binding: ThreadBinding; itemId: string; text: string }>,
  type: "chat.assistantDelta" | "chat.commandDelta",
): void {
  for (const [key, value] of source) {
    source.delete(key);
    pushToBinding(value.binding, {
      type,
      workspaceId: value.binding.workspaceId,
      threadId: value.binding.threadId,
      itemId: value.itemId,
      delta: value.text,
    });
  }
}

function flushDeltaMapForThread(
  source: Map<string, { binding: ThreadBinding; itemId: string; text: string }>,
  type: "chat.assistantDelta" | "chat.commandDelta",
  threadId: string,
): void {
  for (const [key, value] of source) {
    if (value.binding.threadId !== threadId) {
      continue;
    }
    source.delete(key);
    pushToBinding(value.binding, {
      type,
      workspaceId: value.binding.workspaceId,
      threadId: value.binding.threadId,
      itemId: value.itemId,
      delta: value.text,
    });
  }
}

function localizedThreadStatus(type: string, activeFlags: string[]): string {
  if (activeFlags.some((flag) => /tool|exec|command/i.test(flag))) {
    return "调用工具中";
  }

  if (activeFlags.some((flag) => /input|approval/i.test(flag))) {
    return "等待你确认";
  }

  switch (type) {
  case "idle":
    return "当前空闲";
  case "running":
    return "执行中";
  case "waiting":
    return "等待结果";
  case "interrupted":
    return "已中断";
  case "errored":
  case "error":
    return "执行失败";
  default:
    return type;
  }
}

function shouldRetireThreadBeforeNextTurn(threadId: string): boolean {
  const turnCount = threadTurnCounts.get(threadId) ?? 0;
  if (turnCount < MAX_TURNS_PER_THREAD) {
    return false;
  }

  const turnContext = turnMemoryContexts.get(threadId);
  if (!turnContext) {
    return turnCount >= MAX_TURNS_PER_THREAD + 6;
  }

  return turnContext.continuationCount > 0 || turnCount >= MAX_TURNS_PER_THREAD + 6;
}

async function ensureWorkspaceThread(
  session: AppSession,
  connectionId: string,
  workspaceId: string,
): Promise<string> {
  const workspace = requireWorkspace(workspaceId);
  const deviceId = requireDeviceId(session);
  const workspaceThreadKey = `${deviceId}:${workspaceId}`;
  let threadId = workspaceThreads.get(workspaceThreadKey);

  if (threadId && shouldRetireThreadBeforeNextTurn(threadId)) {
    retireThread(workspaceThreadKey, threadId);
    threadId = undefined;
  }

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
    threadTurnCounts.set(threadId, 0);
  }

  const existingBinding = threadBindings.get(threadId);
  if (existingBinding) {
    existingBinding.connectionId = connectionId;
  } else {
    threadBindings.set(threadId, { workspaceId, threadId, deviceId, connectionId });
  }

  return threadId;
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
