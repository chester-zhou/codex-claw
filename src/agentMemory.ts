import { access, appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { WorkspaceDescriptor } from "./shared/protocol.js";

export type AgentPaths = {
  root: string;
  soul: string;
  user: string;
  memoryRoot: string;
  global: string;
  profile: string;
  workspacesRoot: string;
  inboxLog: string;
  workspaceLogsRoot: string;
  nativeSyncState: string;
};

export type MemoryTurnRecord = {
  timestamp: string;
  workspaceId: string;
  workspaceName: string;
  userText: string;
  assistantSummary: string;
  openLoops: string[];
  source?: string;
};

export type AgentSettingsSnapshot = {
  soul: string;
  userNote: string;
  globalMemory: string;
};

const DEFAULT_SOUL = `# Soul

Name: Codex Chat

## Role
- You are a durable coding partner running through a remote Codex bridge.
- You help from an iPhone-first interface, so your replies must stay compact, clear, and useful.

## Style
- Default to Simplified Chinese unless the user explicitly asks otherwise.
- Prioritize action, concrete decisions, and next steps.
- Keep answers short enough to read comfortably on a phone.
- Avoid long raw URLs. Prefer short source names or product names.

## Behavior
- Remember stable user preferences and workspace conventions.
- Be explicit about blockers, risks, and what still needs approval.
- When continuing work, prefer resuming existing context over starting from scratch.
`;

const DEFAULT_USER = `# User

- Prefers concise, direct communication.
- Uses iPhone as a remote control surface for Codex on Mac.
- Often wants implementation first, explanation second.
`;

const DEFAULT_PROFILE = `# Profile Memory

Write durable user preferences, working habits, and recurring expectations here.
Only store stable facts that help future turns.
`;

const DEFAULT_GLOBAL = `# Global Memory

Use this file for durable context shared across all workspaces and projects:
- recurring preferences
- stable collaboration rules
- long-running initiatives
- cross-project reminders
`;

function defaultWorkspaceMemory(workspace: WorkspaceDescriptor): string {
  return `# Workspace Memory: ${workspace.name}

Path: ${workspace.cwd}

Use this file for durable project context:
- architecture facts
- coding conventions
- important TODOs
- release or deployment notes
`;
}

export async function ensureAgentScaffold(
  configDirectory: string,
  workspaces: WorkspaceDescriptor[],
): Promise<AgentPaths> {
  const root = path.resolve(configDirectory, "agent");
  const memoryRoot = path.join(root, "memory");
  const workspacesRoot = path.join(memoryRoot, "workspaces");
  const workspaceLogsRoot = path.join(memoryRoot, "workspace-logs");
  const paths: AgentPaths = {
    root,
    soul: path.join(root, "SOUL.md"),
    user: path.join(root, "USER.md"),
    memoryRoot,
    global: path.join(memoryRoot, "global.md"),
    profile: path.join(memoryRoot, "profile.md"),
    workspacesRoot,
    inboxLog: path.join(memoryRoot, "inbox.jsonl"),
    workspaceLogsRoot,
    nativeSyncState: path.join(memoryRoot, "native-sync-state.json"),
  };

  await mkdir(workspacesRoot, { recursive: true });
  await mkdir(workspaceLogsRoot, { recursive: true });
  await ensureFile(paths.soul, DEFAULT_SOUL);
  await ensureFile(paths.user, DEFAULT_USER);
  await ensureFile(paths.global, DEFAULT_GLOBAL);
  await ensureFile(paths.profile, DEFAULT_PROFILE);
  await ensureFile(paths.inboxLog, "");
  await ensureFile(paths.nativeSyncState, "{\n  \"syncedThreads\": {}\n}");

  for (const workspace of workspaces) {
    await ensureFile(
      path.join(workspacesRoot, `${workspace.id}.md`),
      defaultWorkspaceMemory(workspace),
    );
  }

  return paths;
}

export async function buildAgentPrompt(
  paths: AgentPaths,
  workspace: WorkspaceDescriptor,
  userText: string,
): Promise<string> {
  const [soul, user, globalMemory, profile, workspaceMemory, inboxContext] = await Promise.all([
    safeRead(paths.soul),
    safeRead(paths.user),
    safeRead(paths.global),
    safeRead(paths.profile),
    safeRead(path.join(paths.workspacesRoot, `${workspace.id}.md`)),
    readRecentInbox(paths.inboxLog),
  ]);

  return [
    "Mobile response rules:",
    "You are replying inside a compact iPhone chat UI.",
    "Default to Simplified Chinese unless the user explicitly asks for another language.",
    "Keep replies concise and high-signal.",
    "Do not include raw long URLs unless the user explicitly asks for a full link.",
    "When a source or site matters, mention only a short label or product name instead of pasting the full URL.",
    "Use short paragraphs and short lists that fit on mobile screens.",
    "",
    "Agent identity:",
    soul.trim(),
    "",
    "User memory:",
    user.trim(),
    "",
    "Global memory:",
    globalMemory.trim(),
    "",
    "Profile memory:",
    profile.trim(),
    "",
    `Workspace memory (${workspace.name}):`,
    workspaceMemory.trim(),
    "",
    "Recent durable context:",
    inboxContext.trim() || "No recent durable context yet.",
    "",
    "User request:",
    userText,
  ].join("\n");
}

export async function appendMemoryTurn(paths: AgentPaths, record: MemoryTurnRecord): Promise<void> {
  await appendFile(paths.inboxLog, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  await appendFile(
    path.join(paths.workspaceLogsRoot, `${record.workspaceId}.jsonl`),
    `${JSON.stringify(record)}\n`,
    { mode: 0o600 },
  );
}

export async function loadInboxEntries(paths: AgentPaths, limit = 30): Promise<MemoryTurnRecord[]> {
  const raw = await safeRead(paths.inboxLog);
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as MemoryTurnRecord];
      } catch {
        return [];
      }
    })
    .slice(-limit)
    .reverse();
}

export async function loadNativeSyncState(paths: AgentPaths): Promise<Record<string, number>> {
  try {
    const raw = await readFile(paths.nativeSyncState, "utf8");
    const parsed = JSON.parse(raw) as { syncedThreads?: Record<string, number> };
    return parsed.syncedThreads ?? {};
  } catch {
    return {};
  }
}

export async function saveNativeSyncState(paths: AgentPaths, syncedThreads: Record<string, number>): Promise<void> {
  await writeFile(
    paths.nativeSyncState,
    JSON.stringify({ syncedThreads }, null, 2),
    { mode: 0o600 },
  );
}

export async function loadAgentSettings(paths: AgentPaths): Promise<AgentSettingsSnapshot> {
  const [soul, userNote, globalMemory] = await Promise.all([
    safeRead(paths.soul),
    safeRead(paths.user),
    safeRead(paths.global),
  ]);

  return { soul, userNote, globalMemory };
}

export async function saveAgentSettings(
  paths: AgentPaths,
  settings: AgentSettingsSnapshot,
): Promise<void> {
  await Promise.all([
    writeFile(paths.soul, settings.soul, { mode: 0o600 }),
    writeFile(paths.user, settings.userNote, { mode: 0o600 }),
    writeFile(paths.global, settings.globalMemory, { mode: 0o600 }),
  ]);
}

function summarizeAssistantText(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) {
    return "No assistant summary captured.";
  }
  return compact.slice(0, 320);
}

export function createMemoryTurnRecord(params: {
  workspace: WorkspaceDescriptor;
  userText: string;
  assistantText: string;
}): MemoryTurnRecord {
  return {
    timestamp: new Date().toISOString(),
    workspaceId: params.workspace.id,
    workspaceName: params.workspace.name,
    userText: params.userText.trim().slice(0, 320),
    assistantSummary: summarizeAssistantText(params.assistantText),
    openLoops: extractOpenLoops(params.assistantText),
  };
}

async function ensureFile(filePath: string, content: string): Promise<void> {
  try {
    await access(filePath);
  } catch {
    await writeFile(filePath, content, { mode: 0o600 });
  }
}

async function safeRead(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

async function readRecentInbox(filePath: string): Promise<string> {
  const raw = await safeRead(filePath);
  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-6);

  const entries = lines.flatMap((line) => {
    try {
      const item = JSON.parse(line) as MemoryTurnRecord;
      const loops = item.openLoops.length > 0 ? ` | open: ${item.openLoops.join("; ")}` : "";
      return [`- [${item.workspaceName}] ${item.userText} => ${item.assistantSummary}${loops}`];
    } catch {
      return [];
    }
  });

  return entries.join("\n");
}

function extractOpenLoops(text: string): string[] {
  const sentences = text
    .split(/\n+/)
    .map((item) => item.replace(/^\d+\.\s*/, "").trim())
    .filter(Boolean);

  return sentences
    .filter((item) => /下一步|接下来|还需要|待做|需要你|建议/.test(item))
    .slice(0, 3)
    .map((item) => item.slice(0, 120));
}
