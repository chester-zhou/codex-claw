# ChesterNotes Remote Codex Plan

## Goal

Allow `ChesterNotes` on a single iPhone to talk to the Codex instance running on this Mac over the internet, with:

- strong device binding
- multi-workspace switching
- streamed assistant output
- streamed command execution output
- approval prompts for commands and file changes
- tool-driven `request_user_input`

## Architecture

The system is split into three processes:

1. `iPhone App`
   - owns the paired device key
   - connects to a Relay over WebSocket
   - renders workspaces, chat, logs, and approvals

2. `Relay`
   - internet-facing WebSocket router
   - routes messages between a Bridge and an App session
   - does not talk to Codex directly

3. `Mac Bridge`
   - runs on the Mac that owns the workspaces
   - connects outbound to the Relay
   - starts and manages `codex app-server`
   - translates between the mobile protocol and the Codex app-server protocol
   - enforces paired-device authentication

`codex app-server` stays local-only on `127.0.0.1`.

## Security Model

### Device ownership

- The iPhone App generates a long-lived signing key pair in Secure Enclave when available.
- On Simulator, the App falls back to a software-backed key stored in the iOS Keychain with `ThisDeviceOnly` protection.
- The private key is never exported through app code.
- The Bridge stores only the paired device's public key.
- The Bridge supports a single paired device by default.

### Pairing

- The Bridge accepts only short-lived pairing sessions from `data/pairing-sessions.json`.
- Pairing sessions are created out-of-band with `npm run pair -- /path/to/bridge.config.json`.
- Each pairing code is single-use and expires after a short TTL.
- During pairing the App sends:
  - `deviceId`
  - `deviceName`
  - `publicKeyPem`
  - `pairingCode`
- If the code matches an active session, the Bridge stores the device public key, consumes the pairing session, and rejects future unknown devices.

### Session authentication

- Each App connection starts with `client.hello`.
- If the device is known, the Bridge sends a nonce challenge.
- The App signs the nonce with the device private key.
- The Bridge verifies the signature before allowing access to workspaces or Codex events.

### Relay trust boundary

- The Relay only routes traffic.
- The Relay is not treated as the authority for device identity.
- Only the Bridge decides whether a mobile session is authenticated.
- The Bridge token is read from `RELAY_BRIDGE_TOKEN`, not from JSON config.
- Internet exposure should use `wss://`.
- The iPhone App can either rely on the system TLS trust store or pin a SHA256 certificate fingerprint when you control the certificate.
- For simple public internet access, put the Relay behind Cloudflare Tunnel and keep the Bridge local to the Mac.

## Workspace Model

Each workspace is configured on the Bridge with:

- `id`
- `name`
- `cwd`
- `sandbox`
- `approvalPolicy`
- optional `model`

The App switches workspaces by `workspaceId`. The Bridge then uses the mapped `cwd` when it opens or resumes a Codex thread.

## Phase 1 Scope

This repository starts with:

- Relay skeleton
- Bridge skeleton
- Codex app-server adapter
- iOS Codex chat UI
- single-thread-per-device-per-workspace session handling
- command approval flow for mobile
- file-change approval flow with turn diff preview
- tool `request_user_input` flow with structured mobile answers

Planned next:

- thread history per workspace
- Face ID gating for approvals
- QR-based pairing
- stable public hostname automation for Cloudflare Named Tunnel
