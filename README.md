# Codex-Claw

A small Relay + Bridge service for exposing a local Codex `app-server` to a remote iPhone client.

## What It Does

- runs a local WebSocket relay
- starts and manages `codex app-server`
- bridges mobile requests to Codex
- supports pairing and trusted-device persistence
- can expose the relay through Cloudflare Quick Tunnel
- injects file-based agent memory before each turn

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

## Publish To GitHub

If you want to publish only this subproject, initialize Git inside `Codex-Claw` instead of the repository root:

```bash
cd Codex-Claw
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin git@github.com:YOUR_NAME/openclaw.git
git push -u origin main
```

The included `.gitignore` keeps local device data, pairing records, agent memory, and private config out of Git.
