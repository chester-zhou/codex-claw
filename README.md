# Codex-Claw

Codex-Claw is an openclaw-style remote client layer for Codex.

It exposes a local Codex `app-server` to an iPhone client through a Relay + Bridge architecture, while adding durable agent context features such as `SOUL`, `USER`, and long-term `memory`.

## What It Does

- runs a local WebSocket relay
- starts and manages `codex app-server`
- bridges mobile requests to Codex
- supports pairing and trusted-device persistence
- can expose the relay through Cloudflare Quick Tunnel
- injects file-based agent memory before each turn

## Openclaw Features For Codex

- `SOUL.md`: durable assistant identity, style, and behavior rules
- `USER.md`: stable user preferences and collaboration habits
- `memory/global.md`: cross-workspace long-term memory
- `memory/profile.md`: durable profile and preference memory
- `memory/workspaces/<id>.md`: per-workspace project memory
- `memory/inbox.jsonl`: durable turn-by-turn summaries
- `memory/workspace-logs/<id>.jsonl`: workspace-specific interaction logs
- native Codex thread import into durable memory

This makes Codex-Claw closer to an openclaw-style persistent agent layer than a plain websocket proxy.

## Project Layout

- `src/relay.ts`: relay server
- `src/bridge.ts`: bridge between relay and local Codex app-server
- `src/createPairingSession.ts`: one-time pairing code generator
- `src/agentMemory.ts`: file-based soul, user, and memory scaffolding
- `src/nativeCodexMemorySync.ts`: imports recent Codex native threads into durable memory
- `bridge.config.example.json`: example bridge configuration

## Requirements

- Node.js 18+
- `codex` CLI available in `PATH`
- optional: `cloudflared` for internet exposure

## Setup

```bash
cd Codex-Claw
npm install
cp bridge.config.example.json bridge.config.json
```

Edit `bridge.config.json` and set:

- `bridgeId`
- `bridgeName`
- `relayUrl`
- `codexListenUrl`
- `workspaces[].cwd`

The first bridge run will scaffold local context files under `agent/`.

## Run

Start the relay:

```bash
npm run relay
```

Start the bridge in another terminal:

```bash
RELAY_BRIDGE_TOKEN=your-secret npm run bridge -- /absolute/path/to/bridge.config.json
```

Create a one-time pairing code:

```bash
npm run pair -- /absolute/path/to/bridge.config.json
```

Optional Cloudflare Quick Tunnel:

```bash
npm run tunnel:quick
```

The included `.gitignore` keeps local device data, pairing records, agent memory, and private config out of Git.
