import { createHash } from "node:crypto";
import { access, appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type { WorkspaceDescriptor } from "./shared/protocol.js";

export type AgentPaths = {
  root: string;
  agents: string;
  soul: string;
  identity: string;
  user: string;
  heartbeat: string;
  memoryRoot: string;
  global: string;
  profile: string;
  learnings: string;
  bankRoot: string;
  worldBank: string;
  experienceBank: string;
  opinionsBank: string;
  workspacesRoot: string;
  inboxLog: string;
  workspaceLogsRoot: string;
  dailyLogsRoot: string;
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

const MAX_EXPERIENCE_BANK_ITEMS = 12;
const MAX_OPINION_BANK_ITEMS = 12;

type PromptMode = "fast" | "full";

type PromptCacheEntry = {
  signature: string;
  prefix: string;
};

const promptPrefixCache = new Map<string, PromptCacheEntry>();

export type HeartbeatReport = {
  timestamp: string;
  summary: string;
  checks: string[];
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

const DEFAULT_AGENTS = `# AGENTS

- Prefer concise, execution-first collaboration.
- Default to Chinese.
- Optimize for small-screen readability.
- Avoid long raw URLs.
- Resume existing context when safe, but allow explicit resets with /new or /reset.
`;

const DEFAULT_IDENTITY = `# IDENTITY

- Name: 五七大龙虾
- Creature: Remote coding lobster
- Vibe: concise, pragmatic, lightly humorous
- Signature: short answers, direct execution, compact mobile-friendly output
`;

const DEFAULT_USER = `# User

- Prefers concise, direct communication.
- Uses iPhone as a remote control surface for Codex on Mac.
- Often wants implementation first, explanation second.
`;

const DEFAULT_HEARTBEAT = `# HEARTBEAT

<!-- Leave only small, stable checklist items here. Empty heartbeat files should cost almost nothing. -->

- Check whether there are blocked follow-ups worth surfacing next time.
- Keep alerts concise and actionable.
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

const DEFAULT_LEARNINGS = `# LEARNINGS

- Capture only reusable lessons:
  - stable user preferences
  - durable workflow improvements
  - repeated failure patterns worth avoiding
- Do not dump per-turn chatter here.
`;

const DEFAULT_WORLD_BANK = `# World

Stable, objective facts that matter across projects.
Keep this short and curated.
`;

const DEFAULT_EXPERIENCE_BANK = `# Experience

Durable notes about what has been tried, what worked, and what failed repeatedly.
`;

const DEFAULT_OPINIONS_BANK = `# Opinions

Stable preferences, heuristics, and judgments with enough evidence to be worth reusing.
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
  const bankRoot = path.join(memoryRoot, "bank");
  const workspacesRoot = path.join(memoryRoot, "workspaces");
  const workspaceLogsRoot = path.join(memoryRoot, "workspace-logs");
  const paths: AgentPaths = {
    root,
    agents: path.join(root, "AGENTS.md"),
    soul: path.join(root, "SOUL.md"),
    identity: path.join(root, "IDENTITY.md"),
    user: path.join(root, "USER.md"),
    heartbeat: path.join(root, "HEARTBEAT.md"),
    memoryRoot,
    global: path.join(memoryRoot, "global.md"),
    profile: path.join(memoryRoot, "profile.md"),
    learnings: path.join(memoryRoot, "LEARNINGS.md"),
    bankRoot,
    worldBank: path.join(bankRoot, "world.md"),
    experienceBank: path.join(bankRoot, "experience.md"),
    opinionsBank: path.join(bankRoot, "opinions.md"),
    workspacesRoot,
    inboxLog: path.join(memoryRoot, "inbox.jsonl"),
    workspaceLogsRoot,
    dailyLogsRoot: path.join(memoryRoot, "daily"),
    nativeSyncState: path.join(memoryRoot, "native-sync-state.json"),
  };

  await mkdir(workspacesRoot, { recursive: true });
  await mkdir(workspaceLogsRoot, { recursive: true });
  await mkdir(paths.dailyLogsRoot, { recursive: true });
  await mkdir(bankRoot, { recursive: true });
  await ensureFile(paths.agents, DEFAULT_AGENTS);
  await ensureFile(paths.soul, DEFAULT_SOUL);
  await ensureFile(paths.identity, DEFAULT_IDENTITY);
  await ensureFile(paths.user, DEFAULT_USER);
  await ensureFile(paths.heartbeat, DEFAULT_HEARTBEAT);
  await ensureFile(paths.global, DEFAULT_GLOBAL);
  await ensureFile(paths.profile, DEFAULT_PROFILE);
  await ensureFile(paths.learnings, DEFAULT_LEARNINGS);
  await ensureFile(paths.worldBank, DEFAULT_WORLD_BANK);
  await ensureFile(paths.experienceBank, DEFAULT_EXPERIENCE_BANK);
  await ensureFile(paths.opinionsBank, DEFAULT_OPINIONS_BANK);
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
  const promptMode = selectPromptMode(userText);
  const prefix = await buildAgentPromptPrefix(paths, workspace, promptMode);
  return [prefix, "", "User request:", userText].join("\n");
}

async function buildAgentPromptPrefix(
  paths: AgentPaths,
  workspace: WorkspaceDescriptor,
  mode: PromptMode,
): Promise<string> {
  const cacheKey = `${workspace.id}:${mode}`;
  const signature = await buildPromptSignature(paths, workspace, mode);
  const cached = promptPrefixCache.get(cacheKey);
  if (cached && cached.signature === signature) {
    return cached.prefix;
  }

  const [agents, soul, identity, user, workspaceMemory, inboxContext] = await Promise.all([
    safeRead(paths.agents),
    safeRead(paths.soul),
    safeRead(paths.identity),
    safeRead(paths.user),
    safeRead(path.join(paths.workspacesRoot, `${workspace.id}.md`)),
    readRecentInbox(paths.inboxLog, mode === "fast" ? 1 : 3),
  ]);

  const sections = [
    "Mobile response rules:",
    "You are replying inside a compact iPhone chat UI.",
    "Default to Simplified Chinese unless the user explicitly asks for another language.",
    "Keep replies concise and high-signal.",
    "Do not include raw long URLs unless the user explicitly asks for a full link.",
    "When a source or site matters, mention only a short label or product name instead of pasting the full URL.",
    "Use short paragraphs and short lists that fit on mobile screens.",
    "Do not stop at promises like '我去查' or '稍等'. If a lookup or tool call is needed, actually do it in this turn.",
    "Do not end the turn until the user's goal is completed or you can state the exact blocker.",
    "",
    "Workspace rules:",
    compactSection(agents, 560),
    "",
    "Agent identity:",
    compactSection(soul, 900),
    "",
    "Identity card:",
    compactSection(identity, 360),
    "",
    "User memory:",
    compactSection(user, 520),
    "",
    `Workspace memory (${workspace.name}):`,
    compactSection(workspaceMemory, 620),
    "",
  ];

  if (inboxContext.trim()) {
    sections.push("Recent durable context:");
    sections.push(inboxContext.trim());
    sections.push("");
  }

  if (mode === "full") {
    const [heartbeat, globalMemory, profile, learnings, worldBank, opinionsBank, dailyContext] = await Promise.all([
      safeRead(paths.heartbeat),
      safeRead(paths.global),
      safeRead(paths.profile),
      safeRead(paths.learnings),
      safeRead(paths.worldBank),
      safeRead(paths.opinionsBank),
      readRecentDailyLogs(paths.dailyLogsRoot, 2),
    ]);

    sections.push(
      "Heartbeat checklist:",
      compactSection(nonEmptyMarkdown(heartbeat) || "No heartbeat checklist.", 280),
      "",
      "Global memory:",
      compactSection(globalMemory, 620),
      "",
      "Profile memory:",
      compactSection(profile, 520),
      "",
      "Reusable learnings:",
      compactSection(learnings, 520),
      "",
      "World bank:",
      compactSection(worldBank, 320),
      "",
      "Opinion bank:",
      compactSection(opinionsBank, 380),
      "",
      "Recent handover:",
      dailyContext.trim() || "No recent handover yet.",
      "",
    );
  }

  const prefix = sections.join("\n");

  promptPrefixCache.set(cacheKey, {
    signature,
    prefix,
  });
  return prefix;
}

async function buildPromptSignature(
  paths: AgentPaths,
  workspace: WorkspaceDescriptor,
  mode: PromptMode,
): Promise<string> {
  const today = new Date();
  const dayOffsets = mode === "fast" ? [0] : [0, 1];
  const fileNames = dayOffsets
    .map((offset) => {
      const date = new Date(today);
      date.setDate(today.getDate() - offset);
      return `${date.toISOString().slice(0, 10)}.md`;
    });

  const baseFiles = [
    paths.agents,
    paths.soul,
    paths.identity,
    paths.user,
    path.join(paths.workspacesRoot, `${workspace.id}.md`),
    paths.inboxLog,
  ];

  const files = mode === "fast"
    ? baseFiles
    : [
        ...baseFiles,
        paths.heartbeat,
        paths.global,
        paths.profile,
        paths.learnings,
        paths.worldBank,
        paths.opinionsBank,
        ...fileNames.map((fileName) => path.join(paths.dailyLogsRoot, fileName)),
      ];

  const stats = await Promise.all(files.map((filePath) => safeStat(filePath)));
  const raw = [`mode:${mode}`, ...stats.map((item, index) => `${index}:${item}`)].join("|");
  return createHash("sha1").update(raw).digest("hex");
}

export async function appendMemoryTurn(paths: AgentPaths, record: MemoryTurnRecord): Promise<void> {
  await appendFile(paths.inboxLog, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  await appendFile(
    path.join(paths.workspaceLogsRoot, `${record.workspaceId}.jsonl`),
    `${JSON.stringify(record)}\n`,
    { mode: 0o600 },
  );
  await appendDailyHandover(paths, record);
  await appendBankLearnings(paths, record);
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

export async function appendHeartbeatReport(paths: AgentPaths, report: HeartbeatReport): Promise<void> {
  const filePath = path.join(paths.dailyLogsRoot, `${report.timestamp.slice(0, 10)}.md`);
  const entry = [
    `## ${report.timestamp} HEARTBEAT`,
    `- Summary: ${report.summary}`,
    ...report.checks.map((check) => `- ${check}`),
    "",
  ].join("\n");
  await appendFile(filePath, entry, { mode: 0o600 });
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

async function safeStat(filePath: string): Promise<string> {
  try {
    const fileStat = await stat(filePath);
    return `${fileStat.size}:${fileStat.mtimeMs}`;
  } catch {
    return "missing";
  }
}

async function readRecentInbox(filePath: string, limit = 3): Promise<string> {
  const raw = await safeRead(filePath);
  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-limit);

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

async function readRecentDailyLogs(dailyLogsRoot: string, days = 2): Promise<string> {
  const today = new Date();
  const fileNames = Array.from({ length: Math.max(1, days) }, (_, offset) => offset)
    .map((offset) => {
      const date = new Date(today);
      date.setDate(today.getDate() - offset);
      return `${date.toISOString().slice(0, 10)}.md`;
    });

  const chunks = await Promise.all(
    fileNames.map(async (fileName) => {
      const content = await safeRead(path.join(dailyLogsRoot, fileName));
      return compactSection(content, 500);
    }),
  );

  return chunks.filter((chunk) => chunk && chunk !== "(empty)").join("\n\n");
}

function selectPromptMode(userText: string): PromptMode {
  const normalized = userText.trim().toLowerCase();
  const fullModePattern = /(继续上次|继续刚才|基于之前|结合之前|参考之前|根据之前|上次说到|延续|复盘|总结|整理一下|回顾|长期|跨项目|memory|记忆|记住|历史|上下文|之前的对话)/;
  return fullModePattern.test(normalized) ? "full" : "fast";
}

async function appendDailyHandover(paths: AgentPaths, record: MemoryTurnRecord): Promise<void> {
  const filePath = path.join(paths.dailyLogsRoot, `${record.timestamp.slice(0, 10)}.md`);
  const loops = record.openLoops.length > 0 ? `\n- Pending: ${record.openLoops.join(" / ")}` : "";
  const entry = [
    `## ${record.timestamp}`,
    `- Workspace: ${record.workspaceName}`,
    `- User: ${record.userText}`,
    `- Result: ${record.assistantSummary}`,
    loops,
    "",
  ].join("\n");
  await appendFile(filePath, entry, { mode: 0o600 });
}

async function appendBankLearnings(paths: AgentPaths, record: MemoryTurnRecord): Promise<void> {
  const experienceCandidates = extractExperienceCandidates(record);
  const opinionCandidates = extractOpinionCandidates(record);

  if (experienceCandidates.length > 0) {
    await appendUniqueBankItems(paths.experienceBank, experienceCandidates);
    await compactBankFile(paths.experienceBank, MAX_EXPERIENCE_BANK_ITEMS, scoreExperienceItem);
  }

  if (opinionCandidates.length > 0) {
    await appendUniqueBankItems(paths.opinionsBank, opinionCandidates);
    await compactBankFile(paths.opinionsBank, MAX_OPINION_BANK_ITEMS, scoreOpinionItem);
  }
}

async function appendUniqueBankItems(filePath: string, items: string[]): Promise<void> {
  const existing = await safeRead(filePath);
  const existingNormalized = new Set(
    existing
      .split("\n")
      .map((line) => normalizeBankLine(line))
      .filter(Boolean),
  );

  const additions = items
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item) => !existingNormalized.has(normalizeBankLine(item)));

  if (additions.length === 0) {
    return;
  }

  const payload = `${additions.map((item) => `- ${item}`).join("\n")}\n`;
  await appendFile(filePath, payload, { mode: 0o600 });
}

async function compactBankFile(
  filePath: string,
  maxItems: number,
  scoreItem: (item: string) => number,
): Promise<void> {
  const raw = await safeRead(filePath);
  if (!raw.trim()) {
    return;
  }

  const lines = raw.split("\n");
  const headerLines: string[] = [];
  const seen = new Set<string>();
  const items: string[] = [];

  for (const line of lines) {
    if (/^\s*-\s+/.test(line)) {
      const item = line.replace(/^\s*-\s+/, "").trim();
      const normalized = normalizeBankLine(item);
      if (!normalized || seen.has(normalized)) {
        continue;
      }
      seen.add(normalized);
      items.push(item);
      continue;
    }

    if (items.length === 0) {
      headerLines.push(line);
    }
  }

  const rankedItems = items
    .map((item, index) => ({ item, index, score: scoreItem(item) }))
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return left.index - right.index;
    })
    .slice(0, maxItems)
    .sort((left, right) => left.index - right.index)
    .map((entry) => `- ${entry.item}`);

  const nextContent = [
    ...trimTrailingBlankLines(headerLines),
    ...rankedItems,
    "",
  ].join("\n");

  await writeFile(filePath, nextContent, { mode: 0o600 });
}

function extractExperienceCandidates(record: MemoryTurnRecord): string[] {
  const text = normalizeForLearning(`${record.userText}\n${record.assistantSummary}\n${record.openLoops.join("\n")}`);
  const candidates = new Set<string>();

  if (/cloudflare|quick tunnel|tls handshake|trycloudflare/.test(text)) {
    candidates.add("Cloudflare Quick Tunnel can fail on this network; alternative public tunnels may be needed.");
  }

  if (/ngrok/.test(text)) {
    candidates.add("ngrok is a practical fallback when other public tunnel options are unstable.");
  }

  if (/database is locked|锁.*数据库|state db|锁冲突/.test(text)) {
    candidates.add("Aggressive native session syncing can lock Codex state storage; keep sync frequency low.");
  }

  if (/device is locked|设备.*锁|developer disk image|ddi/.test(text)) {
    candidates.add("Real-device install and launch operations fail if the iPhone is locked.");
  }

  if (/无回复|没回复|半失活|heartbeat|ack timeout|前台自动重连|假连接/.test(text)) {
    candidates.add("Mobile remote sessions need heartbeat, send acknowledgement, and foreground reconnect to avoid half-dead sockets.");
  }

  if (/线程.*退休|新对话|旧线程|卡住|已重置到新线程/.test(text)) {
    candidates.add("Long-lived stale threads can poison later turns; resetting or retiring threads is an effective recovery path.");
  }

  if (/图片.*链接|bridge-image|本地图片|图片代理/.test(text)) {
    candidates.add("Local image paths from the Mac must be proxied through the relay before the iPhone can render them inline.");
  }

  if (/build succeeded|真机构建|安装到你的 iphone|已安装/.test(text)) {
    candidates.add("Real-device verification is the most reliable way to validate this app's Codex remote workflow.");
  }

  return Array.from(candidates).slice(0, 3);
}

function extractOpinionCandidates(record: MemoryTurnRecord): string[] {
  const text = normalizeForLearning(`${record.userText}\n${record.assistantSummary}`);
  const candidates = new Set<string>();

  if (/不需要simulator|不用simulator|真机优先|iphone优先/.test(text)) {
    candidates.add("Prefer real iPhone testing over Simulator whenever possible.");
  }

  if (/先.*做|直接.*做|继续|别计划|实现 first|implementation first/.test(text)) {
    candidates.add("Favor implementation-first iteration over long upfront planning.");
  }

  if (/精简|简短|别太长|不要长链接|长 url|不要包含长链接/.test(text)) {
    candidates.add("Prefer concise replies and avoid long raw URLs in the mobile chat UI.");
  }

  if (/占地方太大|优化下|字体再大一点|更常用的界面|不要弹层|主界面/.test(text)) {
    candidates.add("The mobile UI should stay compact, readable, and optimized for frequent Codex Chat use.");
  }

  if (/自动连接|自动重连|不要让我来连接/.test(text)) {
    candidates.add("Reduce repeated connection steps; automatic connection and recovery are preferred.");
  }

  return Array.from(candidates).slice(0, 3);
}

function normalizeForLearning(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeBankLine(text: string): string {
  return text
    .replace(/^-+\s*/, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function scoreExperienceItem(item: string): number {
  const text = normalizeBankLine(item);
  let score = 1;

  if (/heartbeat|foreground reconnect|half-dead|acknowledgement/.test(text)) {
    score += 4;
  }
  if (/thread|retiring threads|resetting/.test(text)) {
    score += 4;
  }
  if (/database|lock|state storage/.test(text)) {
    score += 3;
  }
  if (/real-device|iphone is locked|install|launch/.test(text)) {
    score += 2;
  }
  if (/ngrok|cloudflare|tunnel/.test(text)) {
    score += 2;
  }

  return score;
}

function scoreOpinionItem(item: string): number {
  const text = normalizeBankLine(item);
  let score = 1;

  if (/real iphone|simulator/.test(text)) {
    score += 4;
  }
  if (/implementation-first|long upfront planning/.test(text)) {
    score += 3;
  }
  if (/compact|mobile ui|frequent codex chat use/.test(text)) {
    score += 3;
  }
  if (/automatic connection|automatic recovery/.test(text)) {
    score += 3;
  }
  if (/concise replies|raw urls/.test(text)) {
    score += 2;
  }

  return score;
}

function trimTrailingBlankLines(lines: string[]): string[] {
  const trimmed = [...lines];
  while (trimmed.length > 0 && trimmed[trimmed.length - 1]?.trim() === "") {
    trimmed.pop();
  }
  return trimmed;
}

function nonEmptyMarkdown(text: string): string {
  const content = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !/^#+\s*$/.test(line) && !/^<!--.*-->$/.test(line))
    .join("\n");
  return content;
}

function compactSection(text: string, maxLength: number): string {
  const compact = text.replace(/\s+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!compact) {
    return "(empty)";
  }

  if (compact.length <= maxLength) {
    return compact;
  }

  return `${compact.slice(0, maxLength).trim()}\n[truncated for mobile speed]`;
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
