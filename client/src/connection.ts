import type { ClientMessage, ServerMessage } from "./protocol.js";

type MessageHandler = (msg: ServerMessage) => void;

export interface RoomConnection {
  send: (msg: ClientMessage) => void;
  onMessage: (handler: MessageHandler) => void;
  close: () => void;
}

interface CreateRoomOptions {
  url: string;
  clientId: string;
  roomId: string;
}

export function createRoom(opts: CreateRoomOptions): RoomConnection {
  let ws: WebSocket | null = null;
  let handlers: MessageHandler[] = [];
  let reconnectAttempt = 0;
  let closedByUser = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

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
      send({ type: "join", clientId: opts.clientId, roomId: opts.roomId });
    });

    ws.addEventListener("message", (event) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.data as string);
      } catch {
        return;
      }
      if (!isServerMessage(parsed)) return;
      for (const h of handlers) h(parsed);
    });

    ws.addEventListener("close", () => {
      if (closedByUser) return;
      const delay = Math.min(1000 * 2 ** reconnectAttempt, 10000);
      reconnectAttempt++;
      reconnectTimer = setTimeout(connect, delay);
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
    close: () => {
      closedByUser = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      ws?.close();
    },
  };
}

function isServerMessage(v: unknown): v is ServerMessage {
  return typeof v === "object" && v !== null && typeof (v as any).type === "string";
}