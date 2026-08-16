# Real-Time Multiplayer Cursor/State Sync

A raw-WebSocket, framework-free real-time sync engine: multiple browser
clients share a live cursor canvas with smooth interpolated (and
extrapolated) movement and tap-to-react emoji bursts. No Socket.IO
Yjs, PartyKit, or any other real-time sync library, transport
protocol, and interpolation are all hand-built.

**Live demo:** https://multiplayer-sync-assignment-1.onrender.com/
**Server (WebSocket endpoint):** https://multiplayer-sync-assignment.onrender.com/
**Repository:** https://github.com/azharshaikh7898/multiplayer-sync-assignment--

---

## TL;DR

- Raw WebSocket sync engine, no libraries, custom protocol, server, client
- Live shared cursor canvas + tap-to-react emoji, tested with up to 5
  tabs and 3 real devices
- Buffered interpolation + velocity-based extrapolation for smooth
  remote cursor movement, verified under throttled networks
- Disconnect/reconnect handling, ordering via sequence numbers, full
  message validation
- All 5 optional bonus features implemented: extrapolation, adaptive
  throttling by measured RTT, simultaneous-reaction reconciliation
  live latency/jitter display, horizontal-scaling writeup
- Deployed live on Render (server + client); see links above
- Full breakdown below, protocol, throttling, interpolation
  tradeoffs, failure handling, and known limitations are all
  documented in detail

---

## 1. Project Overview

This project implements a shared cursor/reaction canvas where every
connected client sees every other client's mouse position live, with
smooth interpolated/extrapolated motion (no teleporting), plus a
tap-to-react emoji action. The server is a minimal, honest relay, it
validates, tracks presence, and broadcasts; it does not own game logic
beyond that.

Built for the "Real-Time Multiplayer Cursor/State Sync" take-home
assignment. Beyond the core requirements, all five optional bonus
items were implemented: extrapolation, RTT-based adaptive throttling
simultaneous-action reconciliation, live per-client latency/jitter
display, and a written horizontal-scaling discussion.

---

## 2. Architecture

See `ARCHITECTURE.md` for the full breakdown. Summary of the file layout:

- `server/src/server.ts`: raw WebSocket connection lifecycle, heartbeat loop, ping/pong reply
- `server/src/roomManager.ts`: multi-room bookkeeping (creates/removes Room instances)
- `server/src/room.ts`: presence, broadcast, ordering, and conflict-reconciliation logic
- `server/src/protocol.ts`: message types + runtime validation (shared w/ client)
- `client/src/connection.ts`: WebSocket transport: connect, reconnect w/ backoff, RTT/jitter measurement
- `client/src/interpolation.ts`: buffered linear interpolation + velocity-based extrapolation per remote cursor
- `client/src/render.ts`: canvas drawing (cursors, reaction bursts, colors, conflict offsets)
- `client/src/App.tsx`: React UI: wires transport, interpolation, render, and adaptive send-rate together
- `client/src/protocol.ts`: copied from server (manually kept in sync)

Transport, protocol, and rendering are cleanly separated, a new action
type could be added by extending `protocol.ts`'s message union and
adding a `case` in `App.tsx`'s message handler, without touching
`connection.ts` at all.

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

**Terminal 1, start the server:**

    cd server
    npm run dev

Should print: `WebSocket server listening on ws://localhost:8080`

**Terminal 2, start the client:**

    cd client
    npm run dev

Opens on `http://localhost:5173`

**To test multi-client sync:** open `localhost:5173` in 3–5 separate
browser tabs. Move your mouse in one tab, cursors should appear and
move smoothly in the others. Click anywhere on the canvas to send a
🔥 reaction, visible to all other connected clients. Each user's row
in the "Users" list shows their live round-trip latency and jitter.

### Production build

    cd server && npm run build && npm start
    cd client && npm run build   # outputs to client/dist

---

## 5. Protocol Design

Every message is **self-describing**, it carries `clientId`, so
neither side has to infer "who sent this" purely from connection
context. Every `cursor`/`reaction` message also carries a monotonically
increasing per-client `seq` number, used for ordering (see §11).

## 6. Message Types

**Client → Server**

| type       | fields                                                    | purpose                                |
|------------|-------------------------------------------------------------|------------------------------------------|
| `join`     | `clientId`, `roomId`                                        | announce self, join a room             |
| `cursor`   | `clientId`, `seq`, `x`, `y`                                  | continuous position update             |
| `reaction` | `clientId`, `seq`, `x`, `y`, `reaction`                      | discrete tap/emoji event               |
| `leave`    | `clientId`                                                   | explicit leave (in addition to close)  |
| `ping`     | `clientId`, `sentAt`                                         | latency probe                          |
| `latency`  | `clientId`, `rtt`, `jitter`                                  | self-reported RTT/jitter, for others   |

**Server → Client**

| type       | fields                                                                                   | purpose                                |
|------------|-----------------------------------------------------------------------------------------|-------------------------------------------|
| `welcome`  | `clientId`, `participants[]`                                                             | new joiner's id + snapshot of room state |
| `presence` | `clientId`, `status` (`"join"` \| `"leave"`)                                             | someone joined/left                    |
| `cursor`   | `clientId`, `seq`, `x`, `y`                                                              | relayed cursor update                  |
| `reaction` | `clientId`, `seq`, `x`, `y`, `reaction`, `conflictId?`, `conflictRank?`                  | relayed reaction, tagged if it conflicted with another |
| `pong`     | `sentAt`                                                                                 | reply to `ping`, echoes original timestamp |
| `latency`  | `clientId`, `rtt`, `jitter`                                                              | relayed latency info for display        |

### Validation

All incoming messages are parsed through `parseClientMessage()` in
`protocol.ts`, which checks not just JS type correctness but sane value
ranges (coordinates bounded to ±100,000, reaction strings capped at
8 characters). Any message with an unknown `type`, missing/wrong-typed
fields, or out-of-range values is **silently dropped**, never crashes
the connection, never gets broadcast. Verified manually via `wscat`
sending malformed JSON, missing fields, and unknown message types.

### New client joining mid-session

On `join`, the server immediately sends the new client a `welcome`
message containing a full snapshot of all currently-connected
participants' last known cursor positions (`Room.join()` in
`room.ts`). Chosen over a replay-log approach for simplicity, a new
joiner sees where everyone currently is, not the history of how they
got there. Verified via manual multi-terminal `wscat` tests.

---

## 7. Throttling

Raw `mousemove` fires at 60–120Hz, sending every event would be
wasteful. `handleMouseMove` only updates a locally-stored "latest
position" ref, no network call. A separate timer is the *only* place
that actually sends a `cursor` message, and it **skips the send
entirely if the position hasn't changed** since the last tick.

### Adaptive rate (bonus)

The send interval is not fixed, it adapts to measured round-trip
latency. Every 3 seconds, the client sends a `ping` (server replies
immediately with `pong`, echoing the timestamp) to measure RTT:

    RTT < 100ms   -> 25Hz  (40ms interval)
    RTT 100-300ms -> 15Hz  (67ms interval)
    RTT > 300ms   -> 8Hz   (125ms interval)

A watcher re-evaluates the target interval once per second and only
tears down/rebuilds the send timer if it actually changed, avoiding
needless timer churn. This avoids flooding a slow connection with
updates it can't usefully deliver in time, while staying maximally
responsive on a fast one. The measured RTT is also broadcast to other
clients (via a `latency` message) and displayed live in the UI (§13
Users list), verified visually by watching the displayed number
climb under Chrome DevTools "Slow 3G" throttling.

---

## 8. Interpolation & Extrapolation Strategy

**Interpolation approach:** buffered linear interpolation ("entity
interpolation" / playout-delay buffer), the standard technique from
multiplayer game netcode. Each incoming `cursor` update becomes the
new `target`; the previous `target` becomes `prev`. On every animation
frame, we compute the render position for `now - 100ms`, linearly
interpolated between `prev` and `target`.

**Why render slightly in the past:** rendering "live" the instant a
new update arrives means only one known point exists, the renderer
would have to guess where the cursor is heading. Rendering 100ms
behind guarantees two *real, confirmed* points to interpolate between
at the cost of a small fixed visual lag.

**Extrapolation (bonus):** when no fresh update has arrived by the
time a frame needs to render (i.e., the render time has passed the
last known `target`), the interpolator falls back to extrapolating
forward from the last known point using its velocity (computed from
the two most recent real positions: `(target - prev) / (targetT -
prevT)`). This is capped at **250ms** to prevent unbounded drift
during long gaps, after that, the cursor freezes rather than
continuing to guess indefinitely. The moment a real update arrives
`updateTarget()` unconditionally resets `prev`/`target`, so the next
frame automatically falls back to normal interpolation, no special
"reset" logic needed.

**Tradeoff:**
- Higher interpolation delay / extrapolation cap gives smoother motion
  under jitter/slow networks, at the cost of more lag or more risk of
  a visible correction when a real update finally disagrees with the
  guess.
- Lower values feel more "live," but are more likely to show stutter.
- 100ms interpolation delay / 250ms extrapolation cap were chosen as
  a middle ground.

**Verified:** tested under Chrome DevTools "Slow 3G"/"Slow 4G"
throttling, remote cursor motion remained visibly smooth and
continuous (no teleport/snap) both with and without a fresh update
arriving in time, with the expected small correction on resync.

**Memory:** the interpolator stores only 2 points + a velocity vector
per client, never a full position history, so memory usage stays
constant regardless of session length.

---

## 9. Disconnect Handling

**Normal close:** browser sends a clean WebSocket close frame; the
server's `ws.on("close")` handler removes the client and broadcasts
`presence: leave`. Verified: closing one of several open tabs
correctly removed its cursor and dropped the online count within a
couple seconds on the remaining tabs.

**Network failure:** detected via a heartbeat loop. Every 15 seconds
the server pings every connected client and marks them `isAlive =
false`; if no pong by the next sweep, the connection is terminated and
treated as a leave. Bounds zombie-cursor lifetime to roughly one
heartbeat interval (worst case ~30s). Verified by killing the server
process outright.

**Bug found and fixed during development:** the heartbeat sweep
originally iterated `roomId` once per *client* rather than once per
*room*, causing `sweepDeadClients()` to run multiple times per tick on
the same room, the second call saw `isAlive` already `false` from the
first call (no time for a real pong) and force-disconnected every
client in the room every ~15 seconds. Fixed by deduping room IDs into
a `Set` before sweeping.

---

## 10. Reconnection

`connection.ts`'s `createRoom()` auto-reconnects on unexpected close
using exponential backoff (1s -> 2s -> 4s -> ... capped at 10s), and
automatically re-sends `join` on reconnect. `room.ts`'s `join()`
guards against duplicate entries: if a `clientId` that's already
present rejoins, the old socket is terminated and replaced rather than
creating a second entry.

**Note on identity across reconnect vs. refresh:** within a single tab
session, `clientId` persists across automatic reconnects. A full page
**refresh** generates a **new** `clientId` (a fresh page load, not a
resumed session), the old identity is cleaned up by the normal
close/heartbeat path, and a new one joins fresh. Intentional, not a
bug, see Known Limitations.

---

## 11. Ordering

Every `cursor` and `reaction` message carries a monotonically
increasing per-client `seq` number. Both sides independently guard
against out-of-order delivery:

- **Server** (`room.ts`): tracks the highest `seq` accepted per
  client; discards any incoming update whose `seq` is not strictly
  greater than the last accepted one.
- **Client** (`interpolation.ts`): mirrors the same check for
  *remote* clients, so a reordered older update can never regress a
  cursor to a stale position even if it somehow arrived late.

Defense-in-depth: WebSocket over TCP already guarantees in-order
delivery on a single connection, so this is rarely triggered in
practice, but protects against future changes (multiple transports
message replay) that could reorder messages.

---

## 12. Simultaneous Action Reconciliation (Bonus)

Two reactions are considered **conflicting** if they land within
**50px** of each other and arrive at the server within **300ms** of
one another, measured by server-side arrival time (not client-reported
timestamps, which can't be trusted or synced across clients). Since
the server processes incoming messages strictly sequentially (Node's
single-threaded event loop), it deterministically assigns each
conflicting reaction a `conflictId` (shared across the group) and a
`conflictRank` (0, 1, 2... by arrival order). Every client receives
the same tags for the same reaction, so every client renders the
identical resulting visual (bursts are offset and slightly enlarged
based on rank) rather than each client guessing independently.
Non-conflicting reactions are broadcast unchanged.

A small bounded buffer (`RECENT_BUFFER_MAX = 20`) of recent reactions
is kept for conflict-window comparison, pruned by age on every check
so memory use stays bounded.

*Verification note:* the detection/tagging logic was implemented and
reasoned through carefully (deterministic server-side ordering
consistent broadcast to all clients), and exercised via direct
`wscat` message injection at identical coordinates. A fully clean
visually-recorded proof of two near-simultaneous real browser clicks
triggering the offset rendering was attempted several times but not
cleanly captured, see Known Limitations.

---

## 13. Latency/Jitter Visualization (Bonus)

Every 3 seconds, each client measures its own RTT via `ping`/`pong`
and computes jitter as the mean absolute deviation of its last 5 RTT
samples. This is broadcast to the room via a `latency` message and
displayed live next to each name in the "Users" list, e.g.:

    - alice (you)   12ms +-4ms
    - bob           45ms +-7ms

The sender also updates its own UI immediately upon receiving its own
`pong`, rather than waiting for the server to broadcast its own
latency back (which never happens, by design, the server doesn't
echo to sender). Verified live: values update continuously and
visibly increase when Chrome DevTools throttling is applied to a tab.

---

## 14. Known Limitations

- **No persistence across server restart**, all room/presence state
  is in-memory only. Restarting the server drops all rooms.
- **No horizontal scaling story implemented** (bonus discussion
  written only), a single server process holds all room state;
  running multiple instances would require a shared broadcast layer
  (e.g. Redis pub/sub) so a message received by instance A can be
  relayed to clients connected to instance B. Room membership would
  also need to either be sticky-routed to one instance per room, or
  presence state would need to move into the shared layer too, not
  implemented, discussed here only.
- **No authentication**, any client can join any room with any
  self-declared `clientId`; explicitly out of scope per the
  assignment FAQ.
- **Refresh = new identity**, a page refresh creates a new
  `clientId`, not a resumed session. Reconnects *within* a session
  correctly persist identity; refreshes do not.
- **Client/server protocol types are manually duplicated**, not
  imported from a shared package, a manual sync step during
  development, not automated.
- **Deployed on Render's free tier**, which spins down after ~15 min
  of inactivity; first connection after idle may take 30-60s.
- **Single reaction type** (fire emoji) implemented, per the
  assignment's own guidance not to over-build.
- **Reconnect/duplicate-cursor testing** was primarily verified
  through server-restart simulation, since OS-level WiFi toggling and
  Chrome DevTools' "Offline" mode do not reliably affect
  already-established WebSocket connections in this environment; a
  fully isolated recording of same-session auto-reconnect without any
  page refresh was attempted but not cleanly captured.
- **Reconciliation visual proof** (see section 12), logic implemented
  and reasoned through, but a clean recorded demonstration of the
  offset-rendering behavior under a real simultaneous multi-tab click
  was not obtained despite several attempts; verified instead via
  direct protocol-level message injection.

---

## 15. Time Spent

Approximately 14-16 hours total, spread across 3 days:

- Project setup, server (protocol, room, room manager, heartbeat): ~2 hrs
- Client transport, interpolation, throttled cursor sync, first working
  multi-tab demo: ~2.5 hrs
- Debugging round (React StrictMode double-connect, a heartbeat
  multi-sweep bug causing forced disconnects every ~15s, a layout
  overflow bug in the presence UI): ~2 hrs
- Reactions, presence UI, ordering/sequence numbers: ~1.5 hrs
- Disconnect/reconnect handling + testing (server-restart simulation
  multi-tab, multi-device): ~1.5 hrs
- Deployment to Render (server + client, environment-aware WebSocket
  URL, PORT config, debugging a stale-build issue): ~1.5 hrs
- CI pipeline (GitHub Actions, type-check + build): ~0.5 hrs
- Bonus features, extrapolation, RTT-based adaptive throttling
  simultaneous-action reconciliation, live latency/jitter UI: ~3.5 hrs
- Documentation (README, ARCHITECTURE): ~1.5 hrs

*(Note: actual clock time was somewhat longer than active working
time, since testing steps, especially network-throttling and
multi-client timing tests, often required several attempts to get a
clean, reproducible result.)*

---

## 16. AI Tools Used

I used Claude (Anthropic) throughout this project, mainly as a coding
partner I could talk through decisions with and lean on when I got
stuck.

For the core pieces (`protocol.ts`, `room.ts`, `connection.ts`,
`interpolation.ts`), I'd describe what I wanted and Claude would draft
an implementation, which I'd then read through, test, and adjust. Same
approach for the bonus features later on (extrapolation, the
adaptive-throttling RTT logic, the conflict-reconciliation stuff, and
the latency/jitter display).

It was also genuinely useful for debugging. A few examples: the
heartbeat bug where the server was disconnecting everyone every ~15
seconds turned out to be because I was sweeping the same room multiple
times per tick instead of once. It took a bit of back-and-forth to
actually spot that. There was also a weird double-connection issue
from React StrictMode in dev mode, and later some annoyance getting
the Render deployment working (a stale build that still pointed at
localhost after I'd already "fixed" it, which turned out to just be a
forgotten git push).

Testing the trickier stuff, like network throttling, disconnect and
reconnect behavior, and the conflict-reconciliation timing, took
several attempts to actually capture cleanly. Some of it (like a fully
clean recording of two simultaneous reactions triggering the
offset-rendering behavior) I never quite nailed on video, even though
I'm confident the logic itself is correct after going through it
carefully. I've noted that honestly in the limitations section rather
than overstating what I proved.

I also used it to help structure this README and the ARCHITECTURE
doc, though the actual decisions about what limitations to disclose,
what to prioritize, and how much time to spend on each bonus feature
were mine.

Everything in this repo I've read, tested myself, and can explain.
Nothing here is code I don't understand.

---

## 17. Deployment URL

**Client:** https://multiplayer-sync-assignment-1.onrender.com/
**Server (WebSocket):** https://multiplayer-sync-assignment.onrender.com/

Note: the server URL will show "426 Upgrade Required" if opened
directly in a browser, this is correct/expected, since it's a
WebSocket-only endpoint with no HTTP routes. Open the **client** URL
to use the app.

---

## 18. GitHub URL

https://github.com/azharshaikh7898/multiplayer-sync-assignment--
