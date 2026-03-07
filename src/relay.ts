import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import WebSocket, { WebSocketServer } from "ws";

import {
  type AppClientMessage,
  type RelayAppHelloMessage,
  type RelayBridgeIncomingMessage,
  type RelayBridgeOutgoingMessage,
  type RelayBridgeRegisterMessage,
  safeJsonParse,
} from "./shared/protocol.js";

type BridgeConnection = {
  bridgeId: string;
  bridgeName: string;
  socket: WebSocket;
};

type AppConnection = {
  connectionId: string;
  bridgeId: string;
  socket: WebSocket;
};

const port = Number(process.env.PORT ?? "8787");
const host = process.env.HOST ?? "0.0.0.0";
const tlsCertPath = process.env.RELAY_TLS_CERT_PATH;
const tlsKeyPath = process.env.RELAY_TLS_KEY_PATH;

const bridgeSockets = new Map<string, BridgeConnection>();
const appSockets = new Map<string, AppConnection>();

const server = tlsCertPath && tlsKeyPath
  ? createHttpsServer({
      cert: readFileSync(tlsCertPath),
      key: readFileSync(tlsKeyPath),
    })
  : createHttpServer();
const wss = new WebSocketServer({ server });

wss.on("connection", (socket) => {
  let initialized = false;

  const timer = setTimeout(() => {
    if (!initialized) {
      socket.close(1008, "Expected hello message");
    }
  }, 10_000);

  socket.once("message", (message) => {
    clearTimeout(timer);

    const raw = message.toString("utf8");
    const bridgeRegister = safeJsonParse<RelayBridgeRegisterMessage>(raw);
    if (bridgeRegister?.type === "bridge.register") {
      initialized = true;
      handleBridgeRegister(socket, bridgeRegister);
      return;
    }

    const appHello = safeJsonParse<RelayAppHelloMessage>(raw);
    if (appHello?.type === "app.connect") {
      initialized = true;
      handleAppConnect(socket, appHello);
      return;
    }

    socket.close(1008, "Unsupported hello message");
  });
});

function handleBridgeRegister(socket: WebSocket, message: RelayBridgeRegisterMessage): void {
  const expectedToken = process.env.RELAY_BRIDGE_TOKEN ?? "dev-bridge-token";
  if (message.bridgeToken !== expectedToken) {
    socket.close(1008, "Invalid bridge token");
    return;
  }

  bridgeSockets.set(message.bridgeId, {
    bridgeId: message.bridgeId,
    bridgeName: message.bridgeName,
    socket,
  });

  socket.on("message", (raw) => {
    const message = safeJsonParse<RelayBridgeOutgoingMessage>(raw.toString("utf8"));
    if (!message) {
      return;
    }

    switch (message.type) {
    case "bridge.push": {
      const app = appSockets.get(message.connectionId);
      app?.socket.send(JSON.stringify(message.payload));
      break;
    }
    case "bridge.disconnect": {
      const app = appSockets.get(message.connectionId);
      if (app) {
        app.socket.close(1000, message.reason ?? "Bridge closed session");
        appSockets.delete(message.connectionId);
      }
      break;
    }
    }
  });

  socket.on("close", () => {
    bridgeSockets.delete(message.bridgeId);
  });
}

function handleAppConnect(socket: WebSocket, message: RelayAppHelloMessage): void {
  const bridge = bridgeSockets.get(message.bridgeId);
  if (!bridge) {
    socket.send(JSON.stringify({ type: "error", message: "Bridge is offline" }));
    socket.close(1008, "Bridge unavailable");
    return;
  }

  const connectionId = randomUUID();
  appSockets.set(connectionId, {
    connectionId,
    bridgeId: message.bridgeId,
    socket,
  });

  socket.send(JSON.stringify({ type: "relay.connected", connectionId }));

  bridge.socket.send(
    JSON.stringify({
      type: "relay.app.connected",
      connectionId,
    } satisfies RelayBridgeIncomingMessage),
  );

  socket.on("message", (raw) => {
    const payload = safeJsonParse<AppClientMessage>(raw.toString("utf8"));
    if (!payload) {
      return;
    }

    bridge.socket.send(
      JSON.stringify({
        type: "relay.app.message",
        connectionId,
        payload,
      } satisfies RelayBridgeIncomingMessage),
    );
  });

  socket.on("close", () => {
    appSockets.delete(connectionId);
    bridge.socket.send(
      JSON.stringify({
        type: "relay.app.disconnected",
        connectionId,
      } satisfies RelayBridgeIncomingMessage),
    );
  });
}

server.listen(port, host, () => {
  const scheme = tlsCertPath && tlsKeyPath ? "wss" : "ws";
  console.log(`Codex relay listening on ${scheme}://${host}:${port}`);
});
