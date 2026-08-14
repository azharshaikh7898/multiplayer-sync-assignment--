import { WebSocketServer, WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import { parseClientMessage } from "./protocol.js";
import { RoomManager } from "./roomManager.js";

const PORT = Number(process.env.PORT) || 8080;
const HEARTBEAT_INTERVAL_MS = 15000;

const roomManager = new RoomManager();
const wss = new WebSocketServer({ port: PORT });

// Track which room each connection belongs to, since a socket
// isn't in any room until it sends an explicit "join" message.
const socketRoomId = new Map<WebSocket, string>();
const socketClientId = new Map<WebSocket, string>();

wss.on("connection", (ws: WebSocket) => {
  ws.on("message", (data) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data.toString());
    } catch {
      return; // malformed JSON → dropped silently
    }

    const msg = parseClientMessage(parsed);
    if (!msg) return; // unknown/invalid type → dropped, not crashed

    if (msg.type === "join") {
      const room = roomManager.getOrCreate(msg.roomId);
      room.join(msg.clientId, ws);
      socketRoomId.set(ws, msg.roomId);
      socketClientId.set(ws, msg.clientId);
      return;
    }

    // Any other message type requires the socket to have joined a room first.
    const roomId = socketRoomId.get(ws);
    if (!roomId) return; // ignore actions from clients that never joined

    const room = roomManager.getOrCreate(roomId);

    if (msg.type === "leave") {
      room.leave(msg.clientId);
      roomManager.removeIfEmpty(roomId);
      socketRoomId.delete(ws);
      socketClientId.delete(ws);
      return;
    }

    room.handleAction(msg.clientId, msg);
  });

  ws.on("pong", () => {
    const clientId = socketClientId.get(ws);
    const roomId = socketRoomId.get(ws);
    if (clientId && roomId) {
      roomManager.getOrCreate(roomId).markAlive(clientId);
    }
  });

  ws.on("close", () => {
    const clientId = socketClientId.get(ws);
    const roomId = socketRoomId.get(ws);
    if (clientId && roomId) {
      roomManager.getOrCreate(roomId).leave(clientId);
      roomManager.removeIfEmpty(roomId);
    }
    socketRoomId.delete(ws);
    socketClientId.delete(ws);
  });

  ws.on("error", () => {
    const clientId = socketClientId.get(ws);
    const roomId = socketRoomId.get(ws);
    if (clientId && roomId) {
      roomManager.getOrCreate(roomId).leave(clientId);
      roomManager.removeIfEmpty(roomId);
    }
  });
});

// Heartbeat sweep runs per-room via a single interval over all rooms.
setInterval(() => {
  const uniqueRoomIds = new Set(socketRoomId.values());
  for (const roomId of uniqueRoomIds) {
    roomManager.getOrCreate(roomId).sweepDeadClients();
  }
}, HEARTBEAT_INTERVAL_MS);

console.log(`WebSocket server listening on ws://localhost:${PORT}`);