import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import WebSocket from "ws";

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
};

type JsonRpcResponse = {
  jsonrpc?: "2.0";
  id?: number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
  };
  method?: string;
  params?: unknown;
};

type PendingRequest = {
    resolve: (value: unknown) => void;
    reject: (reason?: unknown) => void;
};

export type CodexNotification = {
  method: string;
  params: unknown;
};

export type CodexServerRequest = {
  id: number;
  method: string;
  params: unknown;
};

export class CodexAppServerClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private process: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private reconnectPromise: Promise<void> | null = null;
  private explicitlyStopping = false;

  constructor(private readonly listenUrl: string) {
    super();
  }

  async start(): Promise<void> {
    if (this.process) {
      await this.ensureConnected();
      return;
    }

    this.explicitlyStopping = false;
    this.process = spawn(
      "codex",
      [
        "app-server",
        "-c",
        "model_reasoning_effort=low",
        "--listen",
        this.listenUrl,
      ],
      {
        stdio: "pipe",
      },
    );

    this.process.stderr.on("data", (chunk) => {
      this.emit("stderr", chunk.toString("utf8"));
    });

    this.process.on("exit", (code) => {
      this.emit("stderr", `codex app-server exited with code ${code ?? -1}`);
      this.process = null;
      this.ws = null;
      this.rejectPendingRequests(new Error("codex app-server exited"));
      if (!this.explicitlyStopping) {
        void this.recover();
      }
    });

    await this.connectWithRetry();
    await this.initialize();
  }

  async stop(): Promise<void> {
    this.explicitlyStopping = true;
    this.ws?.close();
    this.ws = null;
    this.rejectPendingRequests(new Error("codex app-server stopped"));
    this.process?.kill("SIGTERM");
    this.process = null;
  }

  async request<T>(method: string, params?: unknown): Promise<T> {
    await this.ensureConnected();
    const id = this.nextId++;
    const payload: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };

    const ws = this.requireSocket();
    ws.send(JSON.stringify(payload));

    return await new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
    });
  }

  respond(id: number, result: unknown): void {
    void this.ensureConnected().then(() => this.requireSocket().send(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        result,
      }),
    ));
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private async initialize(): Promise<void> {
    await this.request("initialize", {
      clientInfo: {
        name: "codex-claw-bridge",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
      },
    });

    this.requireSocket().send(
      JSON.stringify({
        method: "initialized",
      }),
    );
  }

  private async connectWithRetry(): Promise<void> {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        await this.connect();
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }

    throw new Error(`Unable to connect to codex app-server at ${this.listenUrl}`);
  }

  private async connect(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.listenUrl);

      const cleanup = () => {
        ws.removeAllListeners();
      };

      ws.once("open", () => {
        this.ws = ws;
        ws.on("message", (data) => this.handleMessage(data.toString("utf8")));
        ws.on("close", () => {
          this.ws = null;
          this.emit("stderr", "codex app-server websocket closed");
          this.rejectPendingRequests(new Error("codex app-server websocket closed"));
          if (!this.explicitlyStopping) {
            void this.recover();
          }
        });
        resolve();
      });

      ws.once("error", (error) => {
        cleanup();
        reject(error);
      });
    });
  }

  private handleMessage(raw: string): void {
    const message = JSON.parse(raw) as JsonRpcResponse;

    if (typeof message.id === "number" && message.method) {
      this.emit("request", {
        id: message.id,
        method: message.method,
        params: message.params,
      } satisfies CodexServerRequest);
      return;
    }

    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }

      this.pending.delete(message.id);

      if (message.error) {
        pending.reject(new Error(message.error.message));
        return;
      }

      pending.resolve(message.result);
      return;
    }

    if (message.method) {
      this.emit("notification", {
        method: message.method,
        params: message.params,
      } satisfies CodexNotification);
    }
  }

  private requireSocket(): WebSocket {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Codex app-server websocket is not connected");
    }
    return this.ws;
  }

  private async ensureConnected(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) {
      return;
    }

    if (!this.process) {
      await this.start();
      return;
    }

    await this.recover();
  }

  private async recover(): Promise<void> {
    if (this.reconnectPromise) {
      return await this.reconnectPromise;
    }

    this.reconnectPromise = (async () => {
      try {
        if (!this.process) {
          await this.start();
          return;
        }

        await this.connectWithRetry();
        await this.initialize();
      } finally {
        this.reconnectPromise = null;
      }
    })();

    return await this.reconnectPromise;
  }

  private rejectPendingRequests(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}
