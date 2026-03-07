import path from "node:path";
import process from "node:process";

import { loadPairingSessions, savePairingSessions } from "./shared/config.js";
import { createPairingCode } from "./shared/crypto.js";

const configPath = process.argv[2] ?? path.resolve(process.cwd(), "bridge.config.json");
const configDirectory = path.dirname(configPath);
const pairingSessionsPath = path.resolve(configDirectory, "data/pairing-sessions.json");
const ttlMinutes = Number(process.env.PAIRING_TTL_MINUTES ?? "10");

const now = Date.now();
const expiresAt = new Date(now + ttlMinutes * 60_000).toISOString();
const code = createPairingCode();

const existing = await loadPairingSessions(pairingSessionsPath);
const active = existing.filter((session) => new Date(session.expiresAt).getTime() > now);

active.push({
  code,
  createdAt: new Date(now).toISOString(),
  expiresAt,
});

await savePairingSessions(pairingSessionsPath, active);

console.log(`Pairing code: ${code}`);
console.log(`Expires at: ${expiresAt}`);
