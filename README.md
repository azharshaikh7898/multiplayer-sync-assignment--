# Real-Time Multiplayer Cursor/State Sync

A raw-WebSocket, framework-free real-time sync engine: multiple browser
clients share a live cursor canvas with smooth interpolated movement and
tap-to-react emoji bursts. No Socket.IO, Yjs, PartyKit, or any other
real-time sync library — transport, protocol, and interpolation are all
hand-built.

**Live demo:** [PASTE YOUR CLIENT RENDER URL HERE]
**Server (WebSocket endpoint):** [PASTE YOUR SERVER RENDER URL HERE]
**Repository:** [PASTE YOUR GITHUB URL HERE]

---

## 1. Project Overview

This project implements a shared cursor/reaction canvas where every
connected client sees every other client's mouse position live, with
smooth interpolated motion (no teleporting), plus a tap-to-react emoji
action. The server is a minimal, honest relay — it validates, tracks
presence, and broadcasts; it does not own game logic beyond that.

Built for the "Real-Time Multiplayer Cursor/State Sync" take-home
assignment. Focus was on getting the core sync loop — protocol,
throttling, interpolation, and failure handling — genuinely correct
and smooth, rather than adding many action types.

---

## 2. Architecture

See `ARCHITECTURE.md` for the full breakdown. Summary of the file layout:

- `server/src/server.ts` — raw WebSocket connection lifecycle, heartbeat loop
- `server/src/roomManager.ts` — multi-room bookkeeping (creates/removes Room instances)
- `server/src/room.ts` — single room's presence, broadcast, ordering logic
- `server/src/protocol.ts` — message types + runtime validation (shared w/ client)
- `client/src/connection.ts` — WebSocket transport: connect, reconnect w/ backoff
- `client/src/interpolation.ts` — buffered linear interpolation per remote cursor
- `client/src/render.ts` — canvas drawing (cursors, reaction bursts, colors)
- `client/src/App.tsx` — React UI: wires transport, interpolation, and render together
- `client/src/protocol.ts` — copied from server (manually kept in sync)

Transport, protocol, and rendering are cleanly separated — a new action
type (e.g. a second reaction emoji, or a "typing" indicator) could be
added by extending `protocol.ts`'s message union and adding a `case` in
`App.tsx`'s message handler, without touching `connection.ts` at all.

---

## 3. Setup

### Requirements

- Node.js 22+
- npm

### Install

Server:

    cd server
    npm install

Client (separate terminal):

    cd client
    npm install

---

## 4. How to Run

**Terminal 1 — start the server:**

    cd server
    npm run dev

Should print: `WebSocket server listening on ws://localhost:8080`

**Terminal 2 — start the client:**

    cd client
    npm run dev

Opens on `http://localhost:5173`

**To test multi-client sync:** open `localhost:5173` in 3–5 separate
browser tabs. Move your mouse in one tab — cursors should appear and
move smoothly in the others. Click anywhere on the canvas to send a
🔥 reaction, visible to all other connected clients.

### Production build

    cd server && npm run build && npm start
    cd client && npm run build   # outputs to client/dist

---

## 5. Protocol Design

Every message is **self-describing** — it carries `clientId`, so
neither side has to infer "who sent this" purely from connection
context. Every `cursor`/`reaction` message also carries a monotonically
increasing per-client `seq` number, used for ordering (see §11).

## 6. Message Types

**Client → Server**

| type       | fields                                        | purpose                                |
|------------|------------------------------------------------|-----------------------------------------|
| `join`     | `clientId`, `roomId`                            | announce self, join a room             |
| `cursor`   | `clientId`, `seq`, `x`, `y`                     | continuous position update             |
| `reaction` | `clientId`, `seq`, `x`, `y`, `reaction`         | discrete tap/emoji event               |
| `leave`    | `clientId`                                      | explicit leave (in addition to close)  |

**Server → Client**

| type       | fields                                        | purpose                                |
|------------|------------------------------------------------|-----------------------------------------|
| `welcome`  | `clientId`, `participants[]`                    | new joiner's id + snapshot of room state |
| `presence` | `clientId`, `status` (`"join"` \| `"leave"`)    | someone joined/left                    |
| `cursor`   | `clientId`, `seq`, `x`, `y`                     | relayed cursor update                  |
| `reaction` | `clientId`, `seq`, `x`, `y`, `reaction`         | relayed reaction                       |

### Validation

All incoming messages are parsed through `parseClientMessage()` in
`protocol.ts`, which checks not just JS type correctness but sane value
ranges (coordinates bounded to ±100,000, reaction strings capped at
8 characters). Any message with an unknown `type`, missing/wrong-typed
fields, or out-of-range values is **silently dropped** — never crashes
the connection, never gets broadcast. This was verified manually via
`wscat`, sending malformed JSON, missing fields, and unknown message
types, confirming the server logs no crash and broadcasts nothing.

### New client joining mid-session

On `join`, the server immediately sends the new client a `welcome`
message containing a full snapshot of all currently-connected
participants' last known cursor positions (`Room.join()` in
`room.ts`). This was chosen over a replay-log approach for simplicity —
a new joiner sees where everyone currently is, not the history of how
they got there. Verified via manual multi-terminal `wscat` tests: a
third client joining after two others had already sent cursor updates
correctly received both peers' real (non-zero) positions in its
`welcome.participants`.

---

## 7. Throttling

Raw `mousemove` fires at 60–120Hz — sending every event would be
wasteful and unnecessary for a cursor sync use case. Instead:

- `handleMouseMove` only updates a locally-stored "latest position"
  ref — no network call.
- A separate `setInterval` timer, fixed at 25Hz (40ms), is the *only*
  place that actually sends a `cursor` message. It reads whatever the
  latest stored position is and sends it, **skipping the send
  entirely if the position hasn't changed** since the last tick.

This decouples "how fast the mouse physically moves" from "how often
we talk to the network," guaranteeing a hard-capped, predictable send
rate (max 25 msgs/sec per client) regardless of mouse activity, by
construction — `setInterval` cannot fire faster than its interval.

---

## 8. Interpolation Strategy

**Approach:** buffered linear interpolation ("entity interpolation" /
playout-delay buffer), the standard technique from multiplayer game
netcode.

Each incoming `cursor` update becomes the new `target` for that
client; the previous `target` becomes `prev`. On every animation
frame, we compute the render position for `now - 100ms`, linearly
interpolated between `prev` and `target` based on elapsed time.

**Why render slightly in the past:** rendering "live" the instant a
new update arrives means only one known point exists — the renderer
would have to guess (extrapolate) where the cursor is heading. By
deliberately rendering 100ms behind, we always have two *real,
confirmed* points to interpolate between, at the cost of a small fixed
visual lag.

**Tradeoff:**

- Higher delay → smoother motion under jitter/slow networks, more lag.
- Lower delay → feels more "live," more likely to show stutter under
  irregular update timing.
- 100ms was chosen as a middle ground — imperceptible as "lag" in
  casual use, enough buffer to absorb typical jitter.

**Verified:** tested under Chrome DevTools "Slow 3G"/"Slow 4G"
throttling on one tab while moving the mouse in another — remote
cursor motion remained visibly smooth and continuous (no
teleport/snap), with noticeably increased lag, as expected. Screen
recordings of this test were captured during development.

**Memory:** the interpolator only ever stores 2 points (`prev`,
`target`) per client — never a full position history — so memory
usage stays constant regardless of session length.

---

## 9. Disconnect Handling

**Normal close (tab closed deliberately):** the browser sends a clean
WebSocket close frame. The server's `ws.on("close")` handler removes
the client from its room and broadcasts `presence: leave` to everyone
else. Verified: closing one of several open tabs correctly removed its
cursor and dropped the online count within a couple seconds on the
remaining tabs.

**Network failure (no clean close frame):** detected via a heartbeat
loop. Every 15 seconds (`HEARTBEAT_INTERVAL_MS`), the server pings
every connected client and marks them `isAlive = false`; if a pong
hasn't been received by the *next* sweep, the connection is terminated
and treated as a leave. This bounds zombie-cursor lifetime to roughly
one heartbeat interval (worst case ~30s) even for connections that
never send a proper close frame. Verified by killing the server
process outright (simulating total network/server failure) — clients'
consoles correctly logged the connection closing.

**Important fix made during development:** the heartbeat sweep
originally iterated `roomId` once per *client* rather than once per
*room*, which caused `sweepDeadClients()` to run multiple times per
tick on the same room — the second call saw `isAlive` already `false`
from the first call (no time for a real pong) and force-disconnected
every client in the room every ~15 seconds. Fixed by deduping room IDs
into a `Set` before sweeping, so each room is swept exactly once per
tick regardless of client count.

---

## 10. Reconnection

`connection.ts`'s `createRoom()` auto-reconnects on unexpected close,
using exponential backoff (1s → 2s → 4s → ... capped at 10s), and
automatically re-sends `join` on reconnect. `room.ts`'s `join()`
guards against duplicate entries: if a `clientId` that's already
present rejoins (e.g. a reconnect racing with a stale connection not
yet cleaned up), the old socket is terminated and replaced rather than
creating a second entry.

**Note on identity across reconnect vs. refresh:** within a single tab
session, the client's `clientId` (generated once via `randomClientId()`
on page load, stored in a `useRef`) persists across automatic
reconnects — a dropped-and-recovered connection resumes as the "same"
participant. A full page **refresh**, however, generates a **new**
`clientId` (this is a fresh page load, not a resumed session) — the
old identity is left to be cleaned up by the normal close/heartbeat
path, and a new one joins fresh. This is an intentional simplification,
not a bug — see Known Limitations.

---

## 11. Ordering

Every `cursor` and `reaction` message carries a monotonically
increasing per-client `seq` number. Both sides independently guard
against out-of-order delivery:

- **Server** (`room.ts`): tracks the highest `seq` accepted per
  client; discards (does not broadcast, does not update stored
  position) any incoming update whose `seq` is not strictly greater
  than the last accepted one.
- **Client** (`interpolation.ts`): tracks the highest `seq` accepted
  per *remote* client; discards any incoming update that would
  regress a cursor to an older position.

This is defense-in-depth: WebSocket over TCP already guarantees
in-order delivery on a single connection, so out-of-order arrival is
rare in practice — but the check is cheap, correctness-preserving
regardless, and protects against future changes (e.g. message replay,
multiple transport paths) that could reorder messages.

---

## 12. Known Limitations

- **No persistence across server restart** — all room/presence state
  is in-memory only (a `Map` in `room.ts`). Restarting the server
  drops all rooms and requires every client to rejoin.
- **No horizontal scaling story implemented** — a single server
  process holds all room state; running multiple instances would
  require a shared broadcast layer (e.g. Redis pub/sub) to relay
  messages between instances. Not implemented, discussed here only.
- **No authentication** — any client can join any room with any
  self-declared `clientId`; per the assignment FAQ, this is
  explicitly out of scope.
- **Refresh = new identity** — a page refresh is treated as a brand
  new participant (new `clientId`), not a resumed session. Reconnects
  *within* a session (dropped connection, same tab) correctly persist
  identity; refreshes do not.
- **Client/server protocol types are manually duplicated**, not
  imported from a shared package — `client/src/protocol.ts` is a
  copied, not symlinked or shared, version of `server/src/protocol.ts`.
  Keeping them in sync is a manual step during development.
- **Deployed on Render's free tier**, which spins down after ~15 min
  of inactivity; first connection after idle may take 30–60s to wake.
- **Single reaction type** (🔥) implemented, per the assignment's own
  guidance not to over-build ("one is enough").
- Reconnect/duplicate-cursor testing was primarily verified through
  server-restart simulation (the most reliable way to simulate
  network failure for a localhost/same-machine setup, since OS-level
  WiFi toggling and Chrome DevTools' "Offline" mode do not reliably
  affect already-established WebSocket connections in this
  environment); a fully isolated recording of same-session
  auto-reconnect without any page refresh was attempted but not
  cleanly captured on video.

---

## 13. Time Spent

[FILL IN — e.g. "Approximately X hours across Y days, roughly broken
down as: server + protocol design (~X hrs), client transport +
interpolation (~X hrs), testing/debugging (~X hrs), UI polish (~X
hrs), deployment (~X hrs), documentation (~X hrs)."]

---

## 14. AI Tools Used

[FILL IN — be specific and honest, e.g.:]

Claude (Anthropic) was used throughout development as a pair-programming
and debugging assistant: drafting initial implementations of
`protocol.ts`, `room.ts`, `connection.ts`, and `interpolation.ts`
against my own architecture decisions; helping diagnose bugs during
testing (e.g. the heartbeat multi-sweep bug in §9, a React StrictMode
double-connection issue, and a Render deployment configuration issue);
and helping structure this README. All code was reviewed, tested
manually (multi-tab, network throttling, malformed message injection
via `wscat`, server-restart reconnect testing), and I can explain any
part of it.

---

## 15. Deployment URL

**Client:** [PASTE YOUR CLIENT RENDER URL HERE]
**Server (WebSocket):** [PASTE YOUR SERVER RENDER URL HERE]

Note: the server URL will show "426 Upgrade Required" if opened
directly in a browser — this is correct/expected, since it's a
WebSocket-only endpoint with no HTTP routes. Open the **client** URL
to use the app.

---

## 16. GitHub URL

[PASTE YOUR GITHUB REPO URL HERE]