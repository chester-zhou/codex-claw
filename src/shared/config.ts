import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { WorkspaceDescriptor } from "./protocol.js";

export type BridgeConfig = {
  bridgeId: string;
  bridgeName: string;
  relayUrl: string;
  relayCaPath?: string | null;
  codexListenUrl: string;
  heartbeatIntervalMinutes?: number;
  workspaces: WorkspaceDescriptor[];
};

export type PairedDeviceRecord = {
  deviceId: string;
  deviceName: string;
  publicKeyPem: string;
  pairedAt: string;
};

export type PairingSessionRecord = {
  code: string;
  createdAt: string;
  expiresAt: string;
};

export async function loadBridgeConfig(configPath: string): Promise<BridgeConfig> {
  const raw = await readFile(configPath, "utf8");
  return JSON.parse(raw) as BridgeConfig;
}

export async function loadDeviceRegistry(filePath: string): Promise<PairedDeviceRecord[]> {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw) as PairedDeviceRecord[];
  } catch {
    return [];
  }
}

export async function saveDeviceRegistry(filePath: string, devices: PairedDeviceRecord[]): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(devices, null, 2), { mode: 0o600 });
}

export async function loadPairingSessions(filePath: string): Promise<PairingSessionRecord[]> {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw) as PairingSessionRecord[];
  } catch {
    return [];
  }
}

export async function savePairingSessions(filePath: string, sessions: PairingSessionRecord[]): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(sessions, null, 2), { mode: 0o600 });
}
