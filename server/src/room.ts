import type { WebSocket } from "ws";
import type { ClientMessage, ServerMessage, Presence } from "./protocol.js";

interface ClientState {
  ws: WebSocket;
  clientId: string;
  lastSeq: number;
  lastX: number;
  lastY: number;
  isAlive: boolean;
}

interface RecentReaction {
  x: number;
  y: number;
  serverTime: number;
  conflictId: string;
}

const CONFLICT_RADIUS_PX = 50;
const CONFLICT_WINDOW_MS = 300;
const RECENT_BUFFER_MAX = 20; // small, bounded — avoid unbounded growth

export class Room {
  private clients = new Map<string, ClientState>();
  private recentReactions: RecentReaction[] = []; // NEW

  join(clientId: string, ws: WebSocket): void {
    // Prevent duplicate cursors on reconnect: replace stale entry if present.
    const existing = this.clients.get(clientId);
    if (existing) {
      existing.ws.removeAllListeners();
      existing.ws.terminate();
    }

    this.clients.set(clientId, {
      ws,
      clientId,
      lastSeq: -1,
      lastX: 0,
      lastY: 0,
      isAlive: true,
    });

    // Send snapshot of current participants to the new joiner.
    const participants: Presence[] = [...this.clients.values()]
      .filter((c) => c.clientId !== clientId)
      .map((c) => ({ clientId: c.clientId, x: c.lastX, y: c.lastY }));

    this.send(clientId, { type: "welcome", clientId, participants });

    // Tell everyone else this client joined.
    this.broadcast(clientId, { type: "presence", clientId, status: "join" });
  }

  leave(clientId: string): void {
    if (!this.clients.has(clientId)) return;
    this.clients.delete(clientId);
    this.broadcast(clientId, { type: "presence", clientId, status: "leave" });
  }

  markAlive(clientId: string): void {
    const c = this.clients.get(clientId);
    if (c) c.isAlive = true;
  }

  // Called by heartbeat loop each tick, before pinging again.
  sweepDeadClients(): void {
    for (const [clientId, c] of this.clients) {
      if (!c.isAlive) {
        c.ws.terminate();
        this.leave(clientId);
      } else {
        c.isAlive = false;
        c.ws.ping();
      }
    }
  }

  handleAction(clientId: string, action: ClientMessage): void {
    const c = this.clients.get(clientId);
    if (!c) return;

    if (action.type === "latency") {
      // Pure info relay — no seq/ordering needed, no stored state to update.
      this.broadcast(clientId, action);
      return;
    }

    // Only cursor/reaction carry seq and get relayed — join/leave are handled elsewhere.
    if (action.type !== "cursor" && action.type !== "reaction") return;

    // Ordering: discard stale/out-of-order updates.
    if (action.seq <= c.lastSeq) return;
    c.lastSeq = action.seq;

    if (action.type === "cursor") {
      c.lastX = action.x;
      c.lastY = action.y;
      this.broadcast(clientId, action);
      return;
    }

    // action.type === "reaction" — check for conflicts before broadcasting.
    const now = Date.now();

    // Prune old entries outside the conflict window.
    this.recentReactions = this.recentReactions.filter(
      (r) => now - r.serverTime <= CONFLICT_WINDOW_MS
    );

    const conflict = this.recentReactions.find(
      (r) => Math.hypot(r.x - action.x, r.y - action.y) <= CONFLICT_RADIUS_PX
    );

    let conflictId: string;
    let conflictRank: number;

    if (conflict) {
      conflictId = conflict.conflictId;
      // Count how many entries already share this conflictId to compute rank.
      conflictRank = this.recentReactions.filter((r) => r.conflictId === conflictId).length;
    } else {
      conflictId = `${clientId}-${action.seq}-${now}`; // deterministic-enough unique id
      conflictRank = 0;
    }

    this.recentReactions.push({ x: action.x, y: action.y, serverTime: now, conflictId });
    if (this.recentReactions.length > RECENT_BUFFER_MAX) {
      this.recentReactions.shift(); // bounded — never grows unbounded
    }

    const enriched = conflictRank > 0 || conflict
      ? { ...action, conflictId, conflictRank }
      : action; // no conflict: broadcast unchanged, no extra fields

    this.broadcast(clientId, enriched);
  }

  private send(clientId: string, msg: ServerMessage): void {
    const c = this.clients.get(clientId);
    if (c && c.ws.readyState === c.ws.OPEN) {
      c.ws.send(JSON.stringify(msg));
    }
  }

  // Broadcast to everyone EXCEPT the sender (documented choice — no self-echo).
  private broadcast(senderId: string, msg: ServerMessage): void {
    const payload = JSON.stringify(msg);
    for (const [clientId, c] of this.clients) {
      if (clientId === senderId) continue;
      if (c.ws.readyState === c.ws.OPEN) {
        c.ws.send(payload);
      }
    }
  }

  size(): number {
    return this.clients.size;
  }
}