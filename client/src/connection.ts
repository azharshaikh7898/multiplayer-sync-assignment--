import type { ClientMessage, ServerMessage } from "./protocol.js";

type MessageHandler = (msg: ServerMessage) => void;
export type ConnectionStatus = "connecting" | "connected" | "disconnected";
type StatusHandler = (status: ConnectionStatus) => void;

export interface RoomConnection {
  send: (msg: ClientMessage) => void;
  onMessage: (handler: MessageHandler) => void;
  onStatusChange: (handler: StatusHandler) => void;
  close: () => void;
  getRTT: () => number | null;
}

interface CreateRoomOptions {
  url: string;
  clientId: string;
  roomId: string;
}

const PING_INTERVAL_MS = 3000;

export function createRoom(opts: CreateRoomOptions): RoomConnection {
  let ws: WebSocket | null = null;
  let handlers: MessageHandler[] = [];
  let statusHandlers: StatusHandler[] = [];
  let status: ConnectionStatus = "connecting";
  let reconnectAttempt = 0;
  let closedByUser = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let pingInterval: ReturnType<typeof setInterval> | null = null;
  let lastRTT: number | null = null;
  let rttSamples: number[] = [];
  const MAX_SAMPLES = 5;

  function setStatus(next: ConnectionStatus): void {
    if (status === next) return;
    status = next;
    for (const h of statusHandlers) h(next);
  }

  function computeJitter(samples: number[]): number {
    if (samples.length < 2) return 0;
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    const avgDeviation =
      samples.reduce((sum, v) => sum + Math.abs(v - mean), 0) / samples.length;
    return avgDeviation;
  }

  function connect(): void {
    // Guard: never open a second live socket while one is already
    // connecting/open — this is what breaks under React StrictMode's
    // double-invoked effect in dev mode.
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    ws = new WebSocket(opts.url);

    ws.addEventListener("open", () => {
      reconnectAttempt = 0;
      setStatus("connected");
      send({ type: "join", clientId: opts.clientId, roomId: opts.roomId });

      // Start periodic RTT probing. Re-armed on every (re)connect.
      if (pingInterval) clearInterval(pingInterval);
      pingInterval = setInterval(() => {
        send({ type: "ping", clientId: opts.clientId, sentAt: performance.now() });
      }, PING_INTERVAL_MS);
    });

    ws.addEventListener("message", (event) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.data as string);
      } catch {
        return;
      }
      if (!isServerMessage(parsed)) return;

      if (parsed.type === "pong") {
        const rtt = performance.now() - (parsed as { sentAt: number }).sentAt;
        lastRTT = rtt;

        rttSamples.push(rtt);
        if (rttSamples.length > MAX_SAMPLES) rttSamples.shift();
        const jitter = computeJitter(rttSamples);

        const latencyMsg: ServerMessage = {
          type: "latency",
          clientId: opts.clientId,
          rtt: Math.round(rtt),
          jitter: Math.round(jitter),
        };

        // Tell the server so OTHER clients learn our latency...
        send({ type: "latency", clientId: opts.clientId, rtt: latencyMsg.rtt, jitter: latencyMsg.jitter });
        // ...and update our own UI immediately, without waiting on a
        // round-trip broadcast (the server never echoes back to sender).
        for (const h of handlers) h(latencyMsg);

        return; // transport-internal, not forwarded to app-level handlers
      }

      for (const h of handlers) h(parsed);
    });

    ws.addEventListener("close", () => {
      if (pingInterval) clearInterval(pingInterval);
      if (closedByUser) return;
      setStatus("disconnected");
      const delay = Math.min(1000 * 2 ** reconnectAttempt, 10000);
      reconnectAttempt++;
      reconnectTimer = setTimeout(() => {
        setStatus("connecting");
        connect();
      }, delay);
    });

    ws.addEventListener("error", () => {
      ws?.close();
    });
  }

  function send(msg: ClientMessage): void {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  connect();

  return {
    send,
    onMessage: (handler) => handlers.push(handler),
    onStatusChange: (handler) => {
      statusHandlers.push(handler);
      handler(status); // immediately report current status to new subscribers
    },
    close: () => {
      closedByUser = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (pingInterval) clearInterval(pingInterval);
      ws?.close();
    },
    getRTT: () => lastRTT,
  };
}

function isServerMessage(v: unknown): v is ServerMessage {
  return typeof v === "object" && v !== null && typeof (v as any).type === "string";
}