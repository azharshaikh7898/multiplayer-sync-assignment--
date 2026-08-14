// protocol.ts — message types + runtime validation
// Design choice: every message is self-describing (carries clientId),
// so the client never has to trust "who sent this" from connection context alone.
const MAX_COORD = 100_000; // sanity bound, prevents garbage/NaN-adjacent abuse
const MAX_REACTION_LEN = 8; // emoji are short; block someone stuffing a novel in here
function isFiniteNumber(v) {
    return typeof v === "number" && Number.isFinite(v);
}
function isValidCoord(v) {
    return isFiniteNumber(v) && Math.abs(v) <= MAX_COORD;
}
export function parseClientMessage(raw) {
    if (typeof raw !== "object" || raw === null)
        return null;
    const m = raw;
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
        default:
            return null; // unknown type -> rejected
    }
}
//# sourceMappingURL=protocol.js.map