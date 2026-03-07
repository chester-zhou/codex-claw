import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import os from "node:os";

import {
  appendMemoryTurn,
  loadNativeSyncState,
  saveNativeSyncState,
  type AgentPaths,
  type MemoryTurnRecord,
} from "./agentMemory.js";
import type { WorkspaceDescriptor } from "./shared/protocol.js";

const execFileAsync = promisify(execFile);

type NativeThreadRow = {
  id: string;
  rollout_path: string;
  cwd: string;
  title: string;
  updated_at: number;
};

export async function syncNativeCodexThreads(
  agentPaths: AgentPaths,
  workspaces: WorkspaceDescriptor[],
): Promise<number> {
  const databasePath = await findCodexStateDb();
  if (!databasePath) {
    return 0;
  }

  const threads = await loadThreadRows(databasePath);
  const syncState = await loadNativeSyncState(agentPaths);
  let imported = 0;

  for (const thread of threads) {
    if (isBridgeInjectedThread(thread.title)) {
      continue;
    }

    if (syncState[thread.id] && syncState[thread.id] >= thread.updated_at) {
      continue;
    }

    const record = await buildMemoryRecordFromThread(thread, workspaces);
    syncState[thread.id] = thread.updated_at;
    if (!record) {
      continue;
    }

    await appendMemoryTurn(agentPaths, record);
    imported += 1;
  }

  await saveNativeSyncState(agentPaths, syncState);
  return imported;
}

async function findCodexStateDb(): Promise<string | null> {
  const codexHome = JSON.stringify(`${os.homedir()}/.codex`);
  const script = `
import glob, os, json
root = os.path.expanduser(${codexHome})
paths = sorted(glob.glob(os.path.join(root, 'state_*.sqlite')))
print(json.dumps(paths[-1] if paths else None))
`;
  const { stdout } = await execFileAsync("python3", ["-c", script]);
  return JSON.parse(stdout.trim()) as string | null;
}

async function loadThreadRows(databasePath: string): Promise<NativeThreadRow[]> {
  const script = `
import sqlite3, json, sys
db = sys.argv[1]
con = sqlite3.connect(db)
cur = con.cursor()
cur.execute("select id, rollout_path, cwd, title, updated_at from threads where archived = 0 order by updated_at desc limit 120")
rows = [{"id": r[0], "rollout_path": r[1], "cwd": r[2], "title": r[3], "updated_at": r[4]} for r in cur.fetchall()]
print(json.dumps(rows, ensure_ascii=False))
`;
  const { stdout } = await execFileAsync("python3", ["-c", script, databasePath], { maxBuffer: 10 * 1024 * 1024 });
  return JSON.parse(stdout) as NativeThreadRow[];
}

async function buildMemoryRecordFromThread(
  thread: NativeThreadRow,
  workspaces: WorkspaceDescriptor[],
): Promise<MemoryTurnRecord | null> {
  const workspace = resolveWorkspace(thread.cwd, workspaces);
  const payload = await extractRolloutSummary(thread.rollout_path);
  if (!payload.userText && !payload.assistantText) {
    return null;
  }

  return {
    timestamp: new Date(thread.updated_at * 1000).toISOString(),
    workspaceId: workspace?.id ?? "global",
    workspaceName: workspace?.name ?? shortWorkspaceName(thread.cwd),
    userText: payload.userText || thread.title,
    assistantSummary: summarizeAssistant(payload.assistantText),
    openLoops: extractOpenLoops(payload.assistantText),
    source: "codex-native",
  };
}

async function extractRolloutSummary(rolloutPath: string): Promise<{ userText: string; assistantText: string }> {
  try {
    const raw = await readFile(rolloutPath, "utf8");
    let userText = "";
    let assistantText = "";

    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      const item = JSON.parse(line) as {
        type?: string;
        payload?: {
          type?: string;
          message?: string;
          role?: string;
          content?: { type?: string; text?: string }[];
        };
      };

      if (item.type === "event_msg" && item.payload?.type === "user_message" && item.payload.message) {
        userText = item.payload.message.trim();
      }

      if (item.type === "event_msg" && item.payload?.type === "agent_message" && item.payload.message) {
        assistantText = item.payload.message.trim();
      }

      if (
        item.type === "response_item"
        && item.payload?.type === "message"
        && item.payload.role === "assistant"
        && Array.isArray(item.payload.content)
      ) {
        const joined = item.payload.content
          .map((part) => part.text ?? "")
          .join("\n")
          .trim();
        if (joined) {
          assistantText = joined;
        }
      }
    }

    return { userText, assistantText };
  } catch {
    return { userText: "", assistantText: "" };
  }
}

function resolveWorkspace(cwd: string, workspaces: WorkspaceDescriptor[]): WorkspaceDescriptor | null {
  return workspaces.find((workspace) => cwd.startsWith(workspace.cwd)) ?? null;
}

function shortWorkspaceName(cwd: string): string {
  const parts = cwd.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}

function summarizeAssistant(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact ? compact.slice(0, 320) : "No assistant summary captured.";
}

function extractOpenLoops(text: string): string[] {
  return text
    .split(/\n+/)
    .map((item) => item.replace(/^\d+\.\s*/, "").trim())
    .filter((item) => /下一步|接下来|还需要|待做|需要你|建议/.test(item))
    .slice(0, 3)
    .map((item) => item.slice(0, 120));
}

function isBridgeInjectedThread(title: string): boolean {
  return title.startsWith("Mobile response rules:");
}
