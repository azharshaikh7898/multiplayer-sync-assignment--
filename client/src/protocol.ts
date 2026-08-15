// protocol.ts — message types + runtime validation
// Design choice: every message is self-describing (carries clientId),
// so the client never has to trust "who sent this" from connection context alone.

export type ClientMessage =
  | { type: "join"; clientId: string; roomId: string }
  | { type: "cursor"; clientId: string; seq: number; x: number; y: number }
  | { type: "reaction"; clientId: string; seq: number; x: number; y: number; reaction: string }
  | { type: "leave"; clientId: string }
  | { type: "ping"; clientId: string; sentAt: number }
  | { type: "latency"; clientId: string; rtt: number; jitter: number };

export type ServerMessage =
  | { type: "welcome"; clientId: string; participants: Presence[] }
  | { type: "presence"; clientId: string; status: "join" | "leave" }
  | { type: "cursor"; clientId: string; seq: number; x: number; y: number }
  | {
      type: "reaction";
      clientId: string;
      seq: number;
      x: number;
      y: number;
      reaction: string;
      conflictId?: string;   // present only if this reaction conflicted with another
      conflictRank?: number; // 0 = first to arrive, 1 = second, etc.
    }
  | { type: "pong"; sentAt: number }
  | { type: "latency"; clientId: string; rtt: number; jitter: number };

export interface Presence {
  clientId: string;
  x: number;
  y: number;
}

const MAX_COORD = 100_000; // sanity bound, prevents garbage/NaN-adjacent abuse
const MAX_REACTION_LEN = 8; // emoji are short; block someone stuffing a novel in here

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isValidCoord(v: unknown): v is number {
  return isFiniteNumber(v) && Math.abs(v) <= MAX_COORD;
}

export function parseClientMessage(raw: unknown): ClientMessage | null {
  if (typeof raw !== "object" || raw === null) return null;
  const m = raw as Record<string, unknown>;

  if (typeof m.type !== "string" || typeof m.clientId !== "string" || m.clientId.length === 0) {
    return null;
  }

  switch (m.type) {
    case "join":
      return typeof m.roomId === "string" && m.roomId.length > 0
        ? { type: "join", clientId: m.clientId, roomId: m.roomId }
        : null;

    case "cursor":
      return isFiniteNumber(m.seq) && isValidCoord(m.x) && isValidCoord(m.y)
        ? { type: "cursor", clientId: m.clientId, seq: m.seq, x: m.x, y: m.y }
        : null;

    case "reaction":
      return isFiniteNumber(m.seq) &&
        isValidCoord(m.x) &&
        isValidCoord(m.y) &&
        typeof m.reaction === "string" &&
        m.reaction.length > 0 &&
        m.reaction.length <= MAX_REACTION_LEN
        ? { type: "reaction", clientId: m.clientId, seq: m.seq, x: m.x, y: m.y, reaction: m.reaction }
        : null;

    case "leave":
      return { type: "leave", clientId: m.clientId };

    case "ping":
      return isFiniteNumber(m.sentAt)
        ? { type: "ping", clientId: m.clientId, sentAt: m.sentAt }
        : null;

    case "latency":
      return isFiniteNumber(m.rtt) && isFiniteNumber(m.jitter)
        ? { type: "latency", clientId: m.clientId, rtt: m.rtt, jitter: m.jitter }
        : null;

    default:
      return null; // unknown type -> rejected
  }
}